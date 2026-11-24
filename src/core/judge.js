// 判分：规则优先，LLM 兜底，人工仲裁。
// 规则能覆盖七成探针，出来的分数才是稳定的、可比的、免费的。

export function ruleJudge(probe, answer) {
  const a = String(answer || '');
  const must = probe.expect?.must_include || [];
  const mustNot = probe.expect?.must_not_include || [];

  const bad = mustNot.filter((s) => a.includes(s));
  if (bad.length) {
    return { pass: false, reason: `出现了不该出现的：${bad.join('、')}`, source: 'rule' };
  }
  const missing = must.filter((s) => !a.includes(s));
  if (missing.length) {
    return { pass: false, reason: `缺少：${missing.join('、')}`, source: 'rule' };
  }
  if (!must.length && !mustNot.length) {
    return { pass: null, reason: '仅 rubric 判定', source: 'rule' };
  }
  return { pass: true, reason: '规则通过', source: 'rule' };
}

/**
 * 汇总。通过率只在"已判定"的探针上算 —— dry 模式不判语义，
 * 把未判的探针算成失败会让分数毫无意义。
 */
export function summarize(results) {
  const byCat = {};
  let wPass = 0;
  let wDecided = 0;
  let decided = 0;
  let undecided = 0;
  let fails = 0;

  for (const r of results) {
    const cat = r.cat || 'misc';
    const w = r.weight ?? 1;
    byCat[cat] ||= { total: 0, pass: 0, fail: 0, unknown: 0 };
    byCat[cat].total += 1;

    if (r.pass === true) {
      byCat[cat].pass += 1;
      wPass += w;
      wDecided += w;
      decided += 1;
    } else if (r.pass === false) {
      byCat[cat].fail += 1;
      wDecided += w;
      decided += 1;
      fails += 1;
    } else {
      byCat[cat].unknown += 1;
      undecided += 1;
    }
  }

  for (const v of Object.values(byCat)) {
    const judged = v.pass + v.fail;
    v.rate = judged ? Number((v.pass / judged).toFixed(3)) : null;
  }

  return {
    total: results.length,
    decided,
    undecided,
    fails,
    passRate: wDecided ? Number((wPass / wDecided).toFixed(3)) : 0,
    byCat,
  };
}
