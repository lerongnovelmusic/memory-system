// 事件合并与向量去重。
//
// 两级，风险完全不同，所以分开做：
//   1. 去重（dedupe）：两条几乎一样的事件，确定性地并成一条，不改写摘要。
//   2. 合并（merge）：两条互补的碎片，需要判断"这是不是同一件事"——只有接了模型才做。
//
// 铁律：
//   - 只碰 cache2 / l4。core 是每轮注入的东西，动它等于改人格的连续性。
//   - 契约、里程碑、pin 过的、immortal 的，永远不并。
//   - 摘要代数 gen ≥ maxGen 就停止并，必须回到原文重写，否则会累积摘要漂移。
//   - 被并掉的事件不删除，标 status='merged' + mergedInto，保留溯源。

import { cosine, hashEmbed, embeddingText } from './embed.js';
import { estimateTokens } from './token.js';
import { rewriteSummary } from './events.js';

const DAY = 86_400_000;
export const MERGEABLE_TIERS = new Set(['cache2', 'l4']);
export const MERGEABLE_KINDS = new Set(['episode', 'promise', 'fact_change']);

export function pairSimilarity(a, b, va, vb) {
  const cos = va && vb ? cosine(va, vb) : 0;
  const ent = jaccard(a.entities, b.entities);
  const txt = jaccard(bigrams(a.summary), bigrams(b.summary));
  return { cos, ent, txt, combined: 0.55 * cos + 0.3 * ent + 0.15 * txt };
}

export function canMerge(a, b, cfg, now = Date.now()) {
  if (!a || !b || a.id === b.id) return false;
  if (a.status !== 'active' || b.status !== 'active') return false;
  if (a.tier !== b.tier) return false;
  if (!MERGEABLE_TIERS.has(a.tier)) return false;
  if (!MERGEABLE_KINDS.has(a.kind) || !MERGEABLE_KINDS.has(b.kind)) return false;
  if (a.immortal || b.immortal || a.safety || b.safety || a.pinned || b.pinned) return false;
  if (Math.abs((a.ts || 0) - (b.ts || 0)) > cfg.merge.windowDays * DAY) return false;
  if ((a.gen || 0) >= cfg.merge.maxGen || (b.gen || 0) >= cfg.merge.maxGen) return false;
  return true;
}

/**
 * 把 source 并进 target。target 原地更新，source 标记为 merged。
 * @param {string|null} newSummary 合并后的摘要（仅 merge 级）；null 表示去重，不改写
 */
export function absorb(target, source, newSummary, now = Date.now()) {
  const before = target.summary;
  target.sources = {
    turns: dedupe([...(target.sources?.turns || []), ...(source.sources?.turns || [])]),
    events: dedupe([...(target.sources?.events || []), source.id, ...(source.sources?.events || [])]),
  };
  target.hits = dedupe([...(target.hits || []), ...(source.hits || [])]);
  target.score = {
    identity: Math.max(target.score.identity, source.score.identity),
    affect: Math.max(target.score.affect, source.score.affect),
    utility: Math.max(target.score.utility, source.score.utility),
  };
  target.ts = Math.min(target.ts || now, source.ts || now);
  target.entities = dedupe([...(target.entities || []), ...(source.entities || [])]);
  if ((source.quote || '').length > (target.quote || '').length) target.quote = source.quote;
  if (newSummary && newSummary !== before) {
    const rewritten = rewriteSummary(target, newSummary, { at: now, reason: 'merge' });
    target.summary = rewritten.summary;
    target.gen = rewritten.gen;
    target.history = rewritten.history;
  }
  target.mergedCount = (target.mergedCount || 0) + 1 + (source.mergedCount || 0);
  target.tokens = 40 + estimateTokens(target.summary) + estimateTokens(target.quote || '');

  source.status = 'merged';
  source.mergedInto = target.id;
  source.mergedAt = now;
  return target;
}

/**
 * 一夜合并。纯函数 + 可选 llm.mergeEvents（异步）。
 */
export async function mergePass({ events, vectors = new Map(), cfg, now = Date.now(), llm = null }) {
  const m = cfg.merge || {};
  const log = [];
  if (m.enabled === false) return { events, log };

  const dim = cfg.embedding?.dim || 384;
  const isLocal = (cfg.embedding?.provider || 'local') === 'local';
  // 远端 provider 下，还没算过向量的新事件不临时用哈希向量硬凑——
  // 维度相同但语义完全不同，凑出来的余弦是噪声。宁可不并。
  const vectorOf = (ev) => vectors.get(ev.id)?.v || (isLocal ? hashEmbed(embeddingText(ev), dim) : null);

  const byId = new Map(events.map((e) => [e.id, e]));
  const entityIndex = new Map();
  const threadIndex = new Map();
  const pool = events.filter(
    (e) => e.status === 'active' && MERGEABLE_TIERS.has(e.tier) && MERGEABLE_KINDS.has(e.kind)
  );

  for (const e of pool) {
    for (const ent of e.entities || []) push(entityIndex, ent, e.id);
    if (e.threadId) push(threadIndex, e.threadId, e.id);
  }

  pool.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const absorbed = new Set();
  let count = 0;
  let checks = 0;

  for (const a of pool) {
    if (count >= (m.maxMergesPerNight || 10)) break;
    if (a.status !== 'active' || absorbed.has(a.id)) continue;
    if ((a.gen || 0) >= (m.maxGen || 3)) continue;

    const candidates = new Set();
    for (const ent of a.entities || []) for (const id of entityIndex.get(ent) || []) candidates.add(id);
    if (a.threadId) for (const id of threadIndex.get(a.threadId) || []) candidates.add(id);

    let best = null;
    let bestSim = 0;
    for (const id of candidates) {
      if (id === a.id || absorbed.has(id)) continue;
      const b = byId.get(id);
      if (!b || !canMerge(a, b, cfg, now)) continue;
      const sim = pairSimilarity(a, b, vectorOf(a), vectorOf(b));
      if (sim.combined > bestSim) {
        bestSim = sim.combined;
        best = b;
      }
    }
    if (!best) continue;

    if (bestSim >= (m.dedupeThreshold ?? 0.9)) {
      absorb(a, best, null, now);
      absorbed.add(best.id);
      log.push({ type: 'dedupe', keep: a.id, drop: best.id, sim: round(bestSim) });
      count += 1;
      continue;
    }

    if (bestSim >= (m.mergeThreshold ?? 0.45) && llm?.mergeEvents) {
      if (checks >= (m.maxChecksPerNight ?? 20)) continue;
      checks += 1;
      let out = null;
      try {
        out = await llm.mergeEvents(a, best);
      } catch {
        out = null;
      }
      const summary = String(out?.summary || '').trim();
      if (!summary || summary.length > (m.maxSummaryChars || 110)) continue;
      const genBefore = a.gen || 0;
      absorb(a, best, summary, now);
      absorbed.add(best.id);
      const rewritten = (a.gen || 0) > genBefore;
      log.push({ type: rewritten ? 'merge' : 'dedupe', keep: a.id, drop: best.id, sim: round(bestSim), gen: a.gen });
      count += 1;
    }
  }

  return { events, log };
}

function push(map, key, id) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(id);
}

function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function bigrams(s) {
  const clean = String(s || '').replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
