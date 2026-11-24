// 打分。三个轴 + 激活度 + 双衰减。
// 注意：retain 里没有 rel（查询相关度）。否则"常聊的话题"会被永久固化，
// 她就会变成一个只记得最近聊过什么的人。

import { agingDays, decayHalfLife, DAY_MS } from './time.js';

/** ACT-R 近似的激活度：近期出现得多 → 高。 */
export function actNorm(hits, now, tauDays = 21) {
  if (!Array.isArray(hits) || hits.length === 0) return 0;
  let sum = 0;
  for (const t of hits) {
    sum += Math.exp(-Math.max(0, now - t) / DAY_MS / tauDays);
  }
  return sum / (1 + sum);
}

export function computeRetain(ev, now, cfg) {
  const age = agingDays(ev.ts, now);
  const affectSlow = decayHalfLife(ev.score.affect, age, cfg.decay.affectHalfLifeDays);
  const utilitySlow = decayHalfLife(ev.score.utility, age, cfg.decay.utilityHalfLifeDays);
  const act = actNorm(ev.hits, now, cfg.decay.actTauDays);
  const w = cfg.weights;
  // "平静但重要"的加权：情绪不高、但身份/信息价值高的日常，不该被高情绪事件挤掉。
  const quiet = ev.score.identity >= 0.7 && ev.score.affect <= 0.3 ? w.quietBoost || 0 : 0;
  const retain =
    w.identity * ev.score.identity +
    w.affect * affectSlow +
    w.utility * utilitySlow +
    w.act * act +
    quiet;
  return {
    retain: clamp01(retain),
    parts: { identity: ev.score.identity, affectSlow, utilitySlow, act, quiet },
  };
}

export function computeRetrieve(ev, now, rel, cfg) {
  const age = agingDays(ev.ts, now);
  const utilitySlow = decayHalfLife(ev.score.utility, age, cfg.decay.utilityHalfLifeDays);
  const act = actNorm(ev.hits, now, cfg.decay.actTauDays);
  const w = cfg.retrieveWeights;
  const s =
    w.rel * clamp01(rel) + w.identity * ev.score.identity + w.utility * utilitySlow + w.act * act;
  return clamp01(s);
}

/** 淘汰分：权重 + 唯一性。防止"唯一一次提到的事"被 20 条相似日常挤掉。 */
export function computeEvictScore(ev, allEvents, cfg) {
  const uniq = uniqueness(ev, allEvents);
  return 0.6 * (ev.retain ?? 0) + 0.4 * uniq;
}

/** 1 - 与最近邻的相似度。用实体 Jaccard + 摘要 2-gram 的粗近似，不用 embedding。 */
export function uniqueness(ev, allEvents, sample = 40) {
  const others = allEvents
    .filter((o) => o.id !== ev.id && o.status === 'active')
    .slice(0, sample);
  if (others.length === 0) return 1;
  let maxSim = 0;
  for (const o of others) {
    const s = similarity(ev, o);
    if (s > maxSim) maxSim = s;
  }
  return clamp01(1 - maxSim);
}

export function similarity(a, b) {
  const ea = new Set(a.entities || []);
  const eb = new Set(b.entities || []);
  let inter = 0;
  for (const x of ea) if (eb.has(x)) inter += 1;
  const union = ea.size + eb.size - inter;
  const ent = union === 0 ? 0 : inter / union;

  const ga = bigrams(a.summary || '');
  const gb = bigrams(b.summary || '');
  let gi = 0;
  for (const g of ga) if (gb.has(g)) gi += 1;
  const gu = ga.size + gb.size - gi;
  const txt = gu === 0 ? 0 : gi / gu;

  return 0.5 * ent + 0.5 * txt;
}

function bigrams(s) {
  const clean = String(s).replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
