// 向量缓存。embeddings.jsonl 是派生数据，可以随时删掉重建。
//
// 两个必须防的坑：
//   1. 换 provider / 换维度后旧向量必须整体失效 —— 否则余弦在长度不等时返回 0，
//      不是报错，是静默退化成"没有向量"，你永远发现不了。
//   2. 只对内容变了的事件重算 —— 摘要被合并过的事件会自动失效。

import { embeddingText, contentHash } from './embed.js';

const META = 'embeddings.meta.json';

export function readMeta(store) {
  return store.readJson(META, null);
}

export function loadEmbeddings(store, embedder = null) {
  const meta = readMeta(store);
  if (embedder) {
    const same = meta && meta.provider === embedder.name && meta.dim === embedder.dim;
    if (!same) return new Map();
  } else if (!meta) {
    return new Map();
  }
  const rows = store.readJsonl('embeddings.jsonl');
  const map = new Map();
  for (const r of rows) {
    if (!r?.id || !Array.isArray(r.v)) continue;
    map.set(r.id, { hash: r.hash, v: Float32Array.from(r.v) });
  }
  return map;
}

export function saveEmbeddings(store, map, embedder) {
  const rows = [];
  for (const [id, { hash, v }] of map) {
    rows.push({ id, hash, v: Array.from(v, (x) => Math.round(x * 1e4) / 1e4) });
  }
  store.writeJsonl('embeddings.jsonl', rows);
  store.writeJson(META, {
    provider: embedder?.name || 'unknown',
    dim: embedder?.dim || 0,
    count: rows.length,
    updatedAt: Date.now(),
  });
}

/**
 * 补齐缺失/过期的向量。
 * @returns {{map: Map, added: number, reused: number}}
 */
export async function ensureEmbeddings({ store, events, embedder, now = Date.now() }) {
  const map = loadEmbeddings(store, embedder);
  const todo = [];
  const seen = new Set();

  for (const ev of events) {
    if (ev.status !== 'active') continue;
    seen.add(ev.id);
    const hash = contentHash(ev);
    const cached = map.get(ev.id);
    if (cached && cached.hash === hash) continue;
    todo.push({ ev, hash });
  }

  for (const id of map.keys()) if (!seen.has(id)) map.delete(id);

  if (todo.length) {
    const vectors = await embedder.embedBatch(todo.map((t) => embeddingText(t.ev)));
    todo.forEach((t, i) => map.set(t.ev.id, { hash: t.hash, v: vectors[i] }));
    saveEmbeddings(store, map, embedder);
  } else if (!readMeta(store)) {
    saveEmbeddings(store, map, embedder);
  }

  return { map, added: todo.length, reused: map.size - todo.length, now };
}

export function embeddingStats(store) {
  const meta = readMeta(store);
  const rows = store.readJsonl('embeddings.jsonl').length;
  return { meta, stored: rows };
}
