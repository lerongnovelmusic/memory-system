// 捕获层。每轮结束同步落盘，不经过任何 LLM，不可失败。
// 这一步做了，"某天的记忆凭空消失"才不可能发生。

import { nowMs } from './time.js';

export function captureTurn(store, { role, text, sessionId, ts = nowMs(), meta = null }) {
  const state = store.readJson('state.json', { seq: 0, watermarkTurn: 0 });
  state.seq = (state.seq || 0) + 1;
  const turn = {
    seq: state.seq,
    turnId: `t_${ts.toString(36)}_${state.seq}`,
    sessionId,
    ts,
    role,
    text: String(text ?? ''),
    tokens: null,
    meta,
  };
  store.appendJsonl('turns.jsonl', [turn]);
  store.writeJson('state.json', state);
  return turn;
}

export function pendingTurns(store, limit = 400) {
  const turns = store.readJsonl('turns.jsonl');
  const state = store.readJson('state.json', { watermarkTurn: 0 });
  return turns.filter((t) => t.seq > (state.watermarkTurn || 0)).slice(0, limit);
}

export function readTurnsSince(store, sinceTs) {
  return store.readJsonl('turns.jsonl').filter((t) => t.ts >= sinceTs);
}

/** 会话视图：最近 N 个会话，只读浏览用。 */
export function listSessions(store, limit = 7) {
  const turns = store.readJsonl('turns.jsonl');
  const byId = new Map();
  for (const t of turns) {
    const sid = t.sessionId || 'unknown';
    if (!byId.has(sid)) byId.set(sid, { sessionId: sid, start: t.ts, end: t.ts, count: 0, preview: '' });
    const s = byId.get(sid);
    s.end = Math.max(s.end, t.ts);
    s.count += 1;
    if (!s.preview && t.role === 'user') s.preview = t.text.slice(0, 40);
  }
  return [...byId.values()].sort((a, b) => b.end - a.end).slice(0, limit);
}

export function turnsOfSession(store, sessionId) {
  return store.readJsonl('turns.jsonl').filter((t) => t.sessionId === sessionId);
}
