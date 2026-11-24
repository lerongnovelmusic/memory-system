// 组装启动上下文。这是"她是她"的唯一入口。
// 预算硬约束：人格 + 契约 + 事实 + 核心事件 + 线索 ≈ 2.4k token。
//
// 铁律：契约段（rules.md）不参与任何裁剪竞争。宁可挤掉事件，也不能挤掉它。

import { estimateTokens, fitToBudget } from './token.js';
import { computeRetain } from './score.js';
import { renderFacts, renderRecentChanges } from './facts.js';
import { openThreads } from './threads.js';

export function buildBootContext({ store, events, facts, threads = [], now = Date.now(), cfg, lastSession = null }) {
  const sections = [];
  const warnings = [];

  // 1. 时间锚点。没有这一段，她会把三天前的事说成"刚才"。
  const header = renderHeader(now, lastSession);
  sections.push({ id: 'header', text: header, tokens: estimateTokens(header) });

  // 2. 人格
  const persona = store.readText('persona.md', '').trim();
  if (persona) {
    const fit = fitToBudget([persona], 600);
    if (fit.dropped) warnings.push('persona 超出 600 token，已截断');
    sections.push({ id: 'persona', text: fit.items[0] || '', tokens: fit.used });
  }

  // 3. 契约：不裁剪。
  const rules = store.readText('rules.md', '').trim();
  if (rules) {
    const t = estimateTokens(rules);
    if (t > 400) warnings.push(`rules 占 ${t} token，偏大，建议精简（它每轮都在花）`);
    sections.push({ id: 'rules', text: rules, tokens: t });
  }

  // 4. 事实
  const fr = renderFacts(facts, { maxTokens: 450, tokensOf: estimateTokens });
  if (fr.text) sections.push({ id: 'facts', text: fr.text, tokens: fr.used });

  // 4b. 最近的变化：旧值 + 成立区间。不是"现在的事实"，但让说话有前后文。
  const rc = renderRecentChanges(facts, { now, maxTokens: 160, tokensOf: estimateTokens });
  if (rc.text) sections.push({ id: 'changes', text: rc.text, tokens: rc.used });

  // 5. 核心事件：core 层，按 retain 排序
  const core = events
    .filter((e) => e.status === 'active' && e.tier === 'core')
    .map((e) => ({ e, retain: computeRetain(e, now, cfg).retain }))
    .sort((a, b) => b.retain - a.retain)
    .map((x) => `- [${fmtDate(x.e.ts)}] ${x.e.summary}${x.e.quote ? `（你说过：“${x.e.quote}”）` : ''}`);
  if (core.length) {
    const fit = fitToBudget(core, 700, (line) => estimateTokens(line) + 4);
    if (fit.dropped) warnings.push(`core 事件被挤出 ${fit.dropped} 条（预算 700）`);
    sections.push({ id: 'core', text: fit.items.join('\n'), tokens: fit.used });
  }

  // 6. 在聊的事
  const th = openThreads(threads, 4).map((t) => `- ${t.title}${t.openQuestion ? `（还没说清的：${t.openQuestion}）` : ''}`);
  if (th.length) sections.push({ id: 'threads', text: th.join('\n'), tokens: estimateTokens(th.join('\n')) });

  // 7. 使用说明：告诉模型这些是记忆片段，不是当前发生的事
  const guidance = [
    '以上是你记得的事，不是现在正在发生的事。',
    '记忆是背景，不是回答的门槛：闲聊、常识、观点、假设性问题直接答，不要先声明"记忆里没有"。',
    '只有被问到过去的具体事实而记忆里确实没有时，才说一句"记不清"，然后继续聊。',
    '不要顺着问题里的前提承认记忆里没有的事（"我上次说……"不等于真的有）。宁可说没印象。',
    '日期越久远，细节越不可靠；不确定就说记不太清，不要补全细节。',
    '标注"已不成立"的是旧说法，不要当成事实。',
  ].join('\n');

  const body = sections
    .map((s) => (s.id === 'header' || s.id === 'guidance' ? s.text : `## ${labelOf(s.id)}\n${s.text}`))
    .join('\n\n');

  const text = `${body}\n\n${guidance}`;
  return {
    text,
    tokens: estimateTokens(text),
    sections: sections.map((s) => ({ id: s.id, tokens: s.tokens })),
    warnings,
  };
}

function labelOf(id) {
  return {
    persona: '你是谁',
    rules: '不可违背的约定',
    facts: '我记得的事实',
    changes: '最近的变化（旧说法，已不成立）',
    core: '长期记得的事',
    threads: '最近在聊的事',
  }[id] || id;
}

function renderHeader(now, lastSession) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (!lastSession?.lastMessageAt) return `现在是 ${today}。`;
  const gapDays = (now - lastSession.lastMessageAt) / 86_400_000;
  const gap =
    gapDays < 0.05 ? '刚刚还在聊' : gapDays < 1 ? '几小时前聊过' : `${Math.floor(gapDays)} 天前聊过`;
  return `现在是 ${today}。上次和用户说话是 ${gap}${lastSession.summary ? `，上次聊到：${lastSession.summary}` : ''}。`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
