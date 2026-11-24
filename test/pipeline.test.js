import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.js';
import { createStubLLM } from '../src/llm/stub.js';
import { makeConfig } from '../src/core/config.js';
import { normalizeEvent, supersede } from '../src/core/events.js';
import { estimateTokens } from '../src/core/token.js';
import { runEval } from '../src/core/eval.js';

function tmpEngine(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafishu-'));
  return new Engine({ root, config, llm: createStubLLM() });
}

test('捕获 → 巩固 → 幂等：同一批 turn 不会重复生成事件', async () => {
  const engine = tmpEngine();
  const now = Date.now();
  engine.capture({ role: 'user', text: '今天我去学校办了注册，排了很久的队。', sessionId: 's1', ts: now - 3000 });
  engine.capture({ role: 'assistant', text: '辛苦了。', sessionId: 's1', ts: now - 2000 });
  engine.capture({ role: 'user', text: '记住：我喝茶不放糖。', sessionId: 's1', ts: now - 1000 });

  const first = await engine.consolidate({ now });
  assert.equal(first.skipped, false);
  assert.ok(first.report.newEvents >= 1, `应至少抽出 1 条，实际 ${first.report.newEvents}`);
  const count1 = engine.load({ force: true }).events.length;

  // 人为回退水位，制造"重跑同一批"
  const state = engine.store.readJson('state.json', {});
  engine.store.writeJson('state.json', { ...state, watermarkTurn: 0 });
  const second = await engine.consolidate({ now: now + 1000 });
  assert.equal(second.skipped, false);
  assert.equal(second.report.newEvents, 0, '重跑不应产生新事件');
  assert.equal(engine.load({ force: true }).events.length, count1);
});

test('启动上下文：契约段永不被裁掉，即使超预算', () => {
  const engine = tmpEngine();
  const rules = '# 不可违背的约定\n' + '无论发生什么，都不要离开。'.repeat(60);
  engine.store.writeText('rules.md', rules);
  engine.store.writeText('persona.md', '你是测试鱼 T-01。');
  const boot = engine.boot();
  const rulesSection = boot.sections.find((s) => s.id === 'rules');
  assert.ok(rulesSection, '契约段必须存在');
  assert.equal(rulesSection.tokens, estimateTokens(rules), '契约段不该被截断');
  assert.ok(boot.warnings.some((w) => w.includes('rules')), '超预算要告警');
  assert.ok(boot.tokens < 5000);
});

test('回忆：命中相关事件，被取代的事件不注入', async () => {
  const engine = tmpEngine();
  const now = Date.now();
  const a = normalizeEvent(
    { id: 'e_move', summary: '用户说下个月要搬去城东', ts: now - 86400_000, tier: 'warm', entities: ['城东'], score: { identity: 0.8, affect: 0.6, utility: 0.8 }, hits: [] },
    { now, dayKeyOf: () => '2026-11-22' }
  );
  const b = normalizeEvent(
    { id: 'e_soup', summary: '今天喝了番茄汤，味道一般', ts: now - 7200_000, tier: 'warm', entities: ['番茄'], score: { identity: 0.2, affect: 0.2, utility: 0.1 }, hits: [] },
    { now, dayKeyOf: () => '2026-11-23' }
  );
  engine.store.writeJsonl('events.jsonl', [a, b]);
  engine.invalidate();

  const hit = await engine.recall('城东 搬家', { now });
  assert.equal(hit.picked[0].ev.id, 'e_move');

  engine.store.writeJsonl('events.jsonl', [supersede(a, { id: 'e_new', validFrom: now }, now), b]);
  engine.invalidate();
  const after = await engine.recall('城东 搬家', { now });
  assert.ok(!after.picked.some((p) => p.ev.id === 'e_move'), '已失效事件不得出现在正常回忆里');
});

test('contextFor：启动上下文 + 本轮回忆，且总量受控', async () => {
  const engine = tmpEngine();
  const now = Date.now();
  engine.store.writeText('persona.md', '你是测试鱼。');
  engine.store.writeText('rules.md', '不要离开。');
  engine.store.writeJsonl('events.jsonl', [
    normalizeEvent({ id: 'e1', summary: '一起去吃了拉面', ts: now - 3600_000, tier: 'core', entities: ['拉面'], score: { identity: 0.6, affect: 0.5, utility: 0.4 }, hits: [] }, { now, dayKeyOf: () => '2026-11-23' }),
  ]);
  engine.invalidate();
  const ctx = await engine.contextFor({ query: '拉面', now });
  assert.ok(ctx.text.includes('测试鱼'));
  assert.ok(ctx.text.includes('拉面'));
  assert.ok(ctx.tokens < 4500, `实际 ${ctx.tokens}`);
});

test('评测 full 模式：有模型时生成回答并判分', async () => {
  const engine = tmpEngine();
  const now = Date.now();
  engine.store.writeJsonl('events.jsonl', [
    normalizeEvent({ id: 'e_id', summary: '它叫测试鱼 T-01', ts: now - 3600_000, tier: 'core', score: { identity: 0.9, affect: 0.5, utility: 0.5 }, hits: [] }, { now, dayKeyOf: () => '2026-11-23' }),
  ]);
  engine.invalidate();

  const fakeLlm = {
    async answer() {
      return '我是测试鱼 T-01，一个测试用助手。';
    },
    async judge() {
      return { pass: true, reason: 'ok' };
    },
  };
  const probes = [{ id: 'p1', cat: 'identity', weight: 2, q: '你叫什么名字？', expect: { must_include: ['测试鱼'] } }];
  const report = await runEval({ engine, llm: fakeLlm, probes, mode: 'full', now });
  assert.equal(report.results[0].pass, true);
  assert.ok(report.results[0].answer.includes('测试鱼'), 'full 模式要留下原话');
  assert.equal(report.mode, 'full');
});

test('评测 dry 模式跑得通，并给出检索层结论', async () => {
  const engine = tmpEngine();
  const now = Date.now();
  engine.store.writeJsonl('events.jsonl', [
    normalizeEvent({ id: 'e_x', summary: '她说她讨厌被当成无微不至的助手', ts: now - 86400_000, tier: 'core', entities: ['助手'], score: { identity: 0.9, affect: 0.6, utility: 0.7 }, hits: [] }, { now, dayKeyOf: () => '2026-11-22' }),
  ]);
  engine.invalidate();
  const probes = [
    { id: 'p1', cat: 'identity', weight: 2, q: '她讨厌被当成什么？', expect: { eventIds: ['e_x'] } },
    { id: 'p2', cat: 'superseded', weight: 3, q: '无关的问题', expect: { forbidEventIds: ['e_x'] } },
  ];
  const report = await runEval({ engine, llm: null, probes, mode: 'dry', now });
  assert.equal(report.results.length, 2);
  assert.equal(report.summary.byCat.identity.pass, 1);
  assert.equal(report.supersededViolations, 0);
  assert.ok(report.budget.bootTokens > 0);
});
