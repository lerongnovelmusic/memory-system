// 回忆：混合检索（词法 BM25-lite ⊕ 向量 ⊕ 实体），RRF 排序，双闸门注入。
//
// 词法负责硬信息（专名、数字、"城东""11 月 8 号"），向量负责模糊相似
// （语序变化、近义字词）。单用任一路都会漏，两路一起用各补各的洞。
//
// 相关度用"可解释的绝对量"而不是"榜内归一化"：
//   nLex = 命中的查询词占比       —— 与语料大小无关
//   nVec = 余弦相似度线性映射      —— 与语料大小无关
//   rel  = 1 - (1-nLex)(1-nVec)
// 榜内归一化会让"随便什么查询的第一名"都等于 1.0，等于没有闸门。

import { computeRetrieve } from './score.js';
import { estimateTokens } from './token.js';
import { cosine, hashEmbed } from './embed.js';
import { fmtDate } from './time.js';

const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;
const LATIN = /[A-Za-z][A-Za-z0-9_-]+/g;
const RRF_K = 60;

export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const m of s.matchAll(LATIN)) out.push(m[0]);
  for (const m of s.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

export class MemoryIndex {
  constructor() {
    this.postings = new Map();
    this.lengths = new Map();
    this.count = 0;
  }

  add(ev) {
    const terms = tokenize(`${ev.summary} ${ev.quote || ''} ${(ev.entities || []).join(' ')}`);
    for (const t of terms) {
      if (!this.postings.has(t)) this.postings.set(t, new Map());
      const p = this.postings.get(t);
      p.set(ev.id, (p.get(ev.id) || 0) + 1);
    }
    this.lengths.set(ev.id, terms.length || 1);
    this.count += 1;
  }

  static from(events) {
    const idx = new MemoryIndex();
    for (const ev of events) if (ev.status === 'active') idx.add(ev);
    return idx;
  }

  search(query, { limit = 40 } = {}) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const scores = new Map();
    const matched = new Map();
    const avgLen =
      [...this.lengths.values()].reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.size);
    for (const term of terms) {
      const p = this.postings.get(term);
      if (!p) continue;
      const df = p.size;
      const idf = Math.log(1 + (this.count - df + 0.5) / (df + 0.5));
      for (const [id, tf] of p) {
        const len = this.lengths.get(id) || 1;
        const norm = tf / (tf + 1.2 * (1 - 0.75 + (0.75 * len) / avgLen));
        scores.set(id, (scores.get(id) || 0) + idf * norm);
        matched.set(id, (matched.get(id) || 0) + 1);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, raw]) => ({ id, raw, coverage: (matched.get(id) || 0) / terms.length, total: terms.length }));
  }
}

/** 向量榜：余弦相似度排序，低于阈值的直接不进榜。 */
export function vectorSearch(queryVec, vectors, { limit = 40, minCosine = 0.08 } = {}) {
  if (!queryVec || !vectors?.size) return [];
  const out = [];
  for (const [id, rec] of vectors) {
    const c = cosine(queryVec, rec.v);
    if (c >= minCosine) out.push({ id, raw: c });
  }
  return out.sort((a, b) => b.raw - a.raw).slice(0, limit);
}

/** RRF 只用来排序，不参与相关度计算。 */
export function fuse(lists) {
  const acc = new Map();
  for (const { name, items } of lists) {
    items.forEach((item, rank) => {
      if (!acc.has(item.id)) acc.set(item.id, { id: item.id, raw: 0, via: new Set(), lex: 0, vec: 0 });
      const rec = acc.get(item.id);
      rec.raw += 1 / (RRF_K + rank + 1);
      rec.via.add(name);
      if (name === 'lex') rec.lex = item.coverage ?? 0;
      if (name === 'vec') rec.vec = item.raw;
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.raw - a.raw)
    .map((r) => ({ ...r, via: [...r.via] }));
}

/**
 * 检索并给出是否值得注入。
 */
export async function recall(events, query, cfg, opts = {}) {
  const now = opts.now ?? Date.now();
  const index = opts.index ?? MemoryIndex.from(events);
  const byId = new Map(events.map((e) => [e.id, e]));

  const lexical = index.search(query, { limit: 40 });

  let queryVec = opts.queryVec;
  if (!queryVec && opts.embedder) {
    const [v] = await opts.embedder.embedBatch([query]);
    queryVec = v;
  }
  const minCosine = opts.minCosine ?? 0.08;
  const vector = opts.vectors ? vectorSearch(queryVec, opts.vectors, { minCosine }) : [];

  const ranked = fuse([
    { name: 'lex', items: lexical },
    { name: 'vec', items: vector },
  ]);

  const qEntities = new Set();
  const qLower = String(query).toLowerCase();
  for (const ev of events) {
    for (const ent of ev.entities || []) {
      if (ent && qLower.includes(String(ent).toLowerCase())) qEntities.add(ent);
    }
  }

  const results = [];
  for (const item of ranked) {
    const ev = byId.get(item.id);
    if (!ev) continue;
    if (ev.status !== 'active' && !(opts.meta && (ev.status === 'superseded' || ev.status === 'disputed'))) continue;
    if (ev.status === 'tombstone') continue;

    const nVec = clamp((item.vec - minCosine) / (1 - minCosine));
    const relBase = 1 - (1 - item.lex) * (1 - nVec);
    const entityHit = (ev.entities || []).some((e) => qEntities.has(e)) ? (opts.entityBoost ?? 0.4) : 0;
    const rel = Math.min(1, relBase + entityHit);
    const score = computeRetrieve(ev, now, rel, cfg);
    results.push({ ev, rel, score, via: item.via });
  }

  // 双闸门：综合分过线，或检索相关度足够强。
  // 另外必须有一点检索信号 —— 否则"identity/utility 很高的契约事件"会对每个查询都注入。
  const minRel = opts.minRel ?? cfg.recall.minRel ?? 0.05;
  const qualified = results
    .filter((r) => r.rel >= minRel && (r.score >= cfg.recall.threshold || r.rel >= (opts.relGate ?? 0.5)))
    .sort((a, b) => b.score - a.score);

  const picked = [];
  let used = 0;
  for (const r of qualified) {
    if (picked.length >= cfg.recall.maxItems) break;
    const t = estimateTokens(r.ev.summary) + 20;
    if (used + t > cfg.recall.maxTokens) break;
    picked.push(r);
    used += t;
  }
  return { picked, considered: results.length, tokens: used, lexical: lexical.length, vector: vector.length };
}

/** 注入格式：带日期、带区间、带"可能记不清"的措辞。 */
export function renderRecall(picked, now = Date.now(), { maxAgeDaysForConfidence = 60 } = {}) {
  const lines = picked.map(({ ev, score }) => {
    const d = new Date(ev.ts);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ageDays = (now - ev.ts) / 86_400_000;
    const fuzzy = ageDays > maxAgeDaysForConfidence || score < 0.65 ? '（细节可能记不清）' : '';
    // 旧说法必须带区间，否则会被用现在时讲出来。
    const range = ev.validTo ? `，${fmtDate(ev.ts)}–${fmtDate(ev.validTo)}` : '';
    const tag = ev.status === 'superseded' ? `［旧说法${range}，已不成立］` : '';
    return `- [${date}] ${ev.summary}${ev.quote ? ` 你说过：“${ev.quote}”` : ''}${fuzzy}${tag}`;
  });
  return lines.join('\n');
}

function clamp(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export { hashEmbed };
