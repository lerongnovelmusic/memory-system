import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/core/config.js';
import { actNorm, computeRetain, computeRetrieve, uniqueness, similarity } from '../src/core/score.js';
import { normalizeEvent } from '../src/core/events.js';
import { decayHalfLife } from '../src/core/time.js';

const cfg = makeConfig();
const DAY = 86_400_000;

function ev(over = {}, now = Date.now()) {
  return normalizeEvent(
    {
      summary: '默认事件',
      ts: now,
      tier: 'cache2',
      hits: [],
      score: { identity: 0.5, affect: 0.5, utility: 0.5 },
      ...over,
    },
    { now, dayKeyOf: () => '2026-11-23' }
  );
}

test('半衰期衰减：180 天后剩一半', () => {
  assert.equal(decayHalfLife(1, 180, 180), 0.5);
  assert.equal(decayHalfLife(1, 0, 180), 1);
});

test('激活度：被提及越多越高，且不会超过 1', () => {
  const now = Date.now();
  const once = actNorm([now], now);
  const thrice = actNorm([now, now - DAY, now - 5 * DAY], now);
  assert.ok(thrice > once);
  assert.ok(thrice <= 1);
  assert.equal(actNorm([], now), 0);
});

test('retain 在 [0,1]，且 identity 不随时间衰减', () => {
  const now = Date.now();
  const fresh = ev({ score: { identity: 1, affect: 0, utility: 0 } }, now);
  const old = ev({ ts: now - 400 * DAY, score: { identity: 1, affect: 0, utility: 0 } }, now);
  const a = computeRetain(fresh, now, cfg).retain;
  const b = computeRetain(old, now, cfg).retain;
  assert.ok(a >= 0 && a <= 1);
  assert.ok(Math.abs(a - b) < 1e-9, 'identity 不该因为变老而掉');
});

test('affect 会随时间衰减', () => {
  const now = Date.now();
  const r1 = computeRetain(ev({ score: { identity: 0, affect: 1, utility: 0 } }, now), now, cfg).retain;
  const old = ev({ ts: now - 360 * DAY, score: { identity: 0, affect: 1, utility: 0 } }, now);
  const r2 = computeRetain(old, now, cfg).retain;
  assert.ok(r2 < r1 * 0.5, `老事件应当明显更低：${r2} vs ${r1}`);
});

test('retrieve 用 rel，retain 不用 rel', () => {
  const now = Date.now();
  const e = ev({}, now);
  assert.equal(computeRetain(e, now, cfg).retain, computeRetain(e, now, cfg).retain);
  const low = computeRetrieve(e, now, 0, cfg);
  const high = computeRetrieve(e, now, 1, cfg);
  assert.ok(high > low);
});

test('唯一性：同质事件唯一性低，孤立事件唯一性高', () => {
  const now = Date.now();
  const a = ev({ id: 'a', summary: '今天一起吃了拉面，很普通', entities: ['拉面'] }, now);
  const b = ev({ id: 'b', summary: '今天一起吃了拉面，很普通', entities: ['拉面'] }, now);
  const c = ev({ id: 'c', summary: '他父亲去世了', entities: ['父亲'] }, now);
  assert.ok(uniqueness(a, [a, b]) < 0.5);
  assert.ok(uniqueness(c, [a, b]) > 0.8);
  assert.ok(similarity(a, b) > similarity(a, c));
});
