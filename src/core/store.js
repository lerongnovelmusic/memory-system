// 落盘层。JSONL 是唯一真相，索引和切线都是派生数据。
// 写入必须原子且同步 —— 捕获层丢一条，那天就少一块记忆。

import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
  }

  pathOf(...parts) {
    return path.join(this.root, ...parts);
  }

  ensure() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.pathOf('snapshots'), { recursive: true });
    return this;
  }

  exists(name) {
    return fs.existsSync(this.pathOf(name));
  }

  readJsonl(name) {
    const p = this.pathOf(name);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const out = [];
    for (const [i, line] of raw.split('\n').entries()) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        // 坏行不静默丢弃：改名留证据，避免"记忆莫名少了一条"
        fs.appendFileSync(this.pathOf('quarantine.jsonl'), JSON.stringify({ file: name, line: i + 1, raw: s }) + '\n');
      }
    }
    return out;
  }

  /** 追加并 fsync。每轮对话结束都该调一次。 */
  appendJsonl(name, rows) {
    const p = this.pathOf(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, 'a');
    try {
      const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 整文件替换（原子：先写 tmp 再 rename）。用于巩固后的重排、事实表等。 */
  writeJsonl(name, rows) {
    writeAtomic(this.pathOf(name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  }

  readJson(name, fallback = null) {
    const p = this.pathOf(name);
    if (!fs.existsSync(p)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJson(name, obj) {
    writeAtomic(this.pathOf(name), JSON.stringify(obj, null, 2));
  }

  readText(name, fallback = '') {
    const p = this.pathOf(name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fallback;
  }

  writeText(name, text) {
    writeAtomic(this.pathOf(name), text);
  }

  /** 巩固前快照，保留最近 keep 份。 */
  snapshot(label = 'auto', keep = 7) {
    const dir = this.pathOf('snapshots', `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(this.root)) {
      const src = this.pathOf(f);
      if (f === 'snapshots' || !fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(dir, f));
    }
    const snaps = fs
      .readdirSync(this.pathOf('snapshots'))
      .filter((d) => !d.startsWith('.'))
      .sort();
    while (snaps.length > keep) {
      fs.rmSync(this.pathOf('snapshots', snaps.shift()), { recursive: true, force: true });
    }
    return dir;
  }
}

export function writeAtomic(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}
