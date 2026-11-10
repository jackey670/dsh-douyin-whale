/**
 * lib/pet_bridge.test.mjs —— 桌宠气泡/睡觉接口的离线测试。
 *
 * 用假 fetch 记录请求，不碰真桌宠；运行时文件用临时 home + 当前进程 PID。
 *
 * 运行：node lib/pet_bridge.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { petNotify, petRuntime, petSetSleep, syncPetSleep } from './pet_bridge.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pet-'));
const runtimeFile = path.join(home, 'dsh-pet', 'standalone-runtime.json');
const stateFile = path.join(home, 'whale-pet-state.json');
const cfg = { pet: { enabled: true, sleepEnabled: true, minIntervalMinutes: 15 } };
let pass = 0;
const ok = (name) => { pass++; console.log(`[PASS] ${name}`); };
const calls = [];
const fakeFetch = async (url, opts) => {
  calls.push({ url, opts });
  return { ok: true, status: 200 };
};
const writeRuntime = () => {
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.writeFileSync(runtimeFile, JSON.stringify({
    port: 3999, token: 't0k', pid: process.pid,
  }), 'utf8');
};

try {
  // 1) 没运行时文件 → 离线 no-op
  {
    const r = await petNotify({ text: 'hi', home, cfg, fetchImpl: fakeFetch });
    assert.equal(r.reason, 'offline');
    assert.equal(calls.length, 0);
    assert.equal(petRuntime(home), null);
    ok('没运行时文件时离线');
  }

  writeRuntime();

  // 2) 关掉播报 → 不发请求
  {
    const r = await petNotify({
      text: 'hi', home,
      cfg: { pet: { enabled: false } },
      fetchImpl: fakeFetch,
    });
    assert.equal(r.reason, 'disabled');
    assert.equal(calls.length, 0);
    ok('pet.enabled=false 不发');
  }

  // 3) 气泡：URL / token / body 都对
  {
    const r = await petNotify({ text: '回完一条啦', home, cfg, fetchImpl: fakeFetch });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    const { url, opts } = calls[0];
    assert.match(url, /^http:\/\/127\.0\.0\.1:3999\/dsh-pet-7340\/broadcast\?pet=main&surface=desktop$/);
    assert.equal(opts.headers['x-dsh-pet-token'], 't0k');
    const body = JSON.parse(opts.body);
    assert.equal(body.text, '回完一条啦');
    assert.equal(body.anim, false);
    assert.equal(body.duration, 8000);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(Date.parse(st.lastNotifyAt) > 0);
    ok('气泡请求参数正确');
  }

  // 4) 限流：15 分钟内第二条被挡；force 放行
  {
    const r = await petNotify({ text: '第二条', home, cfg, fetchImpl: fakeFetch });
    assert.equal(r.reason, 'rate-limited');
    assert.equal(calls.length, 1, '被限流时没有新请求');
    const forced = await petNotify({
      text: '摸摸头', home, cfg, force: true, fetchImpl: fakeFetch,
    });
    assert.equal(forced.ok, true);
    assert.equal(calls.length, 2);
    ok('普通限流 + force 放行');
  }

  // 5) 睡觉/起床：只在状态变化时发，并落盘
  {
    const sleep = await petSetSleep({ sleeping: true, home, cfg, fetchImpl: fakeFetch });
    assert.equal(sleep.ok, true);
    assert.equal(calls.length, 3);
    assert.match(calls[2].url, /\/sleep\?pet=main$/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sleeping, true);

    const again = await petSetSleep({ sleeping: true, home, cfg, fetchImpl: fakeFetch });
    assert.equal(again.reason, 'unchanged');
    assert.equal(calls.length, 3, '状态没变不重复请求');

    const wake = await petSetSleep({ sleeping: false, home, cfg, fetchImpl: fakeFetch });
    assert.equal(wake.ok, true);
    assert.match(calls[3].url, /\/wake\?pet=main$/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sleeping, false);
    ok('睡觉/起床状态机');
  }

  // 6) 自动睡觉关闭 / 心情关闭 → 不调桌宠
  {
    const off = await petSetSleep({
      sleeping: true, home,
      cfg: { pet: { enabled: true, sleepEnabled: false } },
      fetchImpl: fakeFetch,
    });
    assert.equal(off.reason, 'disabled');
    const synced = await syncPetSleep({
      view: { enabled: false, sleeping: true }, home, cfg, fetchImpl: fakeFetch,
    });
    assert.equal(synced.reason, 'disabled');
    assert.equal(calls.length, 4);
    ok('自动睡觉/心情关闭时不调用');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
