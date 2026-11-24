// 事件模型：规范化、去重、双时态、取代。
// 铁律：永远不删除。被取代的事件是她"怎么改变想法"的证据，只标记，不抹除。

import { estimateTokens } from './token.js';
import { parseTime } from './time.js';

export const EVENT_KINDS = ['episode', 'promise', 'conflict', 'milestone', 'fact_change', 'contract'];

export function normalizeEvent(raw, { now = Date.now(), dayKeyOf, seq = 0 } = {}) {
  const ts = parseTime(raw.ts ?? raw.time ?? now, now);
  const score = {
    identity: clamp01(raw.score?.identity ?? 0.3),
    affect: clamp01(raw.score?.affect ?? 0.3),
    utility: clamp01(raw.score?.utility ?? 0.3),
  };
  const summary = String(raw.summary ?? '').trim();
  const ev = {
    id: raw.id || `e_${ts.toString(36)}_${seq}`,
    dayKey: raw.dayKey || (dayKeyOf ? dayKeyOf(ts) : ''),
    ts,
    createdAt: raw.createdAt ?? now,
    tier: raw.tier || 'l1',
    status: raw.status || 'active',
    validFrom: raw.validFrom ?? ts,
    validTo: raw.validTo ?? null,
    supersededBy: raw.supersededBy ?? null,
    entities: dedupe(raw.entities || []),
    threadId: raw.threadId ?? null,
    kind: EVENT_KINDS.includes(raw.kind) ? raw.kind : 'episode',
    summary,
    quote: String(raw.quote ?? '').trim(),
    // 原文永不覆盖：originalSummary 是它第一次被写进来时的样子，
    // 之后的合并/改写只往 history 里追加，不抹掉起点。
    originalSummary: raw.originalSummary ?? summary,
    history: Array.isArray(raw.history) ? raw.history : [],
    facts: Array.isArray(raw.facts) ? raw.facts : [],
    score,
    hits: Array.isArray(raw.hits) ? raw.hits.slice() : [ts],
    gen: raw.gen ?? 0,
    sources: {
      turns: raw.sources?.turns || [],
      events: raw.sources?.events || [],
    },
    neighbors: raw.neighbors || [],
    tokens: 0,
    lastMoveAt: raw.lastMoveAt ?? null,
    consolidations: raw.consolidations ?? 0,
    mergedInto: raw.mergedInto ?? null,
    mergedCount: raw.mergedCount ?? 0,
    pinned: Boolean(raw.pinned),
    pinnedAt: raw.pinnedAt ?? (raw.pinned ? ts : null),
    immortal: Boolean(raw.immortal),
    safety: Boolean(raw.safety),
  };
  ev.tokens = eventTokens(ev);
  return ev;
}

export function eventTokens(ev) {
  // 结构化字段开销 + 正文
  return 40 + estimateTokens(ev.summary) + estimateTokens(ev.quote);
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function dedupe(arr) {
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}

export function isAlive(ev) {
  return ev.status === 'active';
}

/** 冲突取代：旧记录标 superseded，不降权、不删除。 */
export function supersede(oldEv, newEv, now = Date.now()) {
  return {
    ...oldEv,
    status: 'superseded',
    validTo: newEv.validFrom ?? now,
    supersededBy: newEv.id,
  };
}

/** 检索/注入前的可见性过滤。superseded / merged 默认不可见。 */
export function visibleForInjection(ev, { meta = false } = {}) {
  if (ev.status === 'tombstone' || ev.status === 'merged') return false;
  if (ev.status === 'superseded') return meta;
  if (ev.status === 'disputed') return meta;
  return true;
}

/** 改写摘要：只追加历史，不动起点。 */
export function rewriteSummary(ev, next, { at = Date.now(), reason = 'merge' } = {}) {
  const summary = String(next || '').trim();
  if (!summary || summary === ev.summary) return ev;
  return {
    ...ev,
    summary,
    history: [
      ...(ev.history || []),
      { summary: ev.summary, gen: ev.gen || 0, at, reason },
    ],
    gen: (ev.gen || 0) + 1,
  };
}

/** 人工回退：把摘要恢复成最初的样子，历史保留。 */
export function restoreOriginal(ev, at = Date.now()) {
  if (!ev.originalSummary || ev.originalSummary === ev.summary) return ev;
  return {
    ...ev,
    summary: ev.originalSummary,
    history: [
      ...(ev.history || []),
      { summary: ev.summary, gen: ev.gen || 0, at, reason: 'manual-restore' },
    ],
    gen: 0,
  };
}

/** 墓碑：淘汰不是删除，留一行摘要，防止回忆时复活成完整事件。 */
export function tombstone(ev, now = Date.now()) {
  return {
    ...ev,
    status: 'tombstone',
    summary: ev.summary.slice(0, 40),
    quote: '',
    validTo: now,
    tier: 'gone',
    tokens: 60,
  };
}
