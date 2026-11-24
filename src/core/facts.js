// 事实：不是事件。不衰减、不淘汰，只"建立 / 覆盖 / 被推翻"。
// 生日、过敏、约定、称呼、禁忌 —— 这些被权重衰减处理掉就是事故。
//
// 失效必须带时间区间：只说"已不成立"会让人用现在时讲过去的事。
// 正确表达是"从 2026-10 到 2026-11 住城东，之后搬到城西"。

import { fmtRange, fmtDate } from './time.js';

let counter = 0;

export function makeFact({ key, value, confidence = 0.9, sourceEventIds = [], ts = Date.now(), immortal = false }) {
  counter += 1;
  return {
    id: `f_${ts.toString(36)}_${counter}`,
    key,
    value,
    confidence,
    validFrom: ts,
    validTo: null,
    status: 'active',
    sourceEventIds,
    lastConfirmedAt: ts,
    immortal,
  };
}

/** 同 key 不同值 → 旧记录标 superseded，永不删除。 */
export function upsertFacts(existing, incoming, now = Date.now()) {
  const facts = existing.map((f) => ({ ...f }));
  const changes = [];
  for (const raw of incoming) {
    const cand = raw.id ? raw : makeFact({ ...raw, ts: raw.ts ?? now });
    const actives = facts.filter((f) => f.key === cand.key && f.status === 'active');
    const same = actives.find((f) => normalize(f.value) === normalize(cand.value));

    if (same) {
      same.confidence = Math.max(same.confidence, cand.confidence ?? 0.9);
      same.lastConfirmedAt = now;
      same.sourceEventIds = [...new Set([...(same.sourceEventIds || []), ...(cand.sourceEventIds || [])])];
      changes.push({ type: 'confirm', id: same.id, key: same.key });
      continue;
    }

    for (const old of actives) {
      if (old.immortal) {
        // 契约类事实不允许被自动推翻，只能人工处理。
        changes.push({ type: 'conflict-immortal', id: old.id, key: old.key, kept: old.value, rejected: cand.value });
        continue;
      }
      old.status = 'superseded';
      old.validTo = cand.validFrom ?? now;
      old.supersededBy = cand.id;
      changes.push({ type: 'supersede', id: old.id, key: old.key, from: old.value, to: cand.value });
    }
    if (facts.some((f) => f.id === cand.id)) continue;
    facts.push(cand);
    changes.push({ type: 'create', id: cand.id, key: cand.key, value: cand.value });
  }
  return { facts, changes };
}

export function activeFacts(facts) {
  return facts.filter((f) => f.status === 'active');
}

/** 现在有效的事实，带"自 X 起"。 */
export function renderFacts(facts, { maxTokens = 600, tokensOf, withRange = true } = {}) {
  const lines = [];
  let used = 0;
  for (const f of activeFacts(facts).sort((a, b) => b.confidence - a.confidence)) {
    const since = withRange && f.validFrom ? `（自 ${fmtDate(f.validFrom)} 起）` : '';
    const line = `${f.key}：${f.value}${since}${f.confidence < 0.6 ? '（不确定）' : ''}`;
    const t = tokensOf ? tokensOf(line) : Math.ceil(line.length * 0.75);
    if (used + t > maxTokens) break;
    lines.push(line);
    used += t;
  }
  return { text: lines.join('\n'), used };
}

/**
 * 最近发生的变化：旧值 + 它成立的时间段。
 * 这些不能被当成"现在的事实"，但可以让说话有前后文——
 * "你以前住城东（到 11 月），后来搬去城西" 比 "你住城西" 更像人。
 */
export function renderRecentChanges(facts, { days = 90, now = Date.now(), maxTokens = 160, tokensOf } = {}) {
  const since = now - days * 86_400_000;
  const changed = facts
    .filter((f) => f.status === 'superseded' && (f.validTo || 0) >= since)
    .sort((a, b) => (b.validTo || 0) - (a.validTo || 0));

  const lines = [];
  let used = 0;
  for (const f of changed) {
    const next = facts.find((x) => x.id === f.supersededBy);
    const line = `- ${f.key}：${f.value}（${fmtRange(f.validFrom, f.validTo)}，${next ? `现在是 ${next.value}` : '已失效'}）`;
    const t = tokensOf ? tokensOf(line) : Math.ceil(line.length * 0.75);
    if (used + t > maxTokens) break;
    lines.push(line);
    used += t;
  }
  return { text: lines.join('\n'), used };
}

function normalize(v) {
  return String(v).trim().toLowerCase();
}
