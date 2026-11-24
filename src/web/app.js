// 单页前端。没有构建步骤，直接跑。
// 原则：所有来自记忆库的文本一律用 textContent 塞进去，不拼 HTML。

const state = {
  boot: null,
  sessionId: null,
  readOnly: false,
  view: 'chat',
  evalLoaded: false,
};

const $ = (id) => document.getElementById(id);

// 四层不是按时间排的，是按"有多确定它能留下来"排的。
const TIER_HINTS = {
  core: { name: '核心', desc: '人格、契约、身份级事件 · 每轮都注入' },
  warm: { name: '常用', desc: '这阵子用得上的 · 提到才注入' },
  cache2: { name: '待定', desc: '刚记下的，还没被时间检验 · 只在回忆时读' },
  l4: { name: '底层', desc: '来得最久的事 · 装不下才淘汰' },
  gone: { name: '已遗忘', desc: '被淘汰的，只剩一行墓碑' },
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDay(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------------- 启动 ----------------

async function boot() {
  const b = await api('/api/bootstrap');
  state.boot = b;
  state.sessionId = b.sessionId;

  $('tokenBadge').textContent = `常驻 ${b.boot.tokens} token`;
  $('modelBadge').textContent = b.hasModel ? '模型已接入' : '哑巴模式 · 点我配置';
  $('modelBadge').classList.toggle('dim', !b.hasModel);
  $('memoryPulse').textContent = `${b.stats.active} 条活记忆 · ${b.stats.byTier.core || 0} core · 向量 ${b.stats.embedding.vectors}`;
  const sch = b.schedule;
  $('scheduleLine').textContent = sch
    ? `每晚 ${sch.at} 巩固 · ${sch.lastRunDay ? `上次 ${sch.lastRunDay}` : '还没跑过'}${sch.paused ? ' · 已暂停' : ''}`
    : '每晚巩固：已关闭';
  if (sch) $('pauseBtn').textContent = sch.paused ? '恢复自动巩固' : '暂停自动巩固';

  renderSessions(b.sessions);
  await loadSession(b.sessionId, false);
  await loadMemory();
  const initial = location.hash.replace('#', '');
  if (initial === 'settings') openSettings();
  else if (initial && initial !== 'chat') switchView(initial, { syncHash: false });
}

function renderSessions(sessions) {
  const list = $('sessionList');
  list.replaceChildren();
  const todayId = state.boot.sessionId;
  const others = sessions.filter((s) => s.sessionId !== todayId).slice(0, 7);
  if (!others.length) {
    list.append(el('div', 'empty', '还没有历史会话'));
    return;
  }
  for (const s of others) {
    const btn = el('button', 'session');
    btn.dataset.id = s.sessionId;
    btn.append(el('span', 'dot'));
    const text = el('span', 'session-text', s.preview || s.sessionId);
    text.title = s.preview || '';
    btn.append(text);
    btn.append(el('span', 'meta', `${s.count}条 · ${fmtDay(s.end)}`));
    btn.addEventListener('click', () => loadSession(s.sessionId, true));
    list.append(btn);
  }
}

// ---------------- 会话 ----------------

async function loadSession(sessionId, readOnly) {
  state.sessionId = sessionId;
  state.readOnly = readOnly;
  const data = await api(`/api/session/${encodeURIComponent(sessionId)}`);
  state.readOnly = data.readOnly;
  renderMessages(data.turns);
  $('readonlyBanner').classList.toggle('hidden', !state.readOnly);
  $('composer').classList.toggle('hidden', state.readOnly);
  markActiveSession();
}

function markActiveSession() {
  $('sessionToday').classList.toggle('active', !state.readOnly);
  for (const b of document.querySelectorAll('#sessionList .session')) {
    b.classList.toggle('active', b.dataset.id === state.sessionId && state.readOnly);
  }
}

function renderMessages(turns) {
  const box = $('messages');
  box.replaceChildren();
  if (!turns.length) {
    box.append(el('div', 'msg system', '今天还没说话。她还记得的那些，都在右边的「记忆」里。'));
    return;
  }
  for (const t of turns) {
    const m = el('div', `msg ${t.role === 'user' ? 'user' : 'assistant'}`, t.text);
    m.append(el('span', 'meta', `${t.role === 'user' ? '用户' : '助手'} · ${fmtDate(t.ts)}`));
    box.append(m);
  }
  box.scrollTop = box.scrollHeight;
}

function appendMessage(role, text, meta) {
  const box = $('messages');
  if (box.querySelector('.msg.system') && box.children.length === 1) box.replaceChildren();
  const m = el('div', `msg ${role === 'user' ? 'user' : 'assistant'}`, text);
  if (meta) m.append(el('span', 'meta', meta));
  box.append(m);
  box.scrollTop = box.scrollHeight;
  return m;
}

async function send(text) {
  appendMessage('user', text);
  const pending = appendMessage('assistant', '…');
  try {
    const r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ text }) });
    pending.remove();
    const recall = r.recall?.count ? `想起 ${r.recall.count} 条（词法 ${r.recall.lexical} / 向量 ${r.recall.vector}）· ${r.contextTokens} token` : `没有翻到相关记忆 · ${r.contextTokens} token`;
    appendMessage('assistant', r.reply, `助手 · ${recall}`);
    if (r.degraded) {
      appendMessage('system', '注意：当前没有接模型，回答是降级输出。填 config.json 的 llm.apiKey 后重启即可。');
    }
  } catch (err) {
    pending.remove();
    appendMessage('system', `出错了：${err.message}`);
  }
}

// ---------------- 记忆 ----------------

async function loadMemory(q = '', tier = '') {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (tier) params.set('tier', tier);
  if ($('showTombstones')?.checked) params.set('tombstones', '1');
  const data = await api(`/api/memory?${params}`);
  renderStats(data.stats);
  renderEvents(data.events);
  $('pinQuota').textContent = `本周 pin ${data.stats.pinnedThisWeek} / 5`;
}

function renderStats(stats) {
  const cards = $('statCards');
  cards.replaceChildren();
  const items = [
    ['活记忆', stats.active, `共 ${stats.events} 条，含墓碑 ${stats.tombstone}`],
    ['core · 核心', stats.byTier.core || 0, TIER_HINTS.core.desc],
    ['warm · 常用', stats.byTier.warm || 0, TIER_HINTS.warm.desc],
    ['cache2 · 待定', stats.byTier.cache2 || 0, TIER_HINTS.cache2.desc],
    ['l4 · 底层', stats.byTier.l4 || 0, TIER_HINTS.l4.desc],
    ['事实', stats.facts, `被推翻 ${stats.factsSuperseded}`],
    ['已合并', stats.merged || 0, '并进别的记忆'],
    ['本周 pin', stats.pinnedThisWeek, '建议 3–5 条'],
    ['向量', stats.embedding.vectors, `${stats.embedding.provider} ${stats.embedding.dim}d`],
  ];
  for (const [k, v, s] of items) {
    const c = el('div', 'card');
    c.append(el('div', 'k', k));
    c.append(el('div', 'v', String(v)));
    c.append(el('div', 's', s));
    cards.append(c);
  }
}

function renderEvents(events) {
  const list = $('eventList');
  list.replaceChildren();
  if (!events.length) {
    list.append(el('div', 'empty', '没有匹配的记忆'));
    return;
  }
  for (const e of events.slice(0, 300)) {
    const row = el('div', `event${e.status === 'tombstone' ? ' tombstone' : ''}`);
    const line1 = el('div', 'line1');
    const hint = TIER_HINTS[e.tier];
    const pill = el('span', `pill ${e.tier}`, e.tier === 'gone' ? '已遗忘' : `${e.tier} · ${hint?.name || ''}`);
    pill.title = hint?.desc || '';
    line1.append(pill);
    if (e.pinned) line1.append(el('span', 'pill pinned', 'pin'));
    if (e.immortal) line1.append(el('span', 'pill immortal', '契约'));
    if (e.status === 'superseded') line1.append(el('span', 'pill superseded', '已失效'));
    if (e.status === 'tombstone') line1.append(el('span', 'pill gone', '墓碑'));
    line1.append(el('span', '', fmtDay(e.ts)));
    line1.append(el('span', '', `retain ${e.retain}`));
    if (!e.hasVector) line1.append(el('span', '', '无向量'));
    row.append(line1);
    row.append(el('div', 'summary', e.summary));
    row.addEventListener('click', () => showDetail(e.id));
    list.append(row);
  }
}

async function showDetail(id) {
  const d = await api(`/api/memory/${encodeURIComponent(id)}`);
  const box = $('detail');
  box.replaceChildren();
  const ev = d.event;
  box.append(el('h3', '', ev.summary));
  const rows = [
    ['层', ev.tier],
    ['状态', ev.status],
    ['retain', d.retain.toFixed(3)],
    ['identity', d.parts.identity.toFixed(2)],
    ['affect（衰减后）', d.parts.affectSlow.toFixed(2)],
    ['utility（衰减后）', d.parts.utilitySlow.toFixed(2)],
    ['激活度', d.parts.act.toFixed(2)],
    ['token', ev.tokens],
    ['创建', fmtDate(ev.ts)],
    ['摘要代数 gen', ev.gen],
    ['实体', (ev.entities || []).join(' / ') || '—'],
    ['向量', d.hasVector ? '有' : '无'],
  ];
  if (ev.quote) rows.push(['原话', `“${ev.quote}”`]);
  if (ev.supersededBy) rows.push(['被谁取代', ev.supersededBy]);
  for (const [k, v] of rows) {
    const r = el('div', 'row');
    r.append(el('span', '', k));
    r.append(el('span', '', String(v)));
    box.append(r);
  }
  if (d.moveHistory.length) {
    const head = el('div', 'row');
    head.append(el('span', '', '搬迁历史'));
    head.append(el('span', '', `${d.moveHistory.length} 次`));
    box.append(head);
    const pre = el('pre', '', d.moveHistory.map((m) => `${fmtDate(m.at)} ${m.from} → ${m.to} (${m.reason})`).join('\n'));
    box.append(pre);
  }

  if (ev.originalSummary && ev.originalSummary !== ev.summary) {
    const h = el('div', 'row');
    h.append(el('span', '', '最初的样子'));
    h.append(el('span', '', '未被覆盖'));
    box.append(h);
    box.append(el('pre', '', ev.originalSummary));
  }
  if (Array.isArray(ev.history) && ev.history.length) {
    box.append(
      el('pre', '', `改写历史 ${ev.history.length} 次：\n` + ev.history.map((h) => `· gen${h.gen} ${h.reason}：${h.summary}`).join('\n'))
    );
  }

  const actions = el('div', 'detail-actions');
  const pinBtn = el('button', ev.pinned ? 'ghost' : 'primary', ev.pinned ? '取消 pin' : '📌 永远记住');
  pinBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api(`/api/memory/${encodeURIComponent(ev.id)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned: !ev.pinned }),
    });
    await loadMemory($('memorySearch').value.trim(), $('tierFilter').value);
    showDetail(ev.id);
  });
  actions.append(pinBtn);

  if ((ev.history || []).length) {
    const restore = el('button', 'ghost', '恢复原文');
    restore.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/memory/${encodeURIComponent(ev.id)}/restore`, { method: 'POST', body: '{}' });
      await loadMemory($('memorySearch').value.trim(), $('tierFilter').value);
      showDetail(ev.id);
    });
    actions.append(restore);
  }
  box.append(actions);
}

// ---------------- 体检 ----------------

async function loadEvalPage() {
  try {
    const data = await api('/api/eval/latest');
    renderTrend(data.history || []);
    renderBaseline(data);
    if (data.report) renderEval(data.report, data);
    else $('evalResult').replaceChildren(el('div', 'empty', '还没跑过。点「跑一次体检」。'));
  } catch (err) {
    $('evalResult').replaceChildren(el('div', 'empty', `读取失败：${err.message}`));
  }
}

async function runEval(asBaseline = false) {
  const btn = asBaseline ? $('setBaseline') : $('runEval');
  const label = btn.textContent;
  const mode = $('evalMode').value;
  btn.disabled = true;
  btn.textContent = asBaseline ? '跑并锁定…' : '跑着呢…';
  $('evalResult').replaceChildren(
    el('div', 'empty', mode === 'full' ? '正在生成回答并判分，可能要一两分钟…' : '正在检索全库…')
  );
  try {
    const res = await fetch(asBaseline ? '/api/eval/baseline' : '/api/eval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const latest = await api('/api/eval/latest');
    renderTrend(latest.history || []);
    renderBaseline(latest);
    renderEval(latest.report, latest);
  } catch (err) {
    $('evalResult').replaceChildren(el('div', 'empty', `失败：${err.message}`));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function renderBaseline(data) {
  const box = $('evalBaseline');
  box.replaceChildren();
  if (!data.baseline) {
    box.append(el('span', 'hint', '还没有基线。跑一次满意的体检，点「跑一次并设为基线」。'));
    return;
  }
  const b = data.baseline;
  box.append(el('span', 'gate ok', `基线 ${fmtDate(b.at)} · ${b.mode} · ${(b.passRate * 100).toFixed(0)}%`));
  const diff = data.report?.diff;
  if (diff?.regressions?.length) {
    box.append(el('span', 'gate bad', `回归 ${diff.regressions.length} 条：${diff.regressions.map((x) => x.id).join('、')}`));
  } else if (diff) {
    box.append(el('span', 'gate ok', '无回归'));
  }
}

const SVGNS = 'http://www.w3.org/2000/svg';

function spark(rows, pick, { label, color, fmt }) {
  const wrap = el('div', 'spark');
  wrap.append(el('div', 'spark-label', label));
  const w = 520;
  const h = 72;
  const pad = 8;
  const vals = rows.map(pick);
  const max = Math.max(...vals, 0.0001);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'spark-svg');

  const pts = vals.map((v, i) => {
    const x = vals.length === 1 ? w / 2 : pad + (i / (vals.length - 1)) * (w - 2 * pad);
    const y = h - pad - (v / max) * (h - 2 * pad);
    return [x, y];
  });

  const base = document.createElementNS(SVGNS, 'line');
  base.setAttribute('x1', pad);
  base.setAttribute('x2', w - pad);
  base.setAttribute('y1', h - pad);
  base.setAttribute('y2', h - pad);
  base.setAttribute('stroke', '#1b3550');
  svg.append(base);

  const poly = document.createElementNS(SVGNS, 'polyline');
  poly.setAttribute('points', pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '));
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', color);
  poly.setAttribute('stroke-width', '1.6');
  poly.setAttribute('stroke-linejoin', 'round');
  svg.append(poly);

  rows.forEach((r, i) => {
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('cx', pts[i][0].toFixed(1));
    dot.setAttribute('cy', pts[i][1].toFixed(1));
    dot.setAttribute('r', '2.6');
    dot.setAttribute('fill', r.pass ? '#4fd1a5' : '#ff7b7b');
    svg.append(dot);
  });

  wrap.append(svg);
  wrap.append(el('div', 'spark-last', fmt(vals[vals.length - 1])));
  return wrap;
}

function renderTrend(history) {
  const box = $('evalTrend');
  box.replaceChildren();
  if (!history.length) {
    box.append(el('div', 'empty', '还没有历史。跑几次体检就能看到趋势。'));
    return;
  }
  box.append(spark(history, (r) => r.passRate, { label: '通过率', color: '#4aa8ff', fmt: (v) => `${(v * 100).toFixed(0)}%` }));
  box.append(spark(history, (r) => r.bootTokens, { label: '常驻 token', color: '#7fd6ff', fmt: (v) => `${v}` }));
  box.append(spark(history, (r) => r.p95, { label: '召回 p95 (ms)', color: '#f0b45f', fmt: (v) => `${v}ms` }));
}

function renderEval(report, ctx = {}) {
  const box = $('evalResult');
  box.replaceChildren();

  const head = el('div', 'eval-head');
  head.append(el('div', `eval-score ${report.pass ? 'pass' : 'fail'}`, `${(report.summary.passRate * 100).toFixed(0)}%`));
  head.append(el('div', '', `${report.pass ? 'PASS' : 'FAIL'} · ${report.mode} · 已判 ${report.summary.decided} 条，未判 ${report.summary.undecided} 条`));
  box.append(head);

  const g = report.gates || {};
  const th = report.thresholds || { passRate: 0.85 };
  const chips = [
    ['有判定', g.decided, `${report.summary.decided} 条`],
    [`通过率 ≥ ${(th.passRate * 100).toFixed(0)}%`, g.passRate, `${(report.summary.passRate * 100).toFixed(1)}%`],
    [`常驻 ≤ ${report.budget.limit}`, g.bootTokens, `${report.budget.bootTokens} token`],
    [`p95 ≤ ${report.latency.limit}ms`, g.latency, `${report.latency.p95}ms`],
    ['旧事实泄漏 = 0', g.superseded, `${report.supersededViolations} 条`],
  ];
  const gates = el('div', 'gates');
  for (const [name, ok, val] of chips) {
    const c = el('div', `gate ${ok ? 'ok' : 'bad'}`);
    c.append(el('span', '', ok ? '✔' : '✘'));
    c.append(el('span', '', name));
    c.append(el('span', 'gv', val));
    gates.append(c);
  }
  box.append(gates);

  if (report.supersededViolations) {
    box.append(el('div', 'banner', `旧事实泄漏 ${report.supersededViolations} 条 —— 硬性失败`));
  }

  for (const [cat, v] of Object.entries(report.summary.byCat)) {
    const row = el('div', 'cat');
    row.append(el('span', '', cat));
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = `${Math.round((v.rate ?? 0) * 100)}%`;
    if (v.rate == null) fill.style.opacity = '0.15';
    bar.append(fill);
    row.append(bar);
    row.append(el('span', '', v.rate == null ? '—' : `${v.pass}/${v.pass + v.fail}`));
    box.append(row);
  }

  const list = el('div', '');
  for (const r of report.results) {
    const p = el('div', 'probe');
    p.append(el('span', r.pass === true ? 'ok' : r.pass === false ? 'no' : '', r.pass === true ? '✔' : r.pass === false ? '✘' : '·'));
    p.append(el('span', 'q', r.question || r.id));
    p.append(el('span', '', r.reason || ''));
    if (r.answer) {
      const ans = el('div', 'probe-answer', `她答：${String(r.answer).slice(0, 160)}`);
      p.append(ans);
    }
    list.append(p);
  }
  box.append(list);
}

// ---------------- 事件绑定 ----------------

function switchView(view, { syncHash = true } = {}) {
  state.view = view;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === view);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${view}`);
  if (syncHash) history.replaceState(null, '', `#${view}`);
  if (view === 'memory') loadMemory($('memorySearch').value.trim(), $('tierFilter').value);
  if (view === 'eval' && !state.evalLoaded) {
    state.evalLoaded = true;
    loadEvalPage();
  }
}

window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#', '');
  if (v && v !== state.view) switchView(v, { syncHash: false });
});

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

$('sessionToday').addEventListener('click', () => {
  if (state.boot) loadSession(state.boot.sessionId, false);
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  send(text);
});

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
});

let searchTimer = null;
$('memorySearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadMemory($('memorySearch').value.trim(), $('tierFilter').value), 250);
});
$('tierFilter').addEventListener('change', () => loadMemory($('memorySearch').value.trim(), $('tierFilter').value));
$('runEval').addEventListener('click', () => runEval(false));
$('setBaseline').addEventListener('click', () => runEval(true));

// ---------------- 巩固 / 急停 ----------------

async function consolidateNow() {
  const btn = $('consolidateBtn');
  btn.disabled = true;
  btn.textContent = '巩固中…';
  try {
    const r = await api('/api/consolidate', { method: 'POST', body: '{}' });
    if (r.skipped) {
      $('pinQuota').textContent = '没有新的对话需要巩固';
    } else {
      const rep = r.report;
      $('pinQuota').textContent = `新增 ${rep.newEvents} 条事件 · ${rep.newFacts} 条事实 · 合并 ${rep.merges?.length || 0} · 搬迁 ${rep.moves.length}`;
    }
    const b = await api('/api/bootstrap');
    state.boot = b;
    $('tokenBadge').textContent = `常驻 ${b.boot.tokens} token`;
    await loadMemory($('memorySearch').value.trim(), $('tierFilter').value);
  } catch (err) {
    $('pinQuota').textContent = `失败：${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '立即巩固';
  }
}

async function togglePause() {
  const paused = !state.boot?.schedule?.paused;
  try {
    const s = await api('/api/schedule/pause', { method: 'POST', body: JSON.stringify({ paused }) });
    if (state.boot) state.boot.schedule = s;
    $('pauseBtn').textContent = s.paused ? '恢复自动巩固' : '暂停自动巩固';
    $('scheduleLine').textContent = `每晚 ${s.at} 巩固${s.lastRunDay ? ` · 上次 ${s.lastRunDay}` : ''}${s.paused ? ' · 已暂停' : ''}`;
    $('pinQuota').textContent = s.paused ? '自动巩固已暂停（「立即巩固」仍然可用）' : '自动巩固已恢复';
  } catch (err) {
    $('pinQuota').textContent = `失败：${err.message}`;
  }
}

$('consolidateBtn').addEventListener('click', consolidateNow);
$('pauseBtn').addEventListener('click', togglePause);
$('showTombstones').addEventListener('change', () =>
  loadMemory($('memorySearch').value.trim(), $('tierFilter').value)
);

// ---------------- 设置 ----------------

function cfgMsg(text, kind = '') {
  const box = $('cfgMsg');
  box.textContent = text || '';
  box.className = `cfg-msg ${kind}`;
}

async function openSettings() {
  $('settingsModal').classList.remove('hidden');
  cfgMsg('');
  try {
    const c = await api('/api/config');
    $('cfgBase').value = c.llm.baseUrl || '';
    $('cfgModel').value = c.llm.model || '';
    $('cfgKey').value = '';
    $('cfgKey').placeholder = c.llm.hasKey ? `已保存 ${c.llm.keyMask}，留空则不修改` : 'sk-...';
    if (c.llm.fromEnv) cfgMsg('当前 key 来自环境变量 DEEPSEEK_API_KEY', 'ok');
  } catch (err) {
    cfgMsg(`读取配置失败：${err.message}`, 'err');
  }
}

function closeSettings() {
  $('settingsModal').classList.add('hidden');
}

async function saveConfig() {
  const body = { llm: { baseUrl: $('cfgBase').value.trim(), model: $('cfgModel').value.trim() } };
  const key = $('cfgKey').value.trim();
  if (key) body.llm.apiKey = key;
  cfgMsg('保存中…');
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
    $('modelBadge').textContent = r.hasModel ? '模型已接入' : '哑巴模式 · 点我配置';
    $('modelBadge').classList.toggle('dim', !r.hasModel);
    $('cfgKey').value = '';
    if (r.keyMask) $('cfgKey').placeholder = `已保存 ${r.keyMask}，留空则不修改`;
    cfgMsg(r.hasModel ? '已保存，模型已接入。可以点「测试连接」验证。' : '已保存，但还没有 key。', r.hasModel ? 'ok' : 'err');
  } catch (err) {
    cfgMsg(`保存失败：${err.message}`, 'err');
  }
}

async function testConfig() {
  cfgMsg('测试中…');
  try {
    const r = await api('/api/config/test', { method: 'POST', body: '{}' });
    if (r.ok) cfgMsg(`通了：${r.ms}ms，返回「${r.sample}」`, 'ok');
    else cfgMsg(`失败：${r.error}`, 'err');
  } catch (err) {
    cfgMsg(`失败：${err.message}`, 'err');
  }
}

$('settingsBtn').addEventListener('click', openSettings);
$('modelBadge').addEventListener('click', openSettings);
$('cfgClose').addEventListener('click', closeSettings);
$('cfgSave').addEventListener('click', saveConfig);
$('cfgTest').addEventListener('click', testConfig);
$('settingsModal').addEventListener('click', (e) => {
  if (e.target.id === 'settingsModal') closeSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});

boot().catch((err) => {
  document.body.append(el('div', 'banner', `启动失败：${err.message}`));
});
