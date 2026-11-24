// 分层与搬迁。容量驱动，不是阈值驱动。
// 每层只有一个可调参数：token 预算。切线由排序和预算算出来。
//
// 关键防护：
//   迟滞（1.15 / 0.85）—— 防边界振荡
//   冷却（14 天）    —— 防同一条反复横跳
//   配额（core 1 / warm 3，突发 2 / 7）—— 防热区被一天的情绪冲垮
//   存活（3 次巩固） —— 分代 GC 思路，新事件先别急着上桌

import { TIER_ORDER } from './config.js';
import { computeRetain, computeEvictScore } from './score.js';
import { tombstone } from './events.js';

export function tierIndex(tier) {
  return TIER_ORDER.indexOf(tier);
}

/**
 * 规划一夜的搬迁。纯函数，不写盘。
 * @returns {{lines, target, assignments, moves, rejected, evicted, stats}}
 */
export function planTiers(events, now, cfg, opts = {}) {
  const todayAffectSum = opts.todayAffectSum ?? 0;
  const active = events.filter((e) => e.status === 'active');

  const items = active.map((ev) => {
    const { retain } = computeRetain(ev, now, cfg);
    return { id: ev.id, ev, retain, tokens: ev.tokens || 60, tier: ev.tier };
  });

  const sorted = [...items].sort((a, b) => b.retain - a.retain);

  // ---- 1. 按预算自上而下装箱，得到切线与目标层 ----
  const lines = {};
  const target = new Map();
  let idx = 0;
  for (const tier of TIER_ORDER) {
    const cap = Math.max(0, (cfg.budgets[tier] || 0) - (cfg.fixedOverhead?.[tier] || 0));
    let used = 0;
    while (idx < sorted.length) {
      const it = sorted[idx];
      if (used + it.tokens > cap) break;
      used += it.tokens;
      target.set(it.id, tier);
      idx += 1;
    }
    // 切线 = 第一条"没挤进来"的分值，也就是入围门槛。
    // 用"最后一条挤进来的"会把垫底的填充物当成门槛，导致该沉的沉不下去。
    lines[tier] = sorted[idx] ? sorted[idx].retain : 0;
  }
  // 装不下的全部落到最底层（随后由淘汰步骤处理），不能凭空消失。
  for (; idx < sorted.length; idx += 1) target.set(sorted[idx].id, 'l4');

  // ---- 2. 生成候选搬迁 ----
  const cooldownMs = cfg.tier.cooldownDays * 86_400_000;
  const rejected = [];
  const promotions = [];
  const demotions = [];

  for (const it of items) {
    const to = target.get(it.id);
    if (!to || to === it.tier) continue;
    const fromIdx = tierIndex(it.tier);
    const toIdx = tierIndex(to);
    const cooled = it.ev.lastMoveAt && now - it.ev.lastMoveAt < cooldownMs;
    if (cooled) {
      rejected.push({ id: it.id, reason: 'cooldown', from: it.tier, to });
      continue;
    }
    if (toIdx < fromIdx) {
      if (it.retain < cfg.tier.hysteresisUp * lines[to]) {
        rejected.push({ id: it.id, reason: 'below-hysteresis', from: it.tier, to });
        continue;
      }
      promotions.push({ ...it, from: it.tier, to });
    } else {
      // 下沉：低于本层门槛即可下放。门槛是"第一条没挤进来的"，
      // 层没满时门槛为 0，因此不会发生无压力的搬迁。
      if (it.retain > lines[it.tier] * (1 + 1e-9)) {
        rejected.push({ id: it.id, reason: 'above-hysteresis', from: it.tier, to });
        continue;
      }
      demotions.push({ ...it, from: it.tier, to });
    }
  }

  // ---- 3. 晋升配额（含达标绕过） ----
  promotions.sort((a, b) => b.retain - a.retain);
  const burst = todayAffectSum >= cfg.promotion.burstAffectSum;
  const caps = {
    core: burst ? cfg.promotion.coreBurst : cfg.promotion.coreSteady,
    warm: burst ? cfg.promotion.warmBurst : cfg.promotion.warmSteady,
  };
  const used = { core: 0, warm: 0 };
  const acceptedPromotions = [];
  const DAY = 86_400_000;
  for (const p of promotions) {
    const bypass =
      p.retain >= cfg.promotion.bypassRetain ||
      p.ev.pinned ||
      p.ev.immortal ||
      p.ev.safety;
    // 存活晋升：按"存在了几天"算，不按"被巩固了几次"算——
    // 重跑同一批 turn 不该让事件凭空变老。
    const ageDays = (now - (p.ev.createdAt ?? p.ev.ts)) / DAY;
    if (!bypass && ageDays < cfg.promotion.minSurvivalDays) {
      rejected.push({ id: p.id, reason: 'survival', from: p.from, to: p.to });
      continue;
    }
    const targetTier = p.to;
    if (!bypass && caps[targetTier] != null) {
      if (used[targetTier] >= caps[targetTier]) {
        rejected.push({ id: p.id, reason: 'quota', from: p.from, to: p.to });
        continue;
      }
      used[targetTier] += 1;
    }
    acceptedPromotions.push(p);
  }

  // ---- 4. 合并、限流 ----
  let moves = [...acceptedPromotions, ...demotions].sort((a, b) => Math.abs(b.retain) - Math.abs(a.retain));
  if (moves.length > cfg.tier.maxMovesPerNight) {
    const dropped = moves.slice(cfg.tier.maxMovesPerNight);
    moves = moves.slice(0, cfg.tier.maxMovesPerNight);
    for (const d of dropped) rejected.push({ id: d.id, reason: 'rate-limit', from: d.from, to: d.to });
  }

  // ---- 5. 落位 ----
  const assignments = new Map(items.map((it) => [it.id, it.tier]));
  for (const m of moves) assignments.set(m.id, m.to);

  // ---- 6. 硬容量：超出容忍度就强制下沉 ----
  const evicted = [];
  for (const tier of ['core', 'warm', 'cache2']) {
    const cap = Math.max(0, (cfg.budgets[tier] || 0) - (cfg.fixedOverhead?.[tier] || 0));
    const limit = cap * (1 + cfg.tier.overflowTolerance);
    let inTier = items.filter((it) => assignments.get(it.id) === tier && !it.ev.pinned && !it.ev.immortal);
    let usedTokens = items
      .filter((it) => assignments.get(it.id) === tier)
      .reduce((s, it) => s + it.tokens, 0);
    inTier.sort((a, b) => a.retain - b.retain);
    while (usedTokens > limit && inTier.length) {
      const victim = inTier.shift();
      // 冷却中的事件不再被强制推动，宁可容忍一点超载，也不制造边界振荡。
      if (victim.ev.lastMoveAt && now - victim.ev.lastMoveAt < cooldownMs) continue;
      const next = TIER_ORDER[tierIndex(tier) + 1];
      if (!next) break;
      assignments.set(victim.id, next);
      usedTokens -= victim.tokens;
      moves.push({ id: victim.id, from: tier, to: next, retain: victim.retain, reason: 'overflow' });
    }
  }

  // ---- 7. 淘汰（只在 l4） ----
  const l4cap = Math.max(0, cfg.budgets.l4 || 0);
  const inL4 = items.filter((it) => assignments.get(it.id) === 'l4');
  let l4used = inL4.reduce((s, it) => s + it.tokens, 0);
  const evictable = inL4.filter((it) => !it.ev.pinned && !it.ev.immortal).sort(
    (a, b) => scoreOfEvict(a) - scoreOfEvict(b)
  );
  function scoreOfEvict(it) {
    return computeEvictScore({ ...it.ev, retain: it.retain }, active, cfg);
  }
  while (l4used > l4cap && evictable.length) {
    const victim = evictable.shift();
    assignments.delete(victim.id);
    evicted.push(victim.id);
    l4used -= victim.tokens;
  }

  return {
    lines,
    target,
    assignments,
    moves,
    rejected,
    evicted,
    stats: {
      active: active.length,
      burst,
      promotions: moves.filter((m) => tierIndex(m.to) < tierIndex(m.from)).length,
      demotions: moves.filter((m) => tierIndex(m.to) > tierIndex(m.from)).length,
      evicted: evicted.length,
      l4Used: l4used,
      l4Cap: l4cap,
    },
  };
}

/** 把规划落到事件数组上（返回新数组，不改入参）。 */
export function applyPlan(events, plan, now) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const moveById = new Map(plan.moves.map((m) => [m.id, m]));
  const evicted = new Set(plan.evicted);
  const out = [];

  for (const ev of events) {
    if (evicted.has(ev.id)) {
      out.push(tombstone(ev, now));
      continue;
    }
    const tier = plan.assignments.get(ev.id);
    const move = moveById.get(ev.id);
    if (tier && tier !== ev.tier) {
      out.push({ ...ev, tier, lastMoveAt: now, lastMoveReason: move?.reason || 'rebalance' });
    } else {
      out.push(tier ? { ...ev, tier } : ev);
    }
  }
  return out;
}

/** 过线判定，供回忆/调试用。 */
export function isAboveLine(ev, now, cfg, lines) {
  const { retain } = computeRetain(ev, now, cfg);
  return { retain, above: retain >= (lines[ev.tier] ?? 0) };
}
