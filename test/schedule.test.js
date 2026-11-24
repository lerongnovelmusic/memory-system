import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunNow, parseHHMM } from '../src/core/schedule.js';

test('调度：过了点且今天没跑 → 该跑', () => {
  const now = new Date('2026-11-23T05:00:00+01:00').getTime();
  assert.equal(shouldRunNow({ now, at: '04:30', tz: 'Europe/Berlin', lastRunDay: null }), true);
});

test('调度：今天已经跑过 → 不再跑（幂等护栏）', () => {
  const now = new Date('2026-11-23T05:00:00+01:00').getTime();
  assert.equal(shouldRunNow({ now, at: '04:30', tz: 'Europe/Berlin', lastRunDay: '2026-11-23' }), false);
});

test('调度：还没到点 → 不跑', () => {
  const now = new Date('2026-11-23T03:00:00+01:00').getTime();
  assert.equal(shouldRunNow({ now, at: '04:30', tz: 'Europe/Berlin', lastRunDay: null }), false);
});

test('调度：半夜没开机，早上开机补跑', () => {
  const morning = new Date('2026-11-23T11:20:00+01:00').getTime();
  assert.equal(shouldRunNow({ now: morning, at: '04:30', tz: 'Europe/Berlin', lastRunDay: '2026-11-22' }), true);
});

test('调度：昨天跑过、今天还没到点 → 不跑', () => {
  const early = new Date('2026-11-23T02:00:00+01:00').getTime();
  assert.equal(shouldRunNow({ now: early, at: '04:30', tz: 'Europe/Berlin', lastRunDay: '2026-11-22' }), false);
});

test('调度：时间解析容错', () => {
  assert.deepEqual(parseHHMM('04:30'), { h: 4, m: 30 });
  assert.deepEqual(parseHHMM('9:05'), { h: 9, m: 5 });
  assert.deepEqual(parseHHMM('乱写'), { h: 4, m: 30 });
});
