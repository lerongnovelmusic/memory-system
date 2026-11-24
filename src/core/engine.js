// 门面：把 store / 打标 / 分层 / 回忆 / 巩固 / 评测串成一个对象。
// CLI、HTTP 服务、GUI 都只跟它打交道。

import path from 'node:path';
import fs from 'node:fs';
import { Store } from './store.js';
import { makeConfig } from './config.js';
import { normalizeEvent, restoreOriginal as restoreOriginalSummary } from './events.js';
import { dayKey, nowMs } from './time.js';
import { buildBootContext } from './boot.js';
import { recall as recallCore, renderRecall, MemoryIndex } from './recall.js';
import { consolidate as consolidateCore } from './consolidate.js';
import { captureTurn, listSessions, turnsOfSession } from './turns.js';
import { computeRetain } from './score.js';
import { createEmbedder, hashEmbed, embeddingText, contentHash } from './embed.js';
import { loadEmbeddings, ensureEmbeddings } from './embeddings.js';

export class Engine {
  constructor({ root, config = {}, llm = null } = {}) {
    this.root = path.resolve(root || 'data');
    this.cfg = makeConfig(config);
    this.store = new Store(this.root).ensure();
    this.llm = llm;
    this.embedder = createEmbedder(this.cfg);
    this._cache = null;
  }

  load({ force = false } = {}) {
    if (this._cache && !force) return this._cache;
    const dayKeyOf = (ts) => dayKey(ts, { tz: this.cfg.tz, cutoffHour: this.cfg.dayCutoffHour });
    const events = this.store.readJsonl('events.jsonl').map((e) => normalizeEvent(e, { dayKeyOf }));
    const facts = this.store.readJsonl('facts.jsonl');
    const threads = this.store.readJson('threads.json', []);
    const vectors = this.#vectorsFor(events);
    this._cache = { events, facts, threads, vectors, index: MemoryIndex.from(events) };
    return this._cache;
  }

  /** 本地向量可以同步补齐；远端向量等巩固时补齐，缺的只是少一路召回。 */
  #vectorsFor(events) {
    const map = loadEmbeddings(this.store, this.embedder);
    if (this.embedder.name !== 'local') {
      for (const id of [...map.keys()]) if (!events.some((e) => e.id === id)) map.delete(id);
      return map;
    }
    for (const ev of events) {
      if (ev.status !== 'active') {
        map.delete(ev.id);
        continue;
      }
      const hash = contentHash(ev);
      const cached = map.get(ev.id);
      if (!cached || cached.hash !== hash) {
        map.set(ev.id, { hash, v: hashEmbed(embeddingText(ev), this.embedder.dim) });
      }
    }
    return map;
  }

  invalidate() {
    this._cache = null;
  }

  capture({ role, text, sessionId, ts }) {
    const turn = captureTurn(this.store, { role, text, sessionId, ts });
    this.invalidate();
    return turn;
  }

  boot({ now = nowMs(), lastSession = null } = {}) {
    const { events, facts, threads } = this.load();
    return buildBootContext({ store: this.store, events, facts, threads, now, cfg: this.cfg, lastSession });
  }

  async recall(query, { now = nowMs(), meta = false } = {}) {
    const { events, index, vectors } = this.load();
    return recallCore(events, query, this.cfg, {
      index,
      vectors,
      embedder: this.embedder,
      now,
      meta,
    });
  }

  renderRecall(result, now = nowMs()) {
    return renderRecall(result.picked, now);
  }

  /** 她在这一轮真正会看到的上下文 = 启动上下文 + 本轮回忆片段。 */
  async contextFor({ query = '', now = nowMs(), lastSession = null } = {}) {
    const boot = this.boot({ now, lastSession });
    const r = query ? await this.recall(query, { now }) : { picked: [], tokens: 0 };
    const recalled = this.renderRecall(r, now);
    // 没翻到记忆时，明确告诉模型"这不是失忆，正常聊"，否则它会机械地说"记忆里没有"。
    const tail = recalled
      ? `## 这轮想起来的\n（以下是参考，不是回答的前提）\n${recalled}`
      : '## 这轮想起来的\n（这轮没有翻到相关记忆。按当前话题正常聊，不要专门声明"记忆里没有"。）';
    const text = `${boot.text}\n\n${tail}`;
    return {
      text,
      tokens: boot.tokens + r.tokens + 60,
      boot,
      recall: {
        count: r.picked.length,
        tokens: r.tokens,
        ids: r.picked.map((p) => p.ev.id),
        lexical: r.lexical ?? 0,
        vector: r.vector ?? 0,
      },
    };
  }

  async consolidate({ now = nowMs(), dryRun = false } = {}) {
    const llm = this.llm;
    if (!llm) throw new Error('没有 LLM 抽取器：consolidate 需要一个 llm');
    const { vectors } = this.load();
    const out = await consolidateCore({ store: this.store, llm, cfg: this.cfg, now, dryRun, vectors });
    if (!out.skipped && !dryRun) {
      await ensureEmbeddings({ store: this.store, events: out.events, embedder: this.embedder });
    }
    this.invalidate();
    return out;
  }

  sessions(limit = 7) {
    return listSessions(this.store, limit);
  }

  sessionTurns(sessionId) {
    return turnsOfSession(this.store, sessionId);
  }

  stats() {
    const { events, facts, threads } = this.load();
    const now = nowMs();
    const byTier = {};
    let tokens = 0;
    for (const e of events) {
      if (e.status === 'active' || e.status === 'superseded') {
        byTier[e.tier] = (byTier[e.tier] || 0) + 1;
        tokens += e.tokens || 0;
      }
    }
    const active = events.filter((e) => e.status === 'active');
    const top = [...active]
      .map((e) => ({ e, retain: computeRetain(e, now, this.cfg).retain }))
      .sort((a, b) => b.retain - a.retain)
      .slice(0, 5);
    return {
      events: events.length,
      active: active.length,
      superseded: events.filter((e) => e.status === 'superseded').length,
      merged: events.filter((e) => e.status === 'merged').length,
      tombstone: events.filter((e) => e.status === 'tombstone').length,
      facts: facts.filter((f) => f.status === 'active').length,
      factsSuperseded: facts.filter((f) => f.status === 'superseded').length,
      threads: threads.length,
      byTier,
      tokens,
      budget: this.cfg.budgets,
      pinnedThisWeek: active.filter((e) => e.pinned && e.pinnedAt && now - e.pinnedAt < 7 * 86_400_000).length,
      embedding: {
        provider: this.embedder.name,
        dim: this.embedder.dim,
        vectors: this.load().vectors.size,
      },
      top: top.map((x) => ({ id: x.e.id, tier: x.e.tier, retain: Number(x.retain.toFixed(3)), summary: x.e.summary })),
    };
  }

  /** 记忆检查器用：某条事件为什么在这里。 */
  explain(eventId) {
    const { events, vectors } = this.load();
    const now = nowMs();
    const ev = events.find((e) => e.id === eventId);
    if (!ev) return null;
    const { retain, parts } = computeRetain(ev, now, this.cfg);
    return {
      event: ev,
      retain,
      parts,
      hasVector: vectors.has(ev.id),
      moveHistory: this.store.readJsonl('moves.log').filter((m) => m.id === eventId).slice(-10),
    };
  }

  // ---------- 人工闸 ----------

  /** pin / unpin。pin 过的事件绕过配额、跳过存活期、永不合并、永不淘汰。 */
  setPinned(eventId, pinned = true) {
    const { events } = this.load();
    const ev = events.find((e) => e.id === eventId);
    if (!ev) return null;
    const next = { ...ev, pinned: Boolean(pinned), pinnedAt: pinned ? nowMs() : null };
    this.store.writeJsonl(
      'events.jsonl',
      events.map((e) => (e.id === eventId ? next : e))
    );
    this.invalidate();
    return next;
  }

  /** 把摘要恢复成最初的样子（人工回退一次合并）。 */
  restoreOriginal(eventId) {
    const { events } = this.load();
    const ev = events.find((e) => e.id === eventId);
    if (!ev) return null;
    const next = restoreOriginalSummary(ev);
    this.store.writeJsonl(
      'events.jsonl',
      events.map((e) => (e.id === eventId ? next : e))
    );
    this.invalidate();
    return next;
  }

  // ---------- 快照与回滚 ----------

  listSnapshots() {
    const dir = this.store.pathOf('snapshots');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((d) => !d.startsWith('.'))
      .map((name) => {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        return { name, at: st.mtimeMs, files: fs.readdirSync(p).length };
      })
      .sort((a, b) => b.at - a.at);
  }

  /** 回滚到某个快照。回滚前会先给当前状态拍一张，避免回滚本身不可逆。 */
  restoreSnapshot(name) {
    const dir = this.store.pathOf('snapshots', name);
    if (!fs.existsSync(dir)) throw new Error(`快照不存在：${name}`);
    const files = fs.readdirSync(dir);
    this.store.snapshot('pre-rollback');
    for (const f of files) {
      fs.copyFileSync(path.join(dir, f), this.store.pathOf(f));
    }
    this.invalidate();
    return { restored: files, from: name };
  }
}
