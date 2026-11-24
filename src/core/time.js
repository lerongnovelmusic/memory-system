// 时间与日切。日切用本地 04:00：凌晨两点聊的算"昨晚"。

export const DAY_MS = 86_400_000;

export function nowMs() {
  return Date.now();
}

/** 把时间戳归入某个"记忆日"。 */
export function dayKey(ts, opts = {}) {
  const { tz = 'Europe/Berlin', cutoffHour = 4 } = opts;
  const shifted = new Date(ts - cutoffHour * 3_600_000);
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(shifted);
}

export function daysBetween(from, to) {
  return (to - from) / DAY_MS;
}

export function agingDays(ts, now) {
  return Math.max(0, (now - ts) / DAY_MS);
}

/** 值按半衰期衰减。 */
export function decayHalfLife(value, ageDays, halfLifeDays) {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return value;
  return value * Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

export function iso(ts) {
  return new Date(ts).toISOString();
}

/** 2026-11-05 */
export function fmtDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-10-01 至 2026-11-23"；没有终点就是"自 2026-10-01 起" */
export function fmtRange(from, to) {
  if (!from && !to) return '';
  if (!to) return `自 ${fmtDate(from)} 起`;
  if (!from) return `至 ${fmtDate(to)}`;
  return `${fmtDate(from)} 至 ${fmtDate(to)}`;
}

export function parseTime(input, fallback = Date.now()) {
  if (input == null || input === '') return fallback;
  if (typeof input === 'number') return input;
  const t = Date.parse(input);
  return Number.isNaN(t) ? fallback : t;
}

/** "3 天前"这类相对描述，注入时使用；避免她记成"昨天"。 */
export function humanAge(ts, now = Date.now()) {
  const d = (now - ts) / DAY_MS;
  if (d < 1) return '今天';
  if (d < 2) return '昨天';
  if (d < 7) return `${Math.floor(d)} 天前`;
  if (d < 30) return `${Math.floor(d / 7)} 周前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}
