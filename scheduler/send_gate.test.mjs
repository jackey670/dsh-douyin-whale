/**
 * scheduler/send_gate.test.mjs —— 「一轮只发一条」发送闸的端到端自测
 *
 * 真的调用 `node douyin.mjs send --send`，只把 Python 换成桩脚本：
 *   · 没有标记（手动使用）→ 想发几条发几条
 *   · 调度器写了 sent=false 的标记 → 第一条成功并记账
 *   · 同一轮第二条 → 被拒绝，桩脚本根本不会被调用
 *   · 标记过期 → 不拦
 *
 * 运行：node scheduler/send_gate.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = path.resolve('.');
const douyinMjs = path.join(ROOT, 'douyin.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gate-'));
const home = path.join(dir, 'home');
const counter = path.join(dir, 'calls.txt');
const stub = path.join(dir, 'stub_im.mjs');

fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(stub, [
  'import fs from "node:fs";',
  'const c = process.env.STUB_COUNT;',
  'const n = fs.existsSync(c) ? Number(fs.readFileSync(c, "utf8") || 0) : 0;',
  'fs.writeFileSync(c, String(n + 1));',
  'console.log(JSON.stringify({ ok: true, sent: true }));',
].join('\n'), 'utf8');

const env = {
  ...process.env,
  DSH_HOME: home,
  DOUYIN_PYTHON: process.execPath,
  DOUYIN_IM_SCRIPT: stub,
  STUB_COUNT: counter,
  DOUYIN_HEADLESS: '1',
};

const send = (text) => spawnSync(process.execPath, [
  douyinMjs, 'send', '--to', '测试主人', '--text', text, '--send',
], { env, encoding: 'utf8', timeout: 60_000 });

const calls = () => (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0);
const markerFile = path.join(home, '.whale-reply-marker.json');
const marker = () => JSON.parse(fs.readFileSync(markerFile, 'utf8'));

let pass = 0;
const ok = (name) => { pass++; console.log(`[PASS] ${name}`); };

try {
  // ① 没有标记（手动发）→ 连发两条都成功
  {
    assert.equal(send('第一条').status, 0);
    assert.equal(send('第二条').status, 0);
    assert.equal(calls(), 2);
    assert.equal(fs.existsSync(markerFile), false);
    ok('① 手动发送不受闸限制');
  }

  // ② 调度器标记 sent=false → 第一条成功并记账，第二条被拒
  {
    fs.writeFileSync(markerFile, JSON.stringify({
      wake_id: 'wake-test',
      item_id: 'V1',
      kind: 'video',
      sent: false,
      text: '',
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    }), 'utf8');

    const first = send('第一条正式回复');
    assert.equal(first.status, 0);
    assert.equal(calls(), 3);
    const m1 = marker();
    assert.equal(m1.sent, true);
    assert.equal(m1.text, '第一条正式回复');
    assert.equal(m1.item_id, 'V1');

    const second = send('多余的一条');
    assert.equal(second.status, 1);
    assert.match(second.stdout, /本轮已经发过一条私信/);
    assert.equal(calls(), 3, '被拒的第二条不应调用 Python');
    ok('② 同一轮第二条被拒绝，且不触发发送');
  }

  // ③ 过期标记不拦
  {
    const m = marker();
    m.sent = true;
    m.expires_at = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(markerFile, JSON.stringify(m), 'utf8');
    const r = send('过期标记后的手动消息');
    assert.equal(r.status, 0);
    assert.equal(calls(), 4);
    ok('③ 过期标记不拦发送');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
