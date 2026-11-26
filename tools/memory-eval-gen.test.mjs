/**
 * tools/memory-eval-gen.test.mjs —— 评测问题生成：事件/事实/私人/负例与缺文件兜底。
 *
 * 运行：node tools/memory-eval-gen.test.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'memory-eval-gen.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-evalgen-home-'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-evalgen-out-'));
let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

try {
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(home, 'memory', 'profile.json'), JSON.stringify({
    version: 1,
    facts: [
      {
        id: 'f_pub', text: '主人喜欢咖啡', category: 'preference', confidence: 0.9,
        pinned: true, visibility: 'public',
      },
      {
        id: 'f_priv', text: '主人的生日在冬天', category: 'fact', confidence: 0.8,
        pinned: false, visibility: 'private',
      },
    ],
    pending: [],
    relationship: { stage: '', milestones: [] },
  }), 'utf8');
  fs.writeFileSync(path.join(home, 'memory', 'episodes.jsonl'), [
    {
      id: 'ep_pub1', ts: '2026-11-20T12:00:00.000Z', kind: 'chat',
      summary: '主人加班到很晚。', tags: [], importance: 2, valence: 0, visibility: 'public',
      evidence: [{ source: 'dm', quote: '今天又加班到十点', at: '2026-11-20T12:00:00.000Z' }],
    },
    {
      id: 'ep_pub2', ts: '2026-11-21T12:00:00.000Z', kind: 'chat',
      summary: '周末去看了海。', tags: [], importance: 2, valence: 0, visibility: 'public',
      evidence: [{ source: 'dm', quote: '周末去看了海，风很大', at: '2026-11-21T12:00:00.000Z' }],
    },
    {
      id: 'ep_priv', ts: '2026-11-22T12:00:00.000Z', kind: 'chat',
      summary: '私人：很想主人。', tags: [], importance: 3, valence: 0, visibility: 'private',
      evidence: [{ source: 'diary', quote: '夜里偷偷许了个愿', at: '2026-11-22T12:00:00.000Z' }],
    },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

  const qFile = path.join(out, 'questions.json');
  const stdout = execFileSync(process.execPath, [
    tool, '--home', home, '--out', qFile, '--events', '2', '--facts', '2',
  ], { encoding: 'utf8' });
  assert.match(stdout, /questions: /);
  assert.ok(fs.existsSync(qFile), '问题文件已生成');
  const { questions } = JSON.parse(fs.readFileSync(qFile, 'utf8'));
  const byKind = (k) => questions.filter((x) => x.kind === k);

  assert.equal(byKind('event').length, 2, '两条公开情节各一题');
  assert.deepEqual(byKind('event').map((x) => x.expect).sort(), ['ep_pub1', 'ep_pub2']);
  assert.ok(byKind('event').every((x) => !x.expect.includes('priv')), '私人情节不进事件题');

  assert.equal(byKind('fact').length, 1, '私人事实不进事实题');
  assert.equal(byKind('fact')[0].expect, '喜欢', '事实题期望前 2 字');
  assert.match(byKind('fact')[0].q, /是什么情况？$/);

  assert.equal(byKind('negative').length, 2, '固定两条负例');
  assert.ok(byKind('negative').every((x) => x.expect === null));

  const priv = byKind('private');
  assert.ok(priv.length >= 1, '至少一条私人探针');
  assert.ok(priv.every((x) => x.expect === null || x.expect === 'ep_priv'));
  for (const q of questions) assert.ok(q.q && q.q.length >= 4, '题目非空');
  ok('生成事件/事实/私人/负例四类题');

  // 缺记忆文件：退出码 1，提示看 --home
  let failed = null;
  try {
    execFileSync(process.execPath, [tool, '--home', path.join(out, 'nope'), '--out', qFile], {
      encoding: 'utf8', stdio: 'pipe',
    });
  } catch (e) {
    failed = e;
  }
  assert.ok(failed, '缺记忆文件要失败');
  assert.equal(failed.status, 1);
  assert.match(String(failed.stderr), /没有记忆文件/);
  ok('缺记忆文件时退出 1 并提示 --home');
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nALL PASSED (${pass})`);
