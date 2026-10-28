/**
 * scheduler/meme.test.mjs —— 表情包图库读取器的离线自测
 *
 * 用临时目录造假图库（node:sqlite 建表插行），不碰真实 ~/.dsh/meme-packs。
 * 运行：node scheduler/meme.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-meme-'));
const pack = path.join(dir, 'packs', 'dafeiyu-001');
fs.mkdirSync(path.join(pack, 'memes', 'happy'), { recursive: true });
fs.writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify({ name: '大肥鱼' }), 'utf8');
fs.writeFileSync(path.join(pack, 'memes', 'happy', 'ok.jpg'), 'fake-bytes', 'utf8');

// 隔离：lib 在加载时读 USERPROFILE 当 home，指到临时目录就不会扫到真实 ~/.dsh/meme-packs
process.env.USERPROFILE = dir;
process.env.DOUYIN_MEME_ROOTS = path.join(dir, 'packs');
const { EMOTIONS, listPacks, packDirs, pickMeme, searchMemes } = await import('../lib/meme.js');

{
  const db = new DatabaseSync(path.join(pack, 'index.db'));
  db.exec(`CREATE TABLE memes (path TEXT PRIMARY KEY, tag TEXT NOT NULL, file_name TEXT NOT NULL,
    file_hash TEXT, caption TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '',
    mtime REAL, captioned_at REAL)`);
  const ins = db.prepare('INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES (?, ?, ?, ?, ?)');
  ins.run('memes/happy/ok.jpg', 'happy', 'ok.jpg', '竖起大拇指', 'ok 好 棒');
  ins.run('memes/happy/deyi.jpg', 'happy', 'deyi.jpg', '得意地笑', '得意 狐狸');
  ins.run('memes/sad/qiurao.jpg', 'sad', 'qiurao.jpg', '求饶', '求饶 委屈');
  db.close();
}

process.env.DOUYIN_MEME_ROOTS = path.join(dir, 'packs');

let pass = 0;
const ok = (name) => { pass++; console.log(`[PASS] ${name}`); };

try {
  // ① 图库发现：env 根目录下的带 index.db 包自动可见
  {
    const dirs = packDirs();
    assert.ok(dirs.some((d) => d === path.resolve(pack)));
    const packs = listPacks();
    const p = packs.find((x) => x.name === '大肥鱼');
    assert.ok(p, 'manifest 里的名字要读出来');
    assert.equal(p.count, 3);
    ok('① 图库发现 + manifest 名字 + 计数');
  }

  // ② 情绪桶展开：happy → happy/like/morning/see/surprised
  {
    assert.deepEqual(EMOTIONS.happy, ['happy', 'like', 'morning', 'see', 'surprised']);
    const got = searchMemes({ tag: 'happy', limit: 10 });
    assert.equal(got.length, 2);
    assert.ok(got.every((m) => m.tag === 'happy'));
    assert.ok(got[0].absPath.startsWith(path.resolve(pack)));
    ok('② 情绪桶展开搜索');
  }

  // ③ 关键词子串搜 caption/keywords/file_name
  {
    assert.equal(searchMemes({ query: '求饶' }).length, 1);
    assert.equal(searchMemes({ query: '狐狸' }).length, 1);
    assert.equal(searchMemes({ query: 'ok' }).length, 1);
    assert.equal(searchMemes({ query: '不存在的词' }).length, 0);
    ok('③ 关键词搜索');
  }

  // ④ pickMeme：先 tag 后 query，找不到返回 null
  {
    assert.equal(pickMeme('sad').tag, 'sad');
    assert.equal(pickMeme('得意').file, 'deyi.jpg');
    assert.equal(pickMeme('不存在的词'), null);
    assert.equal(pickMeme(''), null);
    ok('④ pickMeme 兜底顺序');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  delete process.env.DOUYIN_MEME_ROOTS;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
