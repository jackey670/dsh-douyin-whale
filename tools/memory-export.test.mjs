/**
 * tools/memory-export.test.mjs —— 记忆导出：清单/排除/manifest/推送/校验。
 *
 * 运行：node tools/memory-export.test.mjs
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { compareManifest, pushExport, stageExport, verifyRepo } from './memory-export.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mexp-home-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mexp-'));
let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
fs.writeFileSync(path.join(home, 'memory/profile.json'), JSON.stringify({
  version: 1,
  facts: [
    { id: 'f_1', text: '主人喜欢咖啡', visibility: 'public' },
    { id: 'f_2', text: '已删事实', deleted: true, visibility: 'public' },
  ],
  pending: [],
  relationship: { stage: '', milestones: [] },
}), 'utf8');
fs.writeFileSync(path.join(home, 'memory/episodes.jsonl'), [
  JSON.stringify({ id: 'ep_1', summary: 'a' }),
  JSON.stringify({ id: 'ep_2', summary: 'b' }),
  JSON.stringify({ id: 'ep_3', summary: 'c' }),
].join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(home, 'memory/arcs.json'), JSON.stringify({ version: 1, arcs: [{ id: 'arc_1' }] }), 'utf8');
fs.writeFileSync(path.join(home, 'memory/meta.json'), JSON.stringify({ version: 1, migratedAt: '2026-10-20T00:00:00.000Z' }), 'utf8');
fs.writeFileSync(path.join(home, 'memory/index.json'), JSON.stringify({ version: 1, terms: {} }), 'utf8');
fs.writeFileSync(path.join(home, 'memory/dm-测试主人.json'), JSON.stringify({
  who: { nick: '测试主人' },
  messages: [
    { at: '2026-11-20T10:00:00+08:00', from: 'them', text: '今晚吃什么', kind: 'text' },
    { at: '2026-11-20T10:01:00+08:00', from: 'me', text: '火锅？', kind: 'text' },
  ],
}), 'utf8');
// 必须被排除的运行时文件
fs.writeFileSync(path.join(home, 'memory/consolidate.lock'), '{"pid":1}', 'utf8');
fs.writeFileSync(path.join(home, 'memory/session-epochs.json'), '{"version":1}', 'utf8');
fs.writeFileSync(path.join(home, 'memory/leftover.tmp'), 'junk', 'utf8');
fs.writeFileSync(path.join(home, 'whale-diary.md'), '## 2026-11-20 · 22:00\n今天聊了火锅。\n', 'utf8');
fs.writeFileSync(path.join(home, 'whale-diary-private.md'), '## 2026-11-20 · 22:05\n私人日记内容。\n', 'utf8');
fs.writeFileSync(path.join(home, 'whale-mood.json'), JSON.stringify({ energy: 70, social: 40, boredom: 30 }), 'utf8');

const gitSync = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

try {
  // 1) 导出：清单/排除/manifest/README/.gitattributes
  const outDir = path.join(tmp, 'staging');
  const { staging, manifest } = stageExport({ home, out: outDir });
  assert.equal(staging, outDir);
  const rels = manifest.files.map((f) => f.path).sort();
  assert.deepEqual(rels, [
    'memory/arcs.json',
    'memory/dm-测试主人.json',
    'memory/episodes.jsonl',
    'memory/index.json',
    'memory/meta.json',
    'memory/profile.json',
    'whale-diary-private.md',
    'whale-diary.md',
    'whale-mood.json',
  ]);
  assert.ok(!rels.some((r) => r.includes('consolidate.lock') || r.includes('session-epochs') || r.includes('.tmp')));
  for (const row of manifest.files) {
    const buf = fs.readFileSync(path.join(staging, row.path));
    assert.equal(sha256(buf), row.sha256);
    assert.equal(buf.length, row.bytes);
  }
  assert.deepEqual(manifest.counts, { episodes: 3, facts: 1, arcs: 1, dmMessages: 2 });
  assert.ok(fs.existsSync(path.join(staging, 'README.md')));
  assert.ok(fs.readFileSync(path.join(staging, '.gitattributes'), 'utf8').includes('* -text'));
  ok('stageExport 清单/排除/manifest/README');

  // 2) manifest 校验：篡改与缺失都能抓到
  {
    fs.writeFileSync(path.join(staging, 'whale-mood.json'), '{"tampered":true}', 'utf8');
    let r = compareManifest(staging);
    assert.deepEqual(r.bad, ['whale-mood.json']);
    fs.rmSync(path.join(staging, 'memory/index.json'));
    r = compareManifest(staging);
    assert.deepEqual(r.missing, ['memory/index.json']);
    ok('compareManifest 抓篡改/缺失');
  }

  // 3) 推送到本地 bare 仓库：首推 → 未变化 → 增量
  const bare = path.join(tmp, 'memory-repo.git');
  gitSync(tmp, ['init', '--bare', '-b', 'master', path.basename(bare)]);
  const p1 = pushExport({ home, repo: bare });
  assert.equal(p1.ok, true, p1.error);
  assert.equal(p1.unchanged, undefined);
  const p2 = pushExport({ home, repo: bare });
  assert.equal(p2.ok, true);
  assert.equal(p2.unchanged, true, '第二次推送应无变化');
  // 改动一条日记再推：产生新 commit，历史保留
  fs.appendFileSync(path.join(home, 'whale-diary.md'), '## 2026-11-21 · 09:00\n又聊了一次。\n', 'utf8');
  const p3 = pushExport({ home, repo: bare });
  assert.equal(p3.ok, true);
  assert.equal(p3.unchanged, undefined);
  const log = gitSync(bare, ['log', '--oneline']);
  assert.equal(log.trim().split('\n').length, 2, 'bare 仓库应有两个 commit');
  ok('pushExport 首 push/未变化/增量');

  // 4) verifyRepo：远端 clone 后 sha256 全对
  {
    const r = verifyRepo({ repo: bare });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.files, 9);
    assert.deepEqual(r.bad, []);
    assert.deepEqual(r.missing, []);
    assert.equal(r.counts.episodes, 3);
    ok('verifyRepo 全量比对通过');
  }

  // 5) --out 指向 git 仓库时拒绝清空
  {
    const guarded = path.join(tmp, 'guarded');
    fs.mkdirSync(path.join(guarded, '.git'), { recursive: true });
    assert.throws(() => stageExport({ home, out: guarded }), /拒绝清空/);
    ok('stageExport 保护 git 目录');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
