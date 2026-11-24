#!/usr/bin/env node
// memctl —— 记忆系统的命令行入口。
// 不依赖任何第三方包，直接 node bin/memctl.js <命令>

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Engine } from '../src/core/engine.js';
import { createHeuristicLLM } from '../src/llm/stub.js';
import { createOpenAILLM } from '../src/llm/openai.js';
import { loadProbes, runEval, diffBaseline } from '../src/core/eval.js';
import { estimateTokens } from '../src/core/token.js';
import { ensureEmbeddings, readMeta } from '../src/core/embeddings.js';

const ROOT = process.cwd();

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeLLM(config, { forceLocal = false } = {}) {
  if (forceLocal) return createHeuristicLLM();
  const apiKey = config.llm?.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('· 没有 API key，使用离线抽取器（仅用于跑通流程）');
    return createHeuristicLLM();
  }
  return createOpenAILLM({
    apiKey,
    baseUrl: config.llm?.baseUrl,
    model: config.llm?.model,
  });
}

function engineFor(config, { local = false } = {}) {
  const root = path.join(ROOT, config.dataDir || 'data');
  return new Engine({ root, config, llm: makeLLM(config, { forceLocal: local }) });
}

const commands = {
  init({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    engine.store.ensure();
    if (!engine.store.exists('persona.md')) {
      engine.store.writeText('persona.md', '# 你是谁\n\n（在这里写她的人格。每轮都注入，控制在 600 token 内。）\n');
    }
    if (!engine.store.exists('rules.md')) {
      engine.store.writeText('rules.md', '# 不可违背的约定\n\n（契约类内容写这里：永驻、不参与淘汰、不可被自动推翻。）\n');
    }
    console.log(`初始化完成：${engine.root}`);
    console.log('下一步：node bin/memctl.js seed --from ./seed');
  },

  seed({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    const from = path.resolve(ROOT, args.from || 'seed');
    if (!fs.existsSync(from)) {
      console.error(`找不到种子目录：${from}`);
      process.exit(1);
    }
    for (const f of ['persona.md', 'rules.md']) {
      const src = path.join(from, f);
      if (fs.existsSync(src)) {
        engine.store.writeText(f, fs.readFileSync(src, 'utf8'));
        console.log(`· ${f} 已载入`);
      }
    }
    const evFile = path.join(from, 'core-events.jsonl');
    if (fs.existsSync(evFile)) {
      const events = fs
        .readFileSync(evFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//'))
        .map((l) => JSON.parse(l));
      engine.store.writeJsonl('events.jsonl', events);
      console.log(`· 核心事件 ${events.length} 条`);
    }
    console.log('种子载入完成。');
  },

  capture({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    const role = args.role || 'user';
    const text = args.text || args._.join(' ') || '';
    const sessionId = args.session || `s_${new Date().toISOString().slice(0, 10)}`;
    const turn = engine.capture({ role, text, sessionId });
    console.log(`已捕获 ${turn.turnId}（${role}, ${estimateTokens(text)} token）`);
  },

  async consolidate({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: Boolean(args.local) });
    const out = await engine.consolidate({ dryRun: Boolean(args['dry-run']) });
    if (out.skipped) {
      console.log(`无需巩固：${out.reason}`);
      return;
    }
    console.log(JSON.stringify(out.report, null, 2));
  },

  async boot({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    const boot = await engine.boot();
    console.log(boot.text);
    console.log(`\n--- ${boot.tokens} token（预算 4500） ---`);
    for (const s of boot.sections) console.log(`  ${s.id}: ${s.tokens}`);
    for (const w of boot.warnings) console.log(`  ! ${w}`);
  },

  async recall({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    const q = args._.join(' ') || args.q;
    const r = await engine.recall(q);
    for (const p of r.picked) {
      const why = p.via?.length ? `(${p.via.join('+')})` : '';
      console.log(`${p.score.toFixed(3)}  ${p.ev.id}  [${p.ev.tier}]  ${why}  ${p.ev.summary}`);
    }
    console.log(`\n${r.picked.length} 条，${r.tokens} token，候选 ${r.considered} 条`);
  },

  stats({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    console.log(JSON.stringify(engine.stats(), null, 2));
  },

  sessions({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    for (const s of engine.sessions(Number(args.limit || 7))) {
      console.log(`${s.sessionId}  ${new Date(s.end).toLocaleString('zh-CN')}  ${s.count} 条  ${s.preview}`);
    }
  },

  inspect({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    const id = args._[0];
    const { events } = engine.load();
    const ev = events.find((e) => e.id === id);
    if (!ev) {
      console.error(`找不到事件 ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(ev, null, 2));
  },

  async embed({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: false });
    const { events } = engine.load();
    const before = readMeta(engine.store);
    const out = await ensureEmbeddings({ store: engine.store, events, embedder: engine.embedder });
    const after = readMeta(engine.store);
    console.log(`向量：${engine.embedder.name} (${engine.embedder.dim}d)`);
    if (before && (before.provider !== after?.provider || before.dim !== after?.dim)) {
      console.log(`  已从旧向量切换：${before.provider}/${before.dim}d → ${after?.provider}/${after?.dim}d（旧向量整体作废）`);
    }
    console.log(`  新算 ${out.added} 条，复用 ${out.reused} 条，共 ${out.map.size} 条`);
  },

  pin({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    const id = args._[0];
    if (!id) {
      console.error('用法：memctl pin <event-id> [--unpin]');
      process.exit(1);
    }
    const next = engine.setPinned(id, !args.unpin);
    if (!next) {
      console.error(`找不到事件 ${id}`);
      process.exit(1);
    }
    console.log(`${next.id} pinned=${next.pinned}`);
  },

  backup({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    const dir = engine.store.snapshot(args.label || 'manual');
    console.log(`已备份到 ${dir}`);
  },

  rollback({ args }) {
    const config = loadConfig();
    const engine = engineFor(config, { local: true });
    const list = engine.listSnapshots();
    if (!list.length) {
      console.error('没有可用快照');
      process.exit(1);
    }
    const name = args.snapshot || list[0].name;
    console.log(`回滚到 ${name}（回滚前会再拍一张 pre-rollback）`);
    const out = engine.restoreSnapshot(name);
    console.log(`已恢复 ${out.restored.length} 个文件：${out.restored.join(', ')}`);
  },

  async eval({ args }) {
    const config = loadConfig();
    const mode = args.mode || 'dry';
    const engine = engineFor(config, { local: mode !== 'full' });
    const probes = loadProbes(path.join(ROOT, config.probesDir || 'probes'));
    if (!probes.length) {
      console.error('没有探针：请在 probes/*.jsonl 里写探针');
      process.exit(1);
    }
    const report = await runEval({ engine, llm: mode === 'full' ? engine.llm : null, probes, mode });
    const outDir = path.join(engine.root, 'eval');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(outDir, `report-${stamp}.json`), JSON.stringify(report, null, 2));

    const baselinePath = path.join(engine.root, 'eval', 'baseline.json');
    const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
    const diff = diffBaseline(report, baseline);

    console.log(`模式 ${mode} · 通过率 ${(report.summary.passRate * 100).toFixed(1)}% · ${report.pass ? 'PASS' : 'FAIL'}`);
    for (const [cat, v] of Object.entries(report.summary.byCat)) {
      const rate = v.rate == null ? '  — ' : `${(v.rate * 100).toFixed(0)}%`.padStart(4);
      console.log(`  ${cat.padEnd(14)} ${String(v.pass).padStart(2)}/${v.pass + v.fail}  ${rate}   未判 ${v.unknown}`);
    }
    if (report.summary.undecided) console.log(`  未判 ${report.summary.undecided} 条（dry 模式只判检索层）`);
    console.log(`  启动上下文 ${report.budget.bootTokens} token（上限 ${report.budget.limit}）`);
    console.log(`  召回 p95 ${report.latency.p95}ms`);
    if (report.supersededViolations) console.log(`  !! 旧事实泄漏 ${report.supersededViolations} 条 —— 硬性失败`);
    if (diff.regressions.length) console.log(`  回归：${diff.regressions.map((r) => r.id).join(', ')}`);
    if (args['set-baseline'] && report.pass) {
      fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2));
      console.log('  已锁定基线');
    }
  },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = commands[cmd];
  if (!fn) {
    console.log(`memctl —— 用法：
  init                              初始化数据目录
  seed --from ./seed                载入人格/契约/核心事件
  capture --role user --text "…"    落盘一轮对话
  consolidate [--local] [--dry-run] 夜间巩固
  boot                              打印启动上下文
  recall "…"                        回忆检索
  stats                             统计
  sessions                          最近会话
  inspect <event-id>                看单条事件
  embed                             重建向量（换 provider 后跑一次）
  pin <event-id> [--unpin]          人工闸：永远记住 / 取消
  backup [--label 名称]             手动备份
  rollback [--snapshot 名称]        回滚到某个快照
  eval --mode dry|full [--set-baseline]  记忆体检`);
    process.exit(1);
  }
  try {
    await fn({ args: parseArgs(rest) });
  } catch (err) {
    console.error(`错误：${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
