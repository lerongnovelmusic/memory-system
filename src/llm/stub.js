// 离线抽取器。没有 API key 也能把整条流水线跑通。
//
// v0.2 做了四件事，让它不再"一条消息 = 一个事件"：
//   1. 分段聚合：15 分钟内的连续发言合成一个 episode，而不是碎成十条
//   2. 结构化打分：用词表 + 信号词算三个轴，分布是散开的（LLM 常见的 "全 0.6" 反而更糟）
//   3. 事实抽取：把"记住…""我讨厌…""我对…过敏"变成 facts，而不是混在事件里
//   4. 实体抽取：引号 / 英文 / 已知语料词表，供检索的实体加成与线索归并
//
// 它仍然不懂语义。真要用请走 src/llm/openai.js。

export const FILLER = /^(嗯|啊|哦|唉|好吧|那就|所以|然后|其实|就是说|那个|这个)[，,、。\s]*/;

// 情绪词：分为强/中两档，避免"累"和"崩溃"同权
const EMOTION_HIGH = ['哭', '崩溃', '绝望', '想死', '自杀', '害怕', '恐惧', '气死', '尖叫', '发抖', '疼', '痛'];
const EMOTION_MID = ['难过', '开心', '高兴', '委屈', '孤独', '焦虑', '烦', '累', '平静', '安心', '温暖', '生气', '失望', '想念', '心疼', '笑'];

// 关系/承诺信号：这些词出现，事件大概率改变"她是谁 / 我们是什么关系"
const COMMIT = ['答应', '约定', '说好', '记住', '别忘', '再也不', '第一次', '最后一次', '离开', '回来', '等我', '陪我', '永远', '暗号', '承诺'];
const RELATION = ['用户', '喜欢', '讨厌', '爱', '讨厌被', '陪伴', '不要走', '留下'];

// 实用信息信号：以后还用得上的
const TIME_WORDS = ['明天', '后天', '下周', '下个月', '明年', '上周', '昨天', '以后', '将来', '月底', '周'];
const PLAN_WORDS = ['计划', '打算', '要搬', '搬家', '考试', '面试', '医院', '挂号', '实习', '申请', '截止', '交材料', '房租', '打工'];
const NUMBERS = /\d/;

const FACT_RULES = [
  { re: /记住[：:，,]?\s*(.{2,30})/, key: 'keeper.note', conf: 0.8 },
  { re: /我(?:喜欢|爱喝|爱吃|偏爱)(.{1,20})/, key: 'keeper.like', conf: 0.65 },
  { re: /我(?:不喜欢|讨厌|受不了|不吃)(.{1,20})/, key: 'keeper.dislike', conf: 0.65 },
  { re: /我对(.{1,12})过敏/, key: 'keeper.allergy', conf: 0.9 },
  { re: /我(?:现在)?住在(.{1,16})/, key: 'keeper.city', conf: 0.7 },
  { re: /我(?:叫|的名字是)(.{1,12})/, key: 'keeper.name', conf: 0.8 },
  { re: /我(?:在|到)(.{2,10})(?:读书|上学|上班|工作)/, key: 'keeper.place', conf: 0.6 },
];

const SENTENCE_SPLIT = /(?<=[。！？!?\n])/;

export function createHeuristicLLM() {
  return {
    async extractEvents(batch, { now = Date.now(), knownEntities = [] } = {}) {
      const groups = segment(batch, now);
      const events = [];
      const facts = [];
      const gazetteer = new Set(knownEntities.map((e) => String(e).trim()).filter(Boolean));

      for (const g of groups) {
        const text = g.turns
          .map((t) => String(t.text).trim().replace(/[。！？!?\s]+$/, ''))
          .filter(Boolean)
          .join('。')
          .trim();
        if (!text) continue;

        const summary = makeSummary(text);
        if (!summary) continue;

        const { score, quote } = analyse(text, summary);
        const entities = extractEntities(text, gazetteer);
        const kind = chooseKind(text, score);

        events.push({
          ts: g.start,
          kind,
          summary,
          quote,
          entities,
          score,
          sources: { turns: g.turns.map((t) => t.turnId) },
          pinned: /(记住|别忘)/.test(text),
        });

        for (const rule of FACT_RULES) {
          const m = text.match(rule.re);
          if (!m) continue;
          const value = cleanValue(m[1]);
          if (!value) continue;
          facts.push({
            key: rule.key,
            value,
            confidence: rule.conf,
            sourceEventIds: [],
            ts: g.start,
          });
        }
      }

      return { events: dedupe(events), facts: dedupeFacts(facts) };
    },

    /**
     * 合并判断。离线版只做"安全的那部分"：一句包含另一句时才合并。
     * 不拼两句——"去学校办注册" 和 "去学校办退学" 字面很像，但那是两件事，
     * 靠字数拼接一定会出错。真正的碎片合并没有模型就不要做。
     */
    async mergeEvents(a, b) {
      const sa = String(a.summary || '').trim();
      const sb = String(b.summary || '').trim();
      if (!sa || !sb) return null;
      if (sa.includes(sb)) return { summary: sa };
      if (sb.includes(sa)) return { summary: sb };
      return null;
    },
  };
}

// 兼容旧名字
export const createStubLLM = createHeuristicLLM;

/** 15 分钟内的连续发言算同一次"说话"，避免一句一条事件。 */
function segment(batch, now) {
  const groups = [];
  let cur = null;
  for (const t of batch) {
    if (t.role !== 'user') continue;
    const ts = t.ts ?? now;
    const sid = t.sessionId || '';
    if (cur && cur.sessionId === sid && ts - cur.end <= 15 * 60_000) {
      cur.turns.push(t);
      cur.end = ts;
    } else {
      cur = { turns: [t], start: ts, end: ts, sessionId: sid };
      groups.push(cur);
    }
  }
  return groups;
}

function makeSummary(text) {
  const sentences = text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim().replace(FILLER, ''))
    .filter((s) => s.length >= 4);
  if (!sentences.length) return '';
  // 去掉"记住："这类指令外壳，记忆里应该是一件事，不是一个命令
  const cleaned = sentences.map((s) => s.replace(/^(记住|别忘|提醒我|你要记得)[：:，,]?\s*/, '')).filter(Boolean);
  const picked = (cleaned.length ? cleaned : sentences).slice(0, 2).join('。').replace(/[。！？]+$/, '');
  return picked.length > 90 ? `${picked.slice(0, 88)}…` : picked;
}

/** 三个轴各自独立算，并给出分布。 */
function analyse(text, summary) {
  const emoHigh = EMOTION_HIGH.filter((w) => text.includes(w)).length;
  const emoMid = EMOTION_MID.filter((w) => text.includes(w)).length;
  const commit = COMMIT.filter((w) => text.includes(w)).length;
  const relation = RELATION.filter((w) => text.includes(w)).length;
  const timeHit = TIME_WORDS.filter((w) => text.includes(w)).length;
  const planHit = PLAN_WORDS.filter((w) => text.includes(w)).length;
  const factHit = FACT_RULES.some((r) => r.re.test(text)) ? 1 : 0;
  const asked = /[？?]/.test(text) ? 1 : 0;

  // identity：承诺/关系类永远最高；其次是长度带来的信息量
  const identity = round(
    clamp(0.1 + commit * 0.35 + relation * 0.12 + (factHit && commit ? 0.15 : 0) + Math.min(1, summary.length / 90) * 0.12)
  );
  // affect：情绪词强度；感叹号只是弱信号
  const affect = round(
    clamp(0.1 + emoHigh * 0.45 + emoMid * 0.18 + (/[！!]/.test(text) ? 0.08 : 0) + (asked ? 0.05 : 0))
  );
  // utility：以后还用得上的信息
  const utility = round(
    clamp(0.1 + factHit * 0.35 + planHit * 0.15 + Math.min(2, timeHit) * 0.08 + (NUMBERS.test(text) ? 0.1 : 0))
  );

  // 原话只留给情绪强的事件，且挑情绪最强的那句
  let quote = '';
  const strongest = affect >= 0.55 ? pickEmotionalSentence(text) : '';
  if (strongest && strongest.length <= 40) quote = strongest;
  else if (strongest) quote = `${strongest.slice(0, 38)}…`;

  return { score: { identity, affect, utility }, quote };
}

function pickEmotionalSentence(text) {
  const sentences = text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
  let best = '';
  let bestScore = 0;
  for (const s of sentences) {
    const sc = EMOTION_HIGH.filter((w) => s.includes(w)).length * 2 + EMOTION_MID.filter((w) => s.includes(w)).length;
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return bestScore > 0 ? best : '';
}

function chooseKind(text, score) {
  if (/答应|约定|说好|承诺|暗号/.test(text)) return 'contract';
  if (/再也不|离开|回来|第一次|最后一次/.test(text)) return 'milestone';
  if (score.utility >= 0.6 && /改|变成|不再/.test(text)) return 'fact_change';
  if (score.affect >= 0.6) return 'episode';
  return 'episode';
}

function extractEntities(text, gazetteer) {
  const out = new Set();
  for (const m of text.matchAll(/[“"「『]([^”"」』]{1,16})[”"」』]/g)) out.add(m[1].trim());
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9_]{1,20}\b/g)) out.add(m[0]);
  for (const known of gazetteer) {
    if (known.length >= 2 && text.includes(known)) out.add(known);
  }
  return [...out].slice(0, 8);
}

function cleanValue(v) {
  return String(v)
    .replace(/[。！？!?，,、；;\s]+$/, '')
    .replace(/^[：:，,\s]+/, '')
    .slice(0, 30)
    .trim();
}

/** 同一天里高度相似的事件合并，避免"说了三遍就记三条"。 */
function dedupe(events) {
  const out = [];
  for (const ev of events) {
    const twin = out.find((o) => o.summary === ev.summary);
    if (twin) {
      twin.sources.turns.push(...ev.sources.turns);
      twin.score.affect = Math.max(twin.score.affect, ev.score.affect);
      twin.score.utility = Math.max(twin.score.utility, ev.score.utility);
      continue;
    }
    out.push(ev);
  }
  return out;
}

function dedupeFacts(facts) {
  const seen = new Map();
  for (const f of facts) {
    const k = `${f.key}=${f.value}`;
    if (!seen.has(k)) seen.set(k, f);
  }
  return [...seen.values()];
}

function clamp(x) {
  return Math.min(1, Math.max(0, x));
}

function round(x) {
  return Math.round(x * 100) / 100;
}
