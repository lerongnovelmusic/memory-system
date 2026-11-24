import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/core/config.js';
import { normalizeEvent, rewriteSummary, restoreOriginal, tombstone } from '../src/core/events.js';
import { computeRetain } from '../src/core/score.js';
import { mergePass } from '../src/core/merge.js';
import { hashEmbed, embeddingText } from '../src/core/embed.js';
import { renderRecentChanges, upsertFacts } from '../src/core/facts.js';
import { createHeuristicLLM } from '../src/llm/stub.js';

const NOW = Date.parse('2026-11-23T21:00:00+01:00');
const DAY = 86_400_000;

function mk(id, over = {}) {
  return normalizeEvent(
    {
      id,
      summary: over.summary || '一件事',
      ts: NOW,
      createdAt: NOW - 3 * DAY,
      tier: 'cache2',
      hits: [],
      score: { identity: 0.5, affect: 0.3, utility: 0.5 },
      ...over,
    },
    { now: NOW, dayKeyOf: () => '2026-11-23' }
  );
}

test('平静但重要：情绪低的日常有额外加权', () => {
  const withBoost = makeConfig();
  const noBoost = makeConfig({ weights: { ...withBoost.weights, quietBoost: 0 } });
  const quiet = mk('q', { score: { identity: 0.9, affect: 0.1, utility: 0.8 } });
  const a = computeRetain(quiet, NOW, withBoost).retain;
  const b = computeRetain(quiet, NOW, noBoost).retain;
  assert.ok(a > b, `应当有 quietBoost：${a} vs ${b}`);
  assert.ok(Math.abs(a - b - withBoost.weights.quietBoost) < 1e-9);
});

test('平静但重要：只对"高身份值 + 低情绪"生效', () => {
  const cfg = makeConfig();
  const loud = mk('l', { score: { identity: 0.9, affect: 0.9, utility: 0.8 } });
  assert.equal(computeRetain(loud, NOW, cfg).parts.quiet, 0);
});

test('原文不可覆盖：合并后 originalSummary 仍在，且能恢复', async () => {
  const llm = createHeuristicLLM();
  const events = [
    mk('a', { summary: '今天去学校办了注册', entities: ['学校'] }),
    mk('b', { summary: '今天去学校办了注册，排了两个小时队', entities: ['学校'] }),
  ];
  const vecs = new Map(events.map((e) => [e.id, { hash: 'x', v: hashEmbed(embeddingText(e), 384) }]));
  const { events: out } = await mergePass({ events, vectors: vecs, cfg: makeConfig(), now: NOW, llm });
  const alive = out.find((e) => e.status === 'active');
  assert.equal(alive.summary, '今天去学校办了注册，排了两个小时队');
  assert.equal(alive.originalSummary, '今天去学校办了注册', '起点必须留着');
  assert.equal(alive.history.length, 1);
  assert.equal(alive.gen, 1);

  const restored = restoreOriginal(alive, NOW + 1000);
  assert.equal(restored.summary, '今天去学校办了注册');
  assert.equal(restored.gen, 0);
  assert.equal(restored.originalSummary, '今天去学校办了注册');
  assert.ok(restored.history.length >= 2, '恢复动作也要进历史');
});

test('改写摘要只追加历史，不动 originalSummary', () => {
  const ev = mk('x', { summary: '原始说法' });
  const r1 = rewriteSummary(ev, '第一次改写', { at: NOW });
  const r2 = rewriteSummary(r1, '第二次改写', { at: NOW + 1000 });
  assert.equal(r2.summary, '第二次改写');
  assert.equal(r2.originalSummary, '原始说法');
  assert.equal(r2.history.length, 2);
  assert.equal(r2.history[0].summary, '原始说法');
  assert.equal(r2.gen, 2);
});

test('失效带时间区间：最近变化能说出"从 X 到 Y"', () => {
  const facts = upsertFacts(
    [],
    [{ key: 'keeper.city', value: '城东', confidence: 0.9, ts: NOW - 40 * DAY }],
    NOW - 40 * DAY
  ).facts;
  const next = upsertFacts(facts, [{ key: 'keeper.city', value: '城西', confidence: 0.9, ts: NOW - 2 * DAY }], NOW - 2 * DAY).facts;
  const out = renderRecentChanges(next, { now: NOW, days: 90 });
  assert.match(out.text, /城东/);
  assert.match(out.text, /至/);
  assert.match(out.text, /城西/);
});

test('墓碑：只留一行，但结构还在', () => {
  const ev = mk('t', { summary: '这是一条很长很长的事件摘要，用来验证墓碑会把它截断' });
  const t = tombstone(ev, NOW);
  assert.equal(t.status, 'tombstone');
  assert.ok(t.summary.length <= 40);
  assert.equal(t.tier, 'gone');
  assert.ok(t.tokens <= 60);
});
