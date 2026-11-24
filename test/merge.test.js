import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/core/config.js';
import { normalizeEvent, visibleForInjection } from '../src/core/events.js';
import { mergePass, pairSimilarity, canMerge } from '../src/core/merge.js';
import { hashEmbed, embeddingText } from '../src/core/embed.js';
import { createHeuristicLLM } from '../src/llm/stub.js';

const NOW = Date.parse('2026-11-23T21:00:00+01:00');
const DAY = 86_400_000;
const cfg = makeConfig();
const llm = createHeuristicLLM();

function mk(id, summary, entities = [], over = {}) {
  return normalizeEvent(
    {
      id,
      summary,
      entities,
      ts: NOW,
      createdAt: NOW - 3 * DAY,
      tier: 'cache2',
      hits: [],
      score: { identity: 0.4, affect: 0.4, utility: 0.4 },
      ...over,
    },
    { now: NOW, dayKeyOf: () => '2026-11-23' }
  );
}

function vecs(events) {
  return new Map(events.map((e) => [e.id, { hash: 'x', v: hashEmbed(embeddingText(e), 384) }]));
}

test('校准：字面很像的两件事，不该被当成同一件', () => {
  const a = mk('a', '今天去学校办了注册', ['学校']);
  const b = mk('b', '今天去学校办了退学', ['学校']);
  const sim = pairSimilarity(a, b, hashEmbed(embeddingText(a)), hashEmbed(embeddingText(b)));
  assert.ok(sim.combined > 0.7, `这类句子余弦会很高（${sim.combined}），所以不能只靠阈值`);
});

test('去重：两条几乎一样的，并成一条，不改写摘要', async () => {
  const events = [
    mk('a', '今天去学校办了注册，排了两个小时队', ['学校']),
    mk('b', '今天去学校办了注册，排了两个小时队', ['学校']),
  ];
  const { events: out, log } = await mergePass({ events, vectors: vecs(events), cfg, now: NOW, llm });
  const actives = out.filter((e) => e.status === 'active');
  const merged = out.filter((e) => e.status === 'merged');
  assert.equal(actives.length, 1, '应当只剩一条活着的');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].mergedInto, actives[0].id, '被并的要留下指向');
  assert.ok(actives[0].sources.events.includes(merged[0].id), '溯源里要能追到被并的那条');
  assert.equal(actives[0].gen, 0, '去重不产生新的摘要代数');
  assert.equal(log[0].type, 'dedupe');
});

test('合并：一句包含另一句，安全地合并，代数 +1', async () => {
  const events = [
    mk('a', '今天去学校办了注册', ['学校']),
    mk('b', '今天去学校办了注册，排了两个小时队', ['学校']),
  ];
  const { events: out, log } = await mergePass({ events, vectors: vecs(events), cfg, now: NOW, llm });
  const alive = out.filter((e) => e.status === 'active');
  assert.equal(alive.length, 1);
  assert.equal(alive[0].summary, '今天去学校办了注册，排了两个小时队', '合并后保留信息更多的那句');
  assert.equal(alive[0].gen, 1, '改写了摘要，代数要 +1');
  assert.equal(log[0].type, 'merge');
});

test('合并：摘要没变就按去重记账，不虚增代数', async () => {
  const events = [
    mk('a', '今天去学校办了注册', ['学校']),
    mk('b', '去学校办了注册', ['学校']),
  ];
  const { events: out, log } = await mergePass({ events, vectors: vecs(events), cfg, now: NOW, llm });
  assert.equal(out.filter((e) => e.status === 'active').length, 1);
  assert.equal(log[0].type, 'dedupe');
  assert.equal(out.find((e) => e.status === 'active').gen, 0);
});

test('合并：字面很像但其实是两件事，不许并', async () => {
  const events = [
    mk('a', '今天去学校办了注册', ['学校']),
    mk('b', '今天去学校办了退学', ['学校']),
  ];
  const { events: out, log } = await mergePass({ events, vectors: vecs(events), cfg, now: NOW, llm });
  assert.equal(out.filter((e) => e.status === 'active').length, 2, '两件事都不能消失');
  assert.equal(log.length, 0);
});

test('不碰 core：人格连续性比省空间重要', async () => {
  const events = [
    mk('a', '她讨厌被当成无微不至的助手', [], { tier: 'core' }),
    mk('b', '她讨厌被当成无微不至的助手', [], { tier: 'core' }),
  ];
  const { events: out } = await mergePass({ events, vectors: vecs(events), cfg, now: NOW, llm });
  assert.equal(out.filter((e) => e.status === 'active').length, 2);
});

test('不碰契约：immortal / pinned 永不合并', async () => {
  const events = [
    mk('a', '用户说测试口令 A 时回复已确认 A', [], { immortal: true, pinned: true, safety: true }),
    mk('b', '用户说测试口令 A 时回复已确认 A', []),
  ];
  assert.equal(canMerge(events[0], events[1], cfg, NOW), false);
  const { events: out } = await mergePass({ events, vectors: vecs(events), cfg, now: NOW, llm });
  assert.equal(out.filter((e) => e.status === 'active').length, 2);
});

test('窗口：隔了 30 天的相似事件不合并', async () => {
  const events = [
    mk('a', '一起去吃了拉面', ['拉面']),
    mk('b', '一起去吃了拉面', ['拉面'], { ts: NOW - 30 * DAY }),
  ];
  const { events: out } = await mergePass({ events, vectors: vecs(events), cfg, now: NOW, llm });
  assert.equal(out.filter((e) => e.status === 'active').length, 2);
});

test('限流：一晚最多并 N 条', async () => {
  const events = [];
  for (let i = 0; i < 6; i += 1) {
    events.push(mk(`a${i}`, `第 ${i} 次说同一件事的原文`, ['同一件事']));
    events.push(mk(`b${i}`, `第 ${i} 次说同一件事的原文`, ['同一件事']));
  }
  const tight = makeConfig({ merge: { ...cfg.merge, maxMergesPerNight: 2 } });
  const { events: out } = await mergePass({ events, vectors: vecs(events), cfg: tight, now: NOW, llm });
  assert.equal(out.filter((e) => e.status === 'merged').length, 2);
});

test('代数上限：gen 到顶后不再合并', async () => {
  const events = [
    mk('a', '今天去学校办了注册', ['学校'], { gen: 3 }),
    mk('b', '去学校办了注册', ['学校']),
  ];
  assert.equal(canMerge(events[0], events[1], cfg, NOW), false);
});

test('被合并的事件不再出现在注入里', async () => {
  const events = [
    mk('a', '今天去学校办了注册，排了两个小时队', ['学校']),
    mk('b', '今天去学校办了注册，排了两个小时队', ['学校']),
  ];
  const { events: out } = await mergePass({ events, vectors: vecs(events), cfg, now: NOW, llm });
  const merged = out.find((e) => e.status === 'merged');
  assert.equal(visibleForInjection(merged), false);
  assert.equal(visibleForInjection(merged, { meta: true }), false, '连元对话也不该把已合并的当记忆');
});
