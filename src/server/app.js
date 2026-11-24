// 本地 HTTP 服务。只绑 127.0.0.1，不对外。
// 职责：今天的会话、只读的历史会话、记忆检查器、记忆体检。
// 所有记忆读写都经由 Engine，服务层不直接碰文件。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../core/engine.js';
import { createHeuristicLLM } from '../llm/stub.js';
import { createOpenAILLM } from '../llm/openai.js';
import { dayKey, nowMs } from '../core/time.js';
import { loadProbes, runEval, diffBaseline } from '../core/eval.js';
import { startScheduler } from '../core/schedule.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export function llmFromConfig(config = {}) {
  const apiKey = config.llm?.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return createHeuristicLLM();
  return createOpenAILLM({ apiKey, baseUrl: config.llm?.baseUrl, model: config.llm?.model });
}

export function createEngine({ root, config = {} }) {
  return new Engine({ root, config, llm: llmFromConfig(config) });
}

function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function todaySessionId(engine, now = nowMs()) {
  return `s_${dayKey(now, { tz: engine.cfg.tz, cutoffHour: engine.cfg.dayCutoffHour })}`;
}

function lastSessionInfo(engine, currentId) {
  const list = engine.sessions(8).filter((s) => s.sessionId !== currentId);
  if (!list.length) return null;
  const prev = list[0];
  return { lastMessageAt: prev.end, summary: prev.preview || '' };
}

export function startServer({ root, config = {}, port = 8787, host = '127.0.0.1' } = {}) {
  const engine = createEngine({ root, config });

  // 底线：第一次跑之前先留一份基线，之后任何一轮巩固都能退回来。
  if (engine.listSnapshots().length === 0) {
    try {
      engine.store.snapshot('baseline');
    } catch {
      /* 空库时失败无妨 */
    }
  }

  const scheduler = config.schedule?.enabled === false
    ? null
    : startScheduler({
        engine,
        at: config.schedule?.at || '04:30',
        onReport: (r) => console.log(`[巩固] ${new Date(r.at).toLocaleString('zh-CN')} 新事件 ${r.newEvents} / 晋升 ${r.promoted}`),
      });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        return await handleApi({ engine, scheduler, req, res, url });
      }
      return serveStatic(url.pathname, res);
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message || err) });
    }
  });

  server.listen(port, host, () => {
    const addr = server.address();
    console.log(`大肥鱼的记忆系统 · http://${addr.address}:${addr.port}`);
    if (host === '0.0.0.0' || host === '::') {
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const n of list || []) {
          if (n.family === 'IPv4' && !n.internal) console.log(`  局域网（${name}）：http://${n.address}:${addr.port}  ← 手机用这个`);
        }
      }
      console.log('  注意：没有登录鉴权，只在自家网络里开。');
    }
    console.log(`记忆库：${engine.root}`);
    console.log(`抽取器：${engine.llm?.name || (typeof engine.llm?.answer === 'function' ? 'openai' : 'heuristic')}`);
    console.log(`向量：${engine.embedder.name} (${engine.embedder.dim}d)`);
    console.log(
      scheduler
        ? `每晚巩固：${config.schedule?.at || '04:30'}（没开机就下次启动补跑）`
        : '每晚巩固：已关闭'
    );
  });
  return server;
}

async function handleApi({ engine, scheduler, req, res, url }) {
  const p = url.pathname;

  if (p === '/api/bootstrap' && req.method === 'GET') {
    const sessionId = todaySessionId(engine);
    const sessions = engine.sessions(7);
    const stats = engine.stats();
    const boot = engine.boot({ lastSession: lastSessionInfo(engine, sessionId) });
    return sendJson(res, 200, {
      sessionId,
      sessions,
      stats,
      boot: { tokens: boot.tokens, sections: boot.sections, warnings: boot.warnings },
      hasModel: typeof engine.llm?.answer === 'function',
      today: dayKey(nowMs(), { tz: engine.cfg.tz, cutoffHour: engine.cfg.dayCutoffHour }),
      schedule: scheduler?.status() || null,
    });
  }

  if (p === '/api/session/current' && req.method === 'GET') {
    const sessionId = todaySessionId(engine);
    return sendJson(res, 200, { sessionId, turns: engine.sessionTurns(sessionId) });
  }

  if (p.startsWith('/api/session/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/session/'.length));
    const current = todaySessionId(engine);
    return sendJson(res, 200, { sessionId: id, readOnly: id !== current, turns: engine.sessionTurns(id) });
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: '空消息' });
    const sessionId = todaySessionId(engine);
    const now = nowMs();
    const userTurn = engine.capture({ role: 'user', text, sessionId, ts: now });
    const ctx = await engine.contextFor({ query: text, now, lastSession: lastSessionInfo(engine, sessionId) });
    const reply = await answer(engine, ctx, text);
    engine.capture({ role: 'assistant', text: reply.text, sessionId, ts: now + 1 });
    return sendJson(res, 200, {
      sessionId,
      reply: reply.text,
      degraded: reply.degraded || false,
      recall: ctx.recall,
      contextTokens: ctx.tokens,
      bootTokens: ctx.boot.tokens,
      userTurnId: userTurn.turnId,
    });
  }

  if (p === '/api/memory' && req.method === 'GET') {
    const { events, facts, vectors } = engine.load();
    const now = nowMs();
    const q = url.searchParams.get('q') || '';
    const tier = url.searchParams.get('tier') || '';
    const wantTomb = url.searchParams.get('tombstones') === '1';
    let list = events.filter((e) =>
      wantTomb ? e.status !== 'merged' : e.status === 'active' || e.status === 'superseded'
    );
    if (tier) list = list.filter((e) => e.tier === tier);
    if (q) {
      const hits = await engine.recall(q, { now });
      list = hits.picked.map((x) => x.ev);
    }
    const { computeRetain } = await import('../core/score.js');
    const rows = list
      .map((e) => ({
        id: e.id,
        tier: e.tier,
        status: e.status,
        ts: e.ts,
        summary: e.summary,
        quote: e.quote,
        score: e.score,
        retain: Number(computeRetain(e, now, engine.cfg).retain.toFixed(3)),
        tokens: e.tokens,
        entities: e.entities,
        immortal: e.immortal,
        hasVector: vectors.has(e.id),
      }))
      .sort((a, b) => b.retain - a.retain);
    return sendJson(res, 200, {
      stats: engine.stats(),
      events: rows,
      facts: facts.filter((f) => f.status === 'active'),
    });
  }

  const pinMatch = /^\/api\/memory\/([^/]+)\/pin$/.exec(p);
  if (pinMatch && req.method === 'POST') {
    const body = await readJson(req);
    const id = decodeURIComponent(pinMatch[1]);
    const next = engine.setPinned(id, body.pinned !== false);
    if (!next) return sendJson(res, 404, { error: '没有这条记忆' });
    return sendJson(res, 200, { ok: true, id, pinned: next.pinned, pinnedAt: next.pinnedAt });
  }

  const restoreMatch = /^\/api\/memory\/([^/]+)\/restore$/.exec(p);
  if (restoreMatch && req.method === 'POST') {
    const id = decodeURIComponent(restoreMatch[1]);
    const next = engine.restoreOriginal(id);
    if (!next) return sendJson(res, 404, { error: '没有这条记忆' });
    return sendJson(res, 200, { ok: true, id, summary: next.summary, gen: next.gen });
  }

  if (p === '/api/snapshots' && req.method === 'GET') {
    return sendJson(res, 200, { snapshots: engine.listSnapshots() });
  }

  if (p === '/api/rollback' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const out = engine.restoreSnapshot(String(body.name || ''));
      return sendJson(res, 200, { ok: true, ...out });
    } catch (err) {
      return sendJson(res, 400, { error: String(err.message || err) });
    }
  }

  if (p === '/api/schedule/pause' && req.method === 'POST') {
    if (!scheduler) return sendJson(res, 400, { error: '自动巩固已关闭' });
    const body = await readJson(req);
    return sendJson(res, 200, scheduler.setPaused(body.paused !== false));
  }

  if (p.startsWith('/api/memory/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/memory/'.length));
    const detail = engine.explain(id);
    if (!detail) return sendJson(res, 404, { error: '没有这条记忆' });
    return sendJson(res, 200, detail);
  }

  if (p === '/api/consolidate' && req.method === 'POST') {
    const out = await engine.consolidate({});
    return sendJson(res, 200, out.skipped ? { skipped: true, reason: out.reason } : { skipped: false, report: out.report });
  }

  if (p === '/api/eval' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const mode = body.mode === 'full' ? 'full' : 'dry';
    const probes = loadProbes(path.join(engine.root, '..', 'probes'));
    const out = await runProbes(engine, probes, mode);
    return sendJson(res, out.error ? 400 : 200, out);
  }

  if (p === '/api/eval/latest' && req.method === 'GET') {
    const probes = loadProbes(path.join(engine.root, '..', 'probes'));
    const mode = url.searchParams.get('mode') === 'full' ? 'full' : 'dry';
    const out = await runProbes(engine, probes, mode);
    return sendJson(res, out.error ? 400 : 200, out);
  }

  if (p === '/api/schedule' && req.method === 'GET') {
    return sendJson(res, 200, scheduler?.status() || { enabled: false });
  }

  if (p === '/api/config' && req.method === 'GET') {
    const cfgPath = path.join(path.dirname(engine.root), 'config.json');
    const cur = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
    return sendJson(res, 200, {
      llm: {
        baseUrl: cur.llm?.baseUrl || 'https://api.deepseek.com',
        model: cur.llm?.model || 'deepseek-chat',
        hasKey: Boolean(cur.llm?.apiKey || process.env.DEEPSEEK_API_KEY),
        keyMask: maskKey(cur.llm?.apiKey || process.env.DEEPSEEK_API_KEY),
        fromEnv: !cur.llm?.apiKey && Boolean(process.env.DEEPSEEK_API_KEY),
      },
      embedding: { provider: engine.embedder.name, dim: engine.embedder.dim },
    });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const body = await readJson(req);
    const cfgPath = path.join(path.dirname(engine.root), 'config.json');
    const cur = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
    const next = { ...cur, llm: { ...(cur.llm || {}) } };
    for (const k of ['apiKey', 'baseUrl', 'model']) {
      if (typeof body.llm?.[k] === 'string') next.llm[k] = body.llm[k].trim();
    }
    if (!next.llm.apiKey) delete next.llm.apiKey;
    fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2));
    engine.llm = llmFromConfig(next);
    return sendJson(res, 200, {
      ok: true,
      hasModel: typeof engine.llm?.answer === 'function',
      keyMask: maskKey(next.llm?.apiKey),
    });
  }

  if (p === '/api/config/test' && req.method === 'POST') {
    if (typeof engine.llm?.answer !== 'function') {
      return sendJson(res, 400, { error: '还没配置 API key' });
    }
    try {
      const t0 = Date.now();
      const sample = await engine.llm.answer({ context: '你是测试助手，只回复 OK。', question: '回复 OK' });
      return sendJson(res, 200, { ok: true, ms: Date.now() - t0, sample: String(sample).slice(0, 40) });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err?.message || err).slice(0, 200) });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

async function runProbes(engine, probes, mode = 'dry') {
  if (!probes.length) return { error: '没有探针' };
  if (mode === 'full' && typeof engine.llm?.answer !== 'function') {
    return { error: 'full 模式需要接模型：在 config.json 填 llm.apiKey 后重启' };
  }
  const report = await runEval({ engine, llm: mode === 'full' ? engine.llm : null, probes, mode });
  return { report, at: Date.now() };
}

async function answer(engine, ctx, question) {
  if (typeof engine.llm?.answer === 'function') {
    const text = await engine.llm.answer({ context: ctx.text, question });
    return { text };
  }
  // 哑巴模式：没接模型时，也不假装能聊。诚实地说清楚自己想起了什么。
  const lines = ctx.recall.count
    ? `（还没接模型，我只能把想起来的念给你听：这轮翻到 ${ctx.recall.count} 条记忆，上下文 ${ctx.tokens} token。填好 config.json 里的 llm.apiKey 我就能真的说话了。）`
    : `（还没接模型。这轮什么都没翻到，上下文 ${ctx.tokens} token。填好 config.json 里的 llm.apiKey 我就能真的说话了。）`;
  return { text: lines, degraded: true };
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB)) return sendJson(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
