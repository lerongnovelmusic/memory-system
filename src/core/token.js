// token 估算。真实 tokenizer 差异很大，这里只用保守近似：
// 中文 1 字 ≈ 0.75 token，英文 1 词 ≈ 1.3 token，标点 0.5。
// 所有容量判断都基于这个估算，宁可高估，别让她爆窗口。

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;

export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let latin = 0;
  let other = 0;
  let inWord = false;
  for (const ch of String(text)) {
    if (CJK.test(ch)) {
      cjk += 1;
      inWord = false;
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      if (!inWord) latin += 1;
      inWord = true;
    } else {
      if (!/\s/.test(ch)) other += 1;
      inWord = false;
    }
  }
  return Math.ceil(cjk * 0.75 + latin * 1.3 + other * 0.5);
}

/** 按 token 预算裁剪一组文本，返回装得下的前缀。 */
export function fitToBudget(items, maxTokens, tokensOf = (x) => estimateTokens(x)) {
  const out = [];
  let used = 0;
  for (const item of items) {
    const t = tokensOf(item);
    if (used + t > maxTokens) break;
    out.push(item);
    used += t;
  }
  return { items: out, used, dropped: items.length - out.length };
}
