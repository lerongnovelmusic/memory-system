// 全部可调参数集中在这里。设计文档第 10 节。
// 原则：容量是唯一的规模控制量；分数只用于排序。

export const TIER_ORDER = ['core', 'warm', 'cache2', 'l4'];

export const DEFAULT_CONFIG = {
  tz: 'Europe/Berlin',
  dayCutoffHour: 4,

  // 各层 token 预算。core 里有一部分被人格/契约/印象占掉，事件只能用剩下的。
  budgets: {
    core: 2400,
    warm: 2600,
    cache2: 15000,
    l4: 90000,
  },
  fixedOverhead: {
    core: 1300, // persona 600 + rules 250 + keeper 450
    warm: 0,
    cache2: 0,
    l4: 0,
  },

  // retain = w·[identity, affect_slow, utility_slow, act] + quietBoost
  weights: { identity: 0.45, affect: 0.3, utility: 0.15, act: 0.1, quietBoost: 0.06 },
  // retrieve = w·[rel, identity, utility_slow, act]
  retrieveWeights: { rel: 0.45, identity: 0.25, utility: 0.2, act: 0.1 },

  decay: {
    affectHalfLifeDays: 180,
    utilityHalfLifeDays: 180,
    actTauDays: 21,
  },

  tier: {
    hysteresisUp: 1.15, // 晋升必须明显高于切线
    hysteresisDown: 0.85, // 下沉必须明显低于切线
    cooldownDays: 14, // 同一事件 14 天内不得二次搬迁
    maxMovesPerNight: 30,
    overflowTolerance: 0.1, // 允许超出预算 10%，避免边界振荡
  },

  promotion: {
    coreSteady: 1,
    coreBurst: 2,
    warmSteady: 3,
    warmBurst: 7,
    bypassRetain: 0.85, // 达到即跳过配额与存活期
    burstAffectSum: 6.0, // 当日 affect 之和超过此值，认为高强度日
    minSurvivalDays: 2, // 存活晋升：存在满 2 天才有资格（按自然日，不按巩固次数）
  },

  recall: {
    threshold: 0.4,
    minRel: 0.05, // 没有任何检索信号的条目，不允许靠 identity/utility 硬挤进来
    maxItems: 5,
    maxTokens: 1000,
  },

  embedding: {
    provider: 'local', // local | openai
    dim: 384,
    model: '',
    baseUrl: '',
    apiKey: '',
  },

  // 每晚自动巩固。服务半夜没开的话，早上开机补跑（判据是"今天还没跑过"）。
  schedule: {
    enabled: true,
    at: '04:30',
  },

  evict: {
    uniquenessWeight: 0.4,
    randomTieBreak: false,
  },

  // 事件合并 / 向量去重。只碰 cache2 与 l4，core 不动。
  merge: {
    enabled: true,
    dedupeThreshold: 0.9, // 几乎一样 → 直接并，不改写摘要
    mergeThreshold: 0.45, // 互补碎片 → 交给模型判断（相似度只是候选门槛）
    maxChecksPerNight: 20, // 每晚最多问模型多少次
    windowDays: 7,
    maxMergesPerNight: 10,
    maxGen: 3, // 摘要代数上限，到顶就别再并了
    maxSummaryChars: 110,
  },

  eval: {
    overallPass: 0.85,
  },
};

export function makeConfig(overrides = {}) {
  const deep = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deep(a[k] || {}, v) : v;
    }
    return out;
  };
  return deep(structuredClone(DEFAULT_CONFIG), overrides);
}
