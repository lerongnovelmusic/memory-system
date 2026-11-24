// 夜间巩固。异步、幂等、可重入。
// 幂等靠 turn 的 seq 水位 + sources.turns 去重；失败不前进水位。

import { dayKey, nowMs } from './time.js';
import { normalizeEvent } from './events.js';
import { upsertFacts } from './facts.js';
import { planTiers, applyPlan } from './tier.js';
import { deriveThreads } from './threads.js';
import { mergePass } from './merge.js';

const BATCH = 20;

export async function consolidate({ store, llm, cfg, now = nowMs(), dryRun = false, batchSize = BATCH, vectors = new Map() }) {
  const state = store.readJson('state.json', { seq: 0, watermarkTurn: 0 });
  const allTurns = store.readJsonl('turns.jsonl');
  const pending = allTurns.filter((t) => t.seq > (state.watermarkTurn || 0));

  if (pending.length === 0) {
    return { skipped: true, reason: 'no-pending-turns', report: { at: now, newEvents: 0, newFacts: 0 } };
  }

  const dayKeyOf = (ts) => dayKey(ts, { tz: cfg.tz, cutoffHour: cfg.dayCutoffHour });

  let events = store.readJsonl('events.jsonl').map((e) => normalizeEvent(e, { now, dayKeyOf }));
  let facts = store.readJsonl('facts.jsonl');
  const existing = new Set(events.flatMap((e) => e.sources?.turns || []));

  const created = [];
  const factCandidates = [];
  const quarantined = [];
  let processed = 0;
  const knownEntities = [...new Set(events.flatMap((e) => e.entities || []))];

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    let out;
    try {
      out = await llm.extractEvents(batch, { now, cfg, knownEntities });
    } catch (err) {
      quarantined.push({ batchStart: batch[0].seq, error: String(err?.message || err) });
      break; // 水位不前进，下次重跑
    }
    for (const raw of out.events || []) {
      const turnIds = (raw.sources?.turns || []).filter(Boolean);
      if (turnIds.length && turnIds.every((id) => existing.has(id))) continue; // 幂等
      const ev = normalizeEvent(
        {
          ...raw,
          tier: 'cache2', // 新事件一律从 cache2 落地，再由分层决定去向
          sources: { turns: turnIds, events: raw.sources?.events || [] },
        },
        { now, dayKeyOf, seq: events.length + created.length + 1 }
      );
      if (!ev.summary) continue;
      for (const id of turnIds) existing.add(id);
      created.push(ev);
    }
    for (const f of out.facts || []) factCandidates.push(f);
    processed += batch.length;
  }

  // 巩固计数：活过一次巩固，是"存活晋升"的依据
  events = events.map((e) => (e.status === 'active' ? { ...e, consolidations: (e.consolidations || 0) + 1 } : e));
  events = [...events, ...created];

  // 合并 / 去重：在分层之前做，否则重复事件会先占掉预算再被并掉。
  const merged = await mergePass({ events, vectors, cfg, now, llm });
  events = merged.events;
  // 事实：冲突即取代，immortal 的不许自动推翻
  const applied = upsertFacts(facts, factCandidates, now);
  facts = applied.facts;

  const todayKey = dayKeyOf(now);
  const todayAffectSum = events
    .filter((e) => e.status === 'active' && dayKeyOf(e.ts) === todayKey)
    .reduce((s, e) => s + (e.score?.affect || 0), 0);

  const plan = planTiers(events, now, cfg, { todayAffectSum });
  const tiered = applyPlan(events, plan, now);
  const threads = deriveThreads(tiered, store.readJson('threads.json', []), now);

  const report = {
    at: now,
    day: todayKey,
    turnsProcessed: processed,
    newEvents: created.length,
    newFacts: (applied.changes || []).filter((c) => c.type === 'create').length,
    supersededFacts: (applied.changes || []).filter((c) => c.type === 'supersede').length,
    merges: merged.log,
    quarantined,
    tier: plan.stats,
    moves: plan.moves.map((m) => ({ id: m.id, from: m.from, to: m.to, reason: m.reason })),
    rejected: plan.rejected.slice(0, 20),
    evicted: plan.evicted,
  };

  if (!dryRun) {
    store.snapshot(`pre-consolidate-${todayKey}`);
    store.writeJsonl('events.jsonl', tiered);
    store.writeJsonl('facts.jsonl', facts);
    store.writeJson('threads.json', threads);
    store.appendJsonl('moves.log', plan.moves.map((m) => ({ ...m, at: now })));
    if (merged.log.length) store.appendJsonl('merge.log', merged.log.map((m) => ({ ...m, at: now })));
    store.writeJson(`state.json`, { ...state, watermarkTurn: pending[processed - 1]?.seq ?? state.watermarkTurn, lastConsolidatedAt: now });
    store.writeJson(`reports/${todayKey}.json`, report);
  }

  return { skipped: false, report, events: tiered, facts, threads, plan };
}
