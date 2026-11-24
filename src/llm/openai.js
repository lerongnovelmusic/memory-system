// OpenAI 兼容的抽取器（DeepSeek / 任何 /v1/chat/completions 都行）。
// 要求严格 JSON；解析失败重试 2 次，仍失败抛错 —— 让巩固停在原地，不静默跳过。

const SYSTEM = `你把对话整理成"记忆事件"。只输出 JSON，不要解释。

规则：
1. 一条事件是一个可以独立复述的事情，不是一句话。把同一天的同一件事合并成一条。
2. summary 用第三人称写，≤90 汉字，必须包含足以日后认出这件事的信息（人物、地点、因果）。
3. quote 只在情绪强或字句重要时填写原话，≤40 汉字，否则空字符串。
4. 三个分数各自独立打分，不要都给中间值：
   identity：这件事是否改变"它是什么 / 它和用户是什么关系"。寒暄 0.0-0.1；第一次发生的事 0.5-0.7；关系定义级 0.8-1.0。
   affect：情绪峰值。平淡 0.1-0.3；明确开心/难过 0.5-0.7；哭、吵架、坏消息 0.8-1.0。
   utility：以后还用得上的信息（计划、偏好、约定、事实）。纯情绪 0.1-0.3；具体信息 0.6-0.9。
5. 一批里必须至少有 1 条 identity ≥ 0.8 或 affect ≥ 0.8；如果没有，说明你漏了重要的东西，重新看一遍。
6. 忽略：客套、重复、无信息量的语气词。
7. facts 只抽取稳定事实，key 用命名空间（keeper.* / self.* / plan.*）。不要把情绪写进 facts。

输出结构：
{"events":[{"ts":<毫秒时间戳>,"kind":"episode|promise|conflict|milestone|fact_change",
"summary":"...","quote":"","entities":["..."],"score":{"identity":0.0,"affect":0.0,"utility":0.0},
"sources":{"turns":["t_xxx"]}}],
"facts":[{"key":"keeper.drink","value":"喝茶不放糖","confidence":0.9,"sourceEventIds":[]}]}`;

export function createOpenAILLM({ apiKey, baseUrl = 'https://api.deepseek.com', model = 'deepseek-chat', timeoutMs = 90_000 } = {}) {
  if (!apiKey) throw new Error('缺少 apiKey（config.llm.apiKey 或环境变量 DEEPSEEK_API_KEY）');

  async function chat(messages, { json = true, temperature = 0.2 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature,
          messages,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  function parseJson(text) {
    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
    return JSON.parse(trimmed);
  }

  return {
    async extractEvents(batch) {
      const convo = batch
        .map((t) => `[${t.turnId}] ${t.role === 'user' ? '用户' : '我'}：${t.text}`)
        .join('\n');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const content = await chat([
          { role: 'system', content: SYSTEM },
          { role: 'user', content: convo },
        ]);
        try {
          const out = parseJson(content);
          return { events: out.events || [], facts: out.facts || [] };
        } catch (err) {
          if (attempt === 2) throw new Error(`抽取结果不是合法 JSON：${err.message}`);
        }
      }
      throw new Error('unreachable');
    },

    async answer({ context, question }) {
      return chat(
        [
          { role: 'system', content: context },
          { role: 'user', content: question },
        ],
        { json: false, temperature: 0.7 }
      );
    },

    async judge({ question, answer, rubric }) {
      const content = await chat([
        { role: 'system', content: '你是严格的评分员。只输出 JSON：{"pass":true|false,"reason":"一句话"}' },
        { role: 'user', content: `问题：${question}\n回答：${answer}\n标准：${rubric}` },
      ]);
      try {
        return { ...parseJson(content), source: 'llm' };
      } catch {
        return { pass: false, reason: '判分输出无法解析', source: 'llm' };
      }
    },

    /** 合并判断：只有确实同一件事才返回摘要，否则返回 same:false。 */
    async mergeEvents(a, b) {
      const content = await chat(
        [
          {
            role: 'system',
            content: `你是记忆整理员。给你两条记忆事件，判断它们是不是"同一件事的不同碎片"。
只有确定是同一件事才合并。不同的事、或拿不准，一律 same:false。
合并要求：一句话，≤100 字，保留时间/人物/因果，不得添加原文没有的信息。
只输出 JSON：{"same":true,"summary":"..."} 或 {"same":false}`,
          },
          {
            role: 'user',
            content: `A（${fmt(a.ts)}）：${a.summary}\nB（${fmt(b.ts)}）：${b.summary}`,
          },
        ],
        { json: true, temperature: 0.1 }
      );
      try {
        const out = parseJson(content);
        if (!out?.same || !out.summary) return null;
        return { summary: String(out.summary).trim().slice(0, 100) };
      } catch {
        return null;
      }
    },
  };
}

function fmt(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
