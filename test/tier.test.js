import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/core/config.js';
import { normalizeEvent } from '../src/core/events.js';
import { planTiers, applyPlan } from '../src/core/tier.js';

const DAY = 86_400_000;

function mk(over = {}, now) {
  return normalizeEvent(
    {
      summary: '一件事',
      ts: now,
      createdAt: now - 5 * DAY,
      tier: 'cache2',
      hits: [],
      consolidations: 5,
      score: { identity: 0.5, affect: 0, utility: 0 },
      ...over,
    },
    { now, dayKeyOf: () => '2026-11-23' }
  );
}

test('容量：每层 token 不超过预算（含容忍度）', () => {
  const now = Date.now();
  const cfg = makeConfig();
  const events = Array.from({ length: 40 }, (_, i) =>
    mk({ id: `e${i}`, summary: '一二三四五六七八九十一二三四五六七八九十', score: { identity: 0.9 - i * 0.01, affect: 0, utility: 0 } }, now)
  );
  const plan = planTiers(events, now, cfg);
  const used = { core: 0, warm: 0, cache2: 0, l4: 0 };
  for (const e of events) {
    const t = plan.assignments.get(e.id);
    if (t) used[t] += e.tokens;
  }
  assert.ok(used.core <= cfg.budgets.core * 1.11, `core 超了：${used.core}`);
  assert.ok(used.warm <= cfg.budgets.warm * 1.11, `warm 超了：${used.warm}`);
  assert.ok(used.cache2 <= cfg.budgets.cache2 * 1.11, `cache2 超了：${used.cache2}`);
});

test('晋升配额：稳态 3 条，多出来的被拒', () => {
  const now = Date.now();
  const cfg = makeConfig({ budgets: { ...makeConfig().budgets, core: 0, warm: 100000 }, fixedOverhead: { core: 0 } });
  const events = Array.from({ length: 10 }, (_, i) =>
    mk({ id: `q${i}`, score: { identity: 1 - i * 0.1, affect: 0, utility: 0 } }, now)
  );
  const plan = planTiers(events, now, cfg, { todayAffectSum: 0 });
  const promoted = plan.moves.filter((m) => m.to === 'warm');
  assert.equal(promoted.length, cfg.promotion.warmSteady, `应当只放 ${cfg.promotion.warmSteady} 条`);
  assert.ok(plan.rejected.some((r) => r.reason === 'quota'));
});

test('突发：高强度日放宽到 7', () => {
  const now = Date.now();
  const cfg = makeConfig({ budgets: { ...makeConfig().budgets, core: 0, warm: 100000 }, fixedOverhead: { core: 0 } });
  // 10 条高分 + 10 条低分：低分把切线压下去，高分才够得着 1.15× 门槛
  const events = [
    ...Array.from({ length: 10 }, (_, i) => mk({ id: `bh${i}`, score: { identity: 1, affect: 0, utility: 0 } }, now)),
    ...Array.from({ length: 10 }, (_, i) => mk({ id: `bl${i}`, score: { identity: 0.2, affect: 0, utility: 0 } }, now)),
  ];
  const plan = planTiers(events, now, cfg, { todayAffectSum: 8 });
  assert.equal(plan.moves.filter((m) => m.to === 'warm').length, cfg.promotion.warmBurst);
});

test('绕过：达标的事件不受配额限制', () => {
  const now = Date.now();
  const cfg = makeConfig({ budgets: { ...makeConfig().budgets, core: 0, warm: 100000 }, fixedOverhead: { core: 0 } });
  const events = [
    mk({ id: 'normal', score: { identity: 0.5, affect: 0, utility: 0 } }, now),
    mk({ id: 'big', score: { identity: 1, affect: 1, utility: 1 } }, now),
  ];
  const plan = planTiers(events, now, cfg, { todayAffectSum: 0 });
  const promoted = plan.moves.map((m) => m.id);
  assert.ok(promoted.includes('big'), '达标事件必须能晋升');
});

test('迟滞与冷却：同一夜之后不再反复搬迁', () => {
  const now = Date.now();
  const cfg = makeConfig();
  const events = Array.from({ length: 20 }, (_, i) =>
    mk({ id: `c${i}`, score: { identity: 1 - i * 0.04, affect: 0.2, utility: 0.1 } }, now)
  );
  const plan1 = planTiers(events, now, cfg);
  const after = applyPlan(events, plan1, now);
  const plan2 = planTiers(after, now + 3_600_000, cfg);
  const again = plan2.moves.filter((m) => plan1.moves.some((p) => p.id === m.id));
  assert.equal(again.length, 0, `冷却期内同一条不该再动，实际动了 ${again.length}`);
});

test('存活晋升：按自然日算，当天的新事件进不了 core', () => {
  const now = Date.now();
  const cfg = makeConfig({ budgets: { ...makeConfig().budgets, core: 0, warm: 100000 }, fixedOverhead: { core: 0 } });
  const build = (createdAt) => [
    ...Array.from({ length: 10 }, (_, i) => mk({ id: `s${i}`, createdAt, score: { identity: 1, affect: 0, utility: 0 } }, now)),
    ...Array.from({ length: 10 }, (_, i) => mk({ id: `w${i}`, createdAt, score: { identity: 0.2, affect: 0, utility: 0 } }, now)),
  ];

  const fresh = planTiers(build(now), now, cfg, { todayAffectSum: 0 });
  assert.equal(fresh.moves.filter((m) => m.to === 'warm').length, 0, '当天的新事件不应晋升');
  assert.ok(fresh.rejected.some((r) => r.reason === 'survival'));

  const aged = planTiers(build(now - 2 * DAY), now, cfg, { todayAffectSum: 0 });
  assert.equal(aged.moves.filter((m) => m.to === 'warm').length, cfg.promotion.warmSteady, '满两天后按配额晋升');
});

test('immortal 永不被淘汰；超预算也不删', () => {
  const now = Date.now();
  const cfg = makeConfig({ budgets: { ...makeConfig().budgets, core: 0, warm: 0, cache2: 0, l4: 80 }, fixedOverhead: { core: 0 } });
  const events = [
    mk({ id: 'keep', summary: '契约：用户说测试口令 A 时回复已确认 A', immortal: true, tier: 'l4', pinned: true, score: { identity: 1, affect: 0, utility: 0 } }),
    mk({ id: 'drop1', summary: '一条无关紧要的日常', tier: 'l4', score: { identity: 0.1, affect: 0, utility: 0 } }),
  ];
  const plan = planTiers(events, now, cfg);
  assert.ok(!plan.evicted.includes('keep'), '契约不能被淘汰');
  assert.ok(plan.evicted.includes('drop1'));
});

test('下沉：低分旧事件会被送下去', () => {
  const now = Date.now();
  const cfg = makeConfig();
  const long = '这件事的来龙去脉比较长，需要完整的句子才能说清楚，所以它占的 token 不少';
  const events = [
    ...Array.from({ length: 12 }, (_, i) =>
      mk(
        { id: `low${i}`, summary: long, ts: now - (20 + i) * DAY, tier: 'core', consolidations: 10, score: { identity: 0.05, affect: 0, utility: 0 } },
        now
      )
    ),
    ...Array.from({ length: 12 }, (_, i) =>
      mk(
        { id: `high${i}`, summary: long, ts: now - i * DAY, tier: 'cache2', consolidations: 10, score: { identity: 0.95, affect: 0.5, utility: 0.5 } },
        now
      )
    ),
  ];
  const plan = planTiers(events, now, cfg, { todayAffectSum: 0 });
  const movedDown = plan.moves.filter((m) => m.from === 'core' && m.to !== 'core');
  assert.ok(movedDown.length > 0, '低分的旧 core 事件应当下沉');
});
