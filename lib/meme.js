/**
 * lib/meme.js —— 大肥鱼表情包图库（只读 dsh-meme 的 SQLite 索引）
 *
 * 图库本体由 dsh-meme 管理：~/.dsh/meme-packs/<pack>/index.db（path/tag/caption/
 * keywords），图片在 memes/<tag>/*.jpg。这里只做三件事：列包、按情绪/关键词搜、
 * 随机挑一张。零网络；发图走 douyin.mjs send --image。
 *
 * 与 python/douyin_im.py 的 meme_roots() 保持同一份白名单来源
 * （DOUYIN_MEME_ROOTS + ~/.dsh/meme-packs）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.USERPROFILE || os.homedir();

/** dsh-meme 的六个情绪桶 → 图库里更细的 tag（对齐 dsh-bili-whale 的映射） */
export const EMOTIONS = {
  happy: ['happy', 'like', 'morning', 'see', 'surprised'],
  angry: ['angry', 'baka', 'fool'],
  sad: ['sad', 'sigh', 'sleep'],
  shy: ['shy', 'color'],
  confused: ['confused', 'cpu'],
  daily: ['daily', 'work', 'meow', 'givemoney'],
};

/**
 * 图库根目录（DOUYIN_MEME_ROOTS + ~/.dsh/meme-packs）下所有带 index.db 的包。
 * env 里放的是「根目录」，其子目录里带 index.db 的才算一个包 ——
 * 和 python/douyin_im.py meme_roots() 的白名单前缀语义保持一致。
 */
export function packDirs() {
  const roots = [];
  for (const part of (process.env.DOUYIN_MEME_ROOTS || '').split(path.delimiter)) {
    const p = String(part || '').trim();
    if (p) roots.push(p);
  }
  roots.push(path.join(HOME, '.dsh', 'meme-packs'));
  const dirs = [];
  for (const root of roots) {
    try {
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        if (fs.existsSync(path.join(dir, 'index.db'))) dirs.push(dir);
      }
    } catch { /* 目录不存在就跳过 */ }
  }
  return [...new Set(dirs.map((p) => path.resolve(p)))];
}

export function listPacks() {
  const out = [];
  for (const dir of packDirs()) {
    const dbPath = path.join(dir, 'index.db');
    if (!fs.existsSync(dbPath)) continue;
    let name = path.basename(dir);
    let count = 0;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      if (m?.name) name = String(m.name);
    } catch { /* manifest 可缺 */ }
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      count = Number(db.prepare('SELECT COUNT(*) AS n FROM memes').get()?.n ?? 0);
      db.close();
    } catch { /* 坏库按 0 算 */ }
    out.push({ dir, name, count });
  }
  return out;
}

/**
 * 按情绪/关键词搜图。
 * - tag 命中情绪桶时展开成多个细 tag，否则当精确 tag；
 * - query 在 caption/keywords/file_name 里子串搜。
 * 返回 { absPath, relPath, tag, caption, keywords, pack }[]，上限 limit。
 */
export function searchMemes({ tag = '', query = '', limit = 8 } = {}) {
  const rawTag = String(tag || '').trim().toLowerCase();
  const q = String(query || '').trim();
  const tags = rawTag ? (EMOTIONS[rawTag] || [rawTag]) : [];
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  const out = [];
  for (const dir of packDirs()) {
    const dbPath = path.join(dir, 'index.db');
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { continue }
    try {
      const where = [];
      const params = [];
      if (tags.length) {
        where.push(`tag IN (${tags.map(() => '?').join(',')})`);
        params.push(...tags);
      }
      if (q) {
        where.push('(caption LIKE ? OR keywords LIKE ? OR file_name LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like);
      }
      let sql = 'SELECT path, tag, file_name, caption, keywords FROM memes';
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY RANDOM() LIMIT ?';
      params.push(max);
      for (const r of db.prepare(sql).all(...params)) {
        out.push({
          absPath: path.join(dir, r.path),
          relPath: r.path,
          tag: r.tag,
          file: r.file_name,
          caption: r.caption,
          keywords: r.keywords,
          pack: path.basename(dir),
        });
      }
    } catch { /* 坏库跳过 */ }
    try { db.close(); } catch { /* ignore */ }
  }
  return out.slice(0, max);
}

/** 先按 tag/情绪找；没有再把整串当关键词找。返回一张或 null。 */
export function pickMeme(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const byTag = searchMemes({ tag: s, limit: 1 });
  if (byTag.length) return byTag[0];
  return searchMemes({ query: s, limit: 1 })[0] ?? null;
}
