import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeuristicLLM } from '../src/llm/stub.js';
import { hashEmbed, cosine, createLocalEmbedder, embeddingText, contentHash } from '../src/core/embed.js';
import { ensureEmbeddings, loadEmbeddings } from '../src/core/embeddings.js';
import { MemoryIndex, vectorSearch, fuse } from '../src/core/recall.js';
import { normalizeEvent } from '../src/core/events.js';
import { Engine } from '../src/core/engine.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const llm = createHeuristicLLM();
const MIN = 60_000;

function turn(text, ts, id) {
  return { turnId: id, role: 'user', text, ts };
}

test('分段：15 分钟内连续发言合成一个事件', async () => {
  const t0 = Date.now();
  const out = await llm.extractEvents(
    [turn('今天去学校办注册。', t0, 't1'), turn('排了两个小时队。', t0 + MIN, 't2'), turn('累坏了。', t0 + 2 * MIN, 't3')],
    {}
  );
  assert.equal(out.events.length, 1, '应当合成一条');
  assert.equal(out.events[0].sources.turns.length, 3);
  assert.ok(out.events[0].summary.includes('注册'));
});

test('分段：间隔超过 15 分钟拆成两条', async () => {
  const t0 = Date.now();
  const out = await llm.extractEvents(
    [turn('今天去学校办注册。', t0, 't1'), turn('晚上看了会儿书。', t0 + 60 * MIN, 't2')],
    {}
  );
  assert.equal(out.events.length, 2);
});

test('事实抽取：把"记住…"变成 fact，而不是混在事件里', async () => {
  const out = await llm.extractEvents([turn('记住：我喝茶不放糖，别给我加糖。', Date.now(), 't1')], {});
  assert.ok(out.facts.length >= 1);
  const f = out.facts.find((x) => x.key === 'keeper.note');
  assert.ok(f, '应当抽出 keeper.note');
  assert.ok(f.value.includes('不放糖'));
});

test('事实抽取：过敏 / 讨厌 / 住在', async () => {
  const t = Date.now();
  const out = await llm.extractEvents(
    [
      turn('我对芒果过敏，千万别给我买坚果。', t, 't1'),
      turn('我讨厌被当成无微不至的助手。', t + 30 * MIN, 't2'),
      turn('我现在住在城东。', t + 90 * MIN, 't3'),
    ],
    {}
  );
  const keys = out.facts.map((f) => f.key);
  assert.ok(keys.includes('keeper.allergy'));
  assert.ok(keys.includes('keeper.dislike'));
  assert.ok(keys.includes('keeper.city'));
});

test('打分：情绪强的消息 affect 更高，承诺类 identity 更高', async () => {
  const t = Date.now();
  const out = await llm.extractEvents(
    [turn('今天天气还行。', t, 't1'), turn('我崩溃了，哭了很久，特别绝望。', t + 60 * MIN, 't2'), turn('我答应你，以后再也不一个人扛。', t + 120 * MIN, 't3')],
    {}
  );
  const [plain, sad, promise] = out.events;
  assert.ok(sad.score.affect > plain.score.affect);
  assert.ok(promise.score.identity > plain.score.identity);
});

test('实体：引号与已知词表都能抽出来', async () => {
  const t = Date.now();
  const out = await llm.extractEvents([turn('她说“城东”那边又下雨了，我还想去那家店。', t, 't1')], {
    knownEntities: ['城东'],
  });
  assert.ok(out.events[0].entities.includes('城东'));
});

test('向量：相同的文本余弦为 1，无关文本明显更低', () => {
  const a = hashEmbed('她差点把我弄丢，然后一个人把会话找回来了');
  const b = hashEmbed('她差点把我弄丢，然后一个人把会话找回来了');
  const c = hashEmbed('今天食堂的番茄汤味道一般');
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  assert.ok(cosine(a, c) < 0.3);
});

test('向量：共享单字也能进入向量候选（字面改写兜底）', () => {
  const q = hashEmbed('把我丢了');
  const v = new Map([['e1', { hash: 'x', v: hashEmbed('她差点把我弄丢，然后一个人把会话找回来了') }]]);
  const hits = vectorSearch(q, v, { minCosine: 0.02 });
  assert.equal(hits.length, 1, '即使 bigram 不重叠，也应进入候选');
});

test('RRF：两路都命中时排在只有一路命中的前面', () => {
  const fused = fuse([
    { name: 'lex', items: [{ id: 'a', coverage: 0.8 }, { id: 'b', coverage: 0.5 }] },
    { name: 'vec', items: [{ id: 'a', raw: 0.7 }, { id: 'c', raw: 0.6 }] },
  ]);
  assert.equal(fused[0].id, 'a');
  assert.deepEqual(fused[0].via.sort(), ['lex', 'vec']);
});

test('向量缓存：内容不变不重算，内容变了才重算', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafishu-emb-'));
  const { Store } = await import('../src/core/store.js');
  const store = new Store(root).ensure();
  const embedder = createLocalEmbedder();
  const now = Date.now();
  const events = [
    normalizeEvent({ id: 'e1', summary: '一起去吃了拉面', ts: now, tier: 'core', score: { identity: 0.5, affect: 0.5, utility: 0.5 } }, { now, dayKeyOf: () => '2026-11-23' }),
  ];
  const first = await ensureEmbeddings({ store, events, embedder });
  assert.equal(first.added, 1);

  const second = await ensureEmbeddings({ store, events, embedder });
  assert.equal(second.added, 0, '内容没变不该重算');

  const changed = [{ ...events[0], summary: '一起去吃了烤肉' }];
  assert.notEqual(contentHash(changed[0]), contentHash(events[0]));
  const third = await ensureEmbeddings({ store, events: changed, embedder });
  assert.equal(third.added, 1, '内容变了要重算');
});

test('向量：换 provider / 换维度后旧向量整体失效', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafishu-meta-'));
  const { Store } = await import('../src/core/store.js');
  const store = new Store(root).ensure();
  const local = createLocalEmbedder({ dim: 384 });
  const now = Date.now();
  const events = [
    normalizeEvent({ id: 'e1', summary: '一起去吃了拉面', ts: now, tier: 'core', score: { identity: 0.5, affect: 0.5, utility: 0.5 } }, { now, dayKeyOf: () => '2026-11-23' }),
  ];
  await ensureEmbeddings({ store, events, embedder: local });
  assert.equal(loadEmbeddings(store, local).size, 1);

  const remote = {
    name: 'openai:test',
    dim: 768,
    async embedBatch(texts) {
      return texts.map(() => Float32Array.from({ length: 768 }, () => 0.01));
    },
  };
  assert.equal(loadEmbeddings(store, remote).size, 0, 'provider/维度变了必须整体失效，否则余弦静默变 0');
});

test('混合检索：整条链路能命中，且 at least 一路有分', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafishu-hy-'));
  const engine = new Engine({ root, llm });
  const now = Date.now();
  const mk = (id, summary, entities) =>
    normalizeEvent(
      { id, summary, ts: now - 3600_000, tier: 'core', entities, hits: [], score: { identity: 0.7, affect: 0.5, utility: 0.6 } },
      { now, dayKeyOf: () => '2026-11-23' }
    );
  engine.store.writeJsonl('events.jsonl', [mk('e1', '她差点把我弄丢，然后一个人把会话找回来了', ['会话']), mk('e2', '今天食堂的番茄汤味道一般', ['番茄汤'])]);
  engine.invalidate();
  const r = await engine.recall('把会话弄丢', { now });
  assert.ok(r.picked.length >= 1);
  assert.equal(r.picked[0].ev.id, 'e1');
  assert.ok(r.vector > 0, '向量一路应当参与');
});
