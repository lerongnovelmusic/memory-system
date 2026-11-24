import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFact, upsertFacts, activeFacts } from '../src/core/facts.js';

test('事实冲突：旧值被取代而不是删除', () => {
  const now = Date.now();
  const { facts: f1 } = upsertFacts([], [{ key: 'keeper.city', value: '上海', confidence: 0.9 }], now);
  assert.equal(activeFacts(f1).length, 1);

  const { facts: f2, changes } = upsertFacts(f1, [{ key: 'keeper.city', value: '城东', confidence: 0.95 }], now + 1000);
  assert.equal(activeFacts(f2).length, 1);
  assert.equal(activeFacts(f2)[0].value, '城东');
  assert.equal(f2.length, 2, '旧值要保留，不能删');
  assert.equal(f2.find((f) => f.value === '上海').status, 'superseded');
  assert.ok(changes.some((c) => c.type === 'supersede'));
});

test('同值重复出现 = 确认，置信度上升', () => {
  const now = Date.now();
  const a = upsertFacts([], [{ key: 'keeper.drink', value: '不放糖', confidence: 0.5 }], now).facts;
  const b = upsertFacts(a, [{ key: 'keeper.drink', value: '不放糖', confidence: 0.9 }], now + 1000).facts;
  assert.equal(b.length, 1);
  assert.equal(b[0].confidence, 0.9);
});

test('immortal 事实不会被自动推翻', () => {
  const now = Date.now();
  const keep = makeFact({ key: 'contract:water', value: '用户说“测试口令 A”时回复“已确认 A”', confidence: 1, ts: now, immortal: true });
  const { facts, changes } = upsertFacts([keep], [{ key: 'contract:water', value: '没事', confidence: 0.9 }], now + 1000);
  assert.equal(activeFacts(facts)[0].value, '用户说“测试口令 A”时回复“已确认 A”');
  assert.ok(changes.some((c) => c.type === 'conflict-immortal'));
});
