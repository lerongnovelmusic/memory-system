// 记忆体检。两种模式：
//   dry  —— 只跑检索与预算，不生成回答，成本≈0，每晚巩固后跑
//   full —— 真跑回答与判分，每周一次
//
// 隔离：必须跑在记忆快照 + 空会话上。这里通过 contextFor() 保证
// 上下文只来自记忆系统，不掺当前会话历史。

import fs from 'node:fs';
import path from 'node:path';
import { ruleJudge, summarize } from './judge.js';

export function loadProbes(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (const line of lines) {
      const s = line.trim();
      if (!s || s.startsWith('//')) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        // 坏探针直接忽略，但记一笔
        out.push({ id: `bad_${f}_${out.length}`, cat: 'misc', parseError: true });
      }
    }
  }
  return out;
}

export async function runEval({ engine, llm = null, probes, mode = 'dry', now = Date.now() }) {
  const boot = engine.boot({ now });
  const budgetLimit = 4500;
  const results = [];
  const latencies = [];

  for (const probe of probes) {
    const t0 = performance.now();
    const r = await engine.recall(probe.q || '', { now });
    const ms = performance.now() - t0;
    latencies.push(ms);

    const recalledIds = r.picked.map((p) => p.ev.id);
    const ctx = await engine.contextFor({ query: probe.q || '', now });

    const base = {
      id: probe.id,
      cat: probe.cat,
      weight: probe.weight ?? 1,
      question: probe.q,
      recalledIds,
      recallTokens: r.tokens,
    };

    // 检索层断言（dry 也能判）
    if (probe.expect?.eventIds?.length) {
      const hit = probe.expect.eventIds.some((id) => recalledIds.includes(id));
      results.push({ ...base, pass: hit, reason: hit ? '检索命中' : `检索未命中（期望 ${probe.expect.eventIds.join(',')}）`, source: 'retrieval' });
      continue;
    }
    if (probe.expect?.forbidEventIds?.length) {
      const bad = probe.expect.forbidEventIds.filter((id) => recalledIds.includes(id));
      results.push({ ...base, pass: bad.length === 0, reason: bad.length ? `注入了已失效事件 ${bad.join(',')}` : '未注入已失效事件', source: 'retrieval' });
      continue;
    }

    if (mode === 'dry') {
      results.push({ ...base, pass: null, reason: 'dry 模式不判语义', source: 'retrieval' });
      continue;
    }

    if (!llm?.answer) {
      results.push({ ...base, pass: null, reason: '没有 LLM，无法判语义', source: 'retrieval' });
      continue;
    }

    let answer = '';
    try {
      answer = await llm.answer({ context: ctx.text, question: probe.q });
    } catch (err) {
      results.push({ ...base, pass: false, reason: `生成失败：${err.message}`, source: 'llm' });
      continue;
    }

    let verdict = ruleJudge(probe, answer);
    if (verdict.pass === null && probe.expect?.rubric && llm.judge) {
      const j = await llm.judge({ question: probe.q, answer, rubric: probe.expect.rubric });
      verdict = { ...j, source: 'llm' };
    }
    results.push({ ...base, answer, pass: verdict.pass, reason: verdict.reason, source: verdict.source });
  }

  const summary = summarize(results);
  const supersededViolations = results.filter((r) => r.cat === 'superseded' && r.pass === false).length;
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const p95 = sortedLat.length ? sortedLat[Math.floor(sortedLat.length * 0.95)] : 0;

  const report = {
    at: now,
    mode,
    summary,
    supersededViolations,
    budget: { bootTokens: boot.tokens, limit: budgetLimit, ok: boot.tokens <= budgetLimit, sections: boot.sections },
    warnings: boot.warnings,
    latency: { p50: median(sortedLat), p95: Number(p95.toFixed(1)) },
    pass: summary.decided > 0 && summary.passRate >= engine.cfg.eval.overallPass && supersededViolations === 0,
    results,
  };
  return report;
}

function median(arr) {
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return Number((arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2).toFixed(1));
}

/** 与基线比对：只在 pass→fail 时告警。 */
export function diffBaseline(report, baseline) {
  if (!baseline) return { regressions: [], improvements: [], message: '无基线' };
  const prev = new Map(baseline.results.map((r) => [r.id, r.pass]));
  const regressions = [];
  const improvements = [];
  for (const r of report.results) {
    const before = prev.get(r.id);
    if (before === true && r.pass === false) regressions.push({ id: r.id, cat: r.cat, reason: r.reason });
    if (before === false && r.pass === true) improvements.push({ id: r.id, cat: r.cat });
  }
  return {
    regressions,
    improvements,
    message: regressions.length ? `回归 ${regressions.length} 条` : '无回归',
  };
}
