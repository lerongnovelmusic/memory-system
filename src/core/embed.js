// 向量化。两种提供者：
//   local  —— 字符 n-gram 哈希向量，零依赖、确定性、同步，能兜住"字面不重叠"的部分改写
//   openai —— 任何 OpenAI 兼容的 /v1/embeddings（OpenAI / 智谱 / 本地 Ollama / vLLM）
//
// 本地向量不是"语义向量"，它只是把字面相似度做得比 bigram 精确匹配更平滑：
// 共享单字也能贡献一点分数。真要语义请配 openai provider。

export const DEFAULT_DIM = 384;

export function hashEmbed(text, dim = DEFAULT_DIM) {
  const v = new Float32Array(dim);
  const s = String(text || '').toLowerCase();

  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) addTerm(v, m[0], 1.6, dim);
  for (const m of s.matchAll(/[a-z0-9]/g)) addTerm(v, m[0], 0.3, dim);

  for (const m of s.matchAll(/[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+/g)) {
    const run = m[0];
    for (let i = 0; i < run.length; i += 1) {
      addTerm(v, run[i], 0.5, dim); // 单字：抗改写
      if (i + 1 < run.length) addTerm(v, run.slice(i, i + 2), 1.0, dim); // 双字：主信号
      if (i + 2 < run.length) addTerm(v, run.slice(i, i + 3), 1.3, dim); // 三字：更具体
    }
  }

  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i += 1) v[i] /= norm;
  return v;
}

function addTerm(v, term, weight, dim) {
  let h = 2166136261;
  for (let i = 0; i < term.length; i += 1) {
    h ^= term.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = (h >>> 0) % dim;
  const sign = (h >>> 31) & 1 ? -1 : 1;
  v[idx] += sign * weight;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createLocalEmbedder({ dim = DEFAULT_DIM } = {}) {
  return {
    name: 'local',
    dim,
    async embedBatch(texts) {
      return texts.map((t) => hashEmbed(t, dim));
    },
  };
}

export function createOpenAIEmbedder({ apiKey, baseUrl = 'https://api.openai.com', model = 'text-embedding-3-small', dim = DEFAULT_DIM } = {}) {
  return {
    name: `openai:${model}`,
    dim,
    async embedBatch(texts) {
      if (!texts.length) return [];
      const out = [];
      for (let i = 0; i < texts.length; i += 64) {
        const chunk = texts.slice(i, i + 64);
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input: chunk }),
        });
        if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        for (const item of data.data) out.push(Float32Array.from(item.embedding));
      }
      return out;
    },
  };
}

export function createEmbedder(cfg = {}) {
  const e = cfg.embedding || {};
  if (e.provider === 'openai' && (e.apiKey || process.env.OPENAI_API_KEY)) {
    return createOpenAIEmbedder({
      apiKey: e.apiKey || process.env.OPENAI_API_KEY,
      baseUrl: e.baseUrl || 'https://api.openai.com',
      model: e.model || 'text-embedding-3-small',
      dim: e.dim || 1536,
    });
  }
  return createLocalEmbedder({ dim: e.dim || DEFAULT_DIM });
}

/** 向量化用的文本：摘要 + 实体，不带时间。 */
export function embeddingText(ev) {
  return `${ev.summary || ''} ${(ev.entities || []).join(' ')}`.trim();
}

export function contentHash(ev) {
  const s = embeddingText(ev);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
