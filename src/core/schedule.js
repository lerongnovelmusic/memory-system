// 每晚自动巩固。跑在 GUI 服务里，不需要系统计划任务。
//
// 三个必须防的问题：
//   1. 服务半夜没开 → 早上开机要能补跑（判据是"今天还没跑过"，不是"现在正好 4:30"）
//   2. 同一天跑两次 → 巩固本身幂等（水位 + sources 去重），重复跑不会造重复事件
//   3. 持续失败 → 退避重试，不要每 30 秒打一次

import { dayKey } from './time.js';

export function parseHHMM(at = '04:30') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  if (!m) return { h: 4, m: 30 };
  return { h: Number(m[1]), m: Number(m[2]) };
}

export function localHM(now, tz) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = fmt.format(new Date(now)).split(':').map(Number);
  return { h, m };
}

/** 纯函数，方便单测：今天该不该跑。 */
export function shouldRunNow({ now, at = '04:30', tz = 'Europe/Berlin', lastRunDay = null }) {
  const target = parseHHMM(at);
  const cur = localHM(now, tz);
  const passed = cur.h * 60 + cur.m >= target.h * 60 + target.m;
  const today = dayKey(now, { tz, cutoffHour: 0 });
  return passed && lastRunDay !== today;
}

export class Scheduler {
  constructor({ engine, at = '04:30', tz, intervalMs = 30_000, onReport = null }) {
    this.engine = engine;
    this.at = at;
    this.tz = tz || engine.cfg.tz;
    this.intervalMs = intervalMs;
    this.onReport = onReport;
    this.timer = null;
    this.running = false;
    this.retryAfter = 0;
    this.statePath = 'schedule.json';
  }

  readState() {
    return this.engine.store.readJson(this.statePath, { lastRunDay: null, runs: [] });
  }

  writeState(s) {
    this.engine.store.writeJson(this.statePath, s);
  }

  status() {
    const s = this.readState();
    return {
      at: this.at,
      tz: this.tz,
      paused: Boolean(s.paused),
      running: this.running,
      lastRunDay: s.lastRunDay,
      lastRunAt: s.lastRunAt || null,
      lastError: s.lastError || null,
      lastReport: s.runs?.[0] || null,
    };
  }

  setPaused(paused) {
    const s = this.readState();
    this.writeState({ ...s, paused: Boolean(paused), pausedAt: paused ? Date.now() : null });
    return this.status();
  }

  start() {
    if (this.timer) return this;
    const tick = () => this.tick().catch(() => {});
    this.timer = setInterval(tick, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    tick();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()) {
    if (this.running || now < this.retryAfter) return;
    const state = this.readState();
    if (state.paused) return; // 急停：不自动巩固，手动仍然可以跑
    if (!shouldRunNow({ now, at: this.at, tz: this.tz, lastRunDay: state.lastRunDay })) return;

    this.running = true;
    try {
      const out = await this.engine.consolidate({ now });
      const today = dayKey(now, { tz: this.tz, cutoffHour: 0 });
      const entry = {
        at: now,
        day: today,
        skipped: Boolean(out.skipped),
        newEvents: out.report?.newEvents ?? 0,
        newFacts: out.report?.newFacts ?? 0,
        promoted: out.report?.tier?.promotions ?? 0,
        moved: out.report?.moves?.length ?? 0,
        evicted: out.report?.tier?.evicted ?? 0,
      };
      this.writeState({
        lastRunDay: today,
        lastRunAt: now,
        lastError: null,
        runs: [entry, ...(state.runs || [])].slice(0, 30),
      });
      this.onReport?.(entry);
    } catch (err) {
      this.writeState({
        ...state,
        lastError: String(err?.message || err),
        lastAttemptAt: now,
      });
      this.retryAfter = now + 5 * 60_000; // 失败退避 5 分钟
    } finally {
      this.running = false;
    }
  }
}

export function startScheduler({ engine, at, intervalMs, onReport }) {
  const s = new Scheduler({ engine, at, intervalMs, onReport }).start();
  return s;
}

export function readScheduleLog(engine) {
  return engine.store.readJson('schedule.json', { runs: [] });
}
