// 线索（thread）：cache1 的粒度应该是"跨天的话题"，不是孤立事件。
// 7 条新事件常常只更新 1~2 条线索 —— 这是把 churn 压下来的根本手段。

export function deriveThreads(events, existing = [], now = Date.now()) {
  const byId = new Map(existing.map((t) => [t.id, { ...t }]));
  for (const ev of events) {
    if (!ev.threadId || ev.status !== 'active') continue;
    const t = byId.get(ev.threadId) || {
      id: ev.threadId,
      title: ev.threadId,
      status: 'open',
      entities: [],
      eventIds: [],
      lastTouched: ev.ts,
      openQuestion: null,
      salience: 0,
    };
    if (!t.eventIds.includes(ev.id)) t.eventIds.push(ev.id);
    t.lastTouched = Math.max(t.lastTouched || 0, ev.ts);
    t.entities = [...new Set([...(t.entities || []), ...(ev.entities || [])])];
    t.salience = Math.max(t.salience || 0, ev.score?.identity ?? 0);
    byId.set(t.id, t);
  }
  const staleMs = 21 * 86_400_000;
  for (const t of byId.values()) {
    if (t.status === 'open' && now - t.lastTouched > staleMs) t.status = 'closed';
  }
  return [...byId.values()].sort((a, b) => (b.lastTouched || 0) - (a.lastTouched || 0));
}

export function openThreads(threads, limit = 4) {
  return threads.filter((t) => t.status === 'open').slice(0, limit);
}
