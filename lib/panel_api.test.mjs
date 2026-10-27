/**
 * lib/panel_api.test.mjs —— /api/douyin-whale/* 路由的冒烟测试。
 *
 * 起一个真实的 http.createServer 挂上 createWhaleApi，用 fetch 打每个路由。
 * 全程 127.0.0.1 临时端口 + 临时 DSH_HOME，不碰真实账号、不碰真实调度器。
 *
 * 运行：node lib/panel_api.test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { createWhaleApi, startLogin, readLoginStatus } from './panel_api.js';

const statusPath = (home) => path.join(home, 'login-status.json');
const writeJsonFile = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1), 'utf8');
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-api-'));
const DSH_HOME = home;
process.env.DSH_HOME = home; // whale_paths / stopScheduler 都读它

const cfgFile = path.join(home, 'douyin-whale.config.json');
const stateFile = path.join(home, 'douyin-whale-state.json');
const logFile = path.join(home, 'douyin-whale-scheduler.log');
const gateFile = path.join(home, 'im-send-gate.json');
fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
fs.writeFileSync(cfgFile, JSON.stringify({ owner: { nickname: '测试主人' } }, null, 2));
fs.writeFileSync(stateFile, JSON.stringify({
  date: new Date().toLocaleDateString('sv-SE'),
  watches: 2,
  repliedIds: ['111'],
  queue: [
    { item_id: '111', title: '已回复的视频', kind: 'video', seen_at: '2026-10-26T00:00:00Z' },
    { item_id: '222', title: '待回复的视频', kind: 'video', seen_at: '2026-10-26T01:00:00Z' },
  ],
}, null, 2));
fs.writeFileSync(logFile, ['2026-10-26T00:00:00Z [tick] 启动', '2026-10-26T00:01:00Z [tick] 处理 111'].join('\n'));

const server = http.createServer((req, res) => {
  createWhaleApi({ log: () => {} })(req, res, new URL(req.url, 'http://127.0.0.1'));
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}/api/douyin-whale`;

let pass = 0;
const ok = (name) => { pass++; console.log(`[PASS] ${name}`); };
const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};
const post = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json() };
};

try {
  // ── status：首屏聚合 ──
  {
    const { status, body } = await get('/status');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.owner, '测试主人');
    assert.equal(body.today.watches, 2);
    assert.equal(body.queue.total, 2);
    assert.ok('gate' in body && 'daemon' in body && 'memory' in body);
    ok('GET /status 聚合首屏');
  }

  // ── queue ──
  {
    const { body } = await get('/queue');
    assert.equal(body.ok, true);
    assert.equal(body.queue.pending, 1);
    assert.equal(body.queue.items[0].status, 'replied');
    ok('GET /queue 带每条状态');
  }

  // ── log：n 钳制 ──
  {
    const { body } = await get('/log?n=5');
    assert.equal(body.lines.length, 2);              // 文件只有 2 行
    assert.match(body.lines.at(-1), /处理 111/);
    const all = await get('/log');
    assert.equal(all.body.lines.length, 2);
    ok('GET /log 支持 n= 并钳制');
  }

  // ── gate / memory ──
  {
    const g = await get('/gate');
    assert.equal(g.body.ok, true);
    assert.ok('cooldown_remaining_s' in g.body.gate);
    const m = await get('/memory');
    assert.equal(m.body.ok, true);
    assert.ok('files' in m.body.memory);
    ok('GET /gate /memory');
  }

  // ── config 读写 ──
  {
    const before = await get('/config');
    assert.equal(before.body.config.owner.nickname, '测试主人');
    const wr = await post('/config', {
      owner: { nickname: '  新主人  ' },
      watch: { intervalMinutes: 999, dailyMax: -1, enabled: false },
    });
    assert.equal(wr.status, 200);
    assert.equal(wr.body.config.owner.nickname, '新主人');
    assert.ok(wr.body.config.watch.intervalMinutes <= 240);
    assert.ok(wr.body.config.watch.dailyMax >= 1);
    // 磁盘上真的变了（保留未知字段）
    const stored = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(stored.owner.nickname, '新主人');
    // 再 GET 一遍确认读回一致
    const after = await get('/config');
    assert.equal(after.body.config.owner.nickname, '新主人');
    ok('POST /config 钳制并落盘（含未知字段保留）');
  }

  // ── 非法配置 ──
  {
    const bad = await post('/config', { evil: 1 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.ok, false);
    ok('POST /config 全未知字段返回 400');
  }

  // ── scheduler/stop（DSH_HOME 指向临时目录，不会动真实调度器）──
  {
    const r = await post('/scheduler/stop');
    assert.equal(r.status, 200);
    assert.ok('output' in r.body);
    ok('POST /scheduler/stop 有结构化返回');
  }

  // ── login/status 路由：读不到状态文件时 phase=idle ──
  {
    const r = await get('/login/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(typeof r.body.phase, 'string');
    ok('GET /login/status 返回结构化状态');
  }

  // ── startLogin：假 spawn，验证参数与状态文件（不真开浏览器）──
  {
    const spawnCalls = [];
    const fakeSpawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 424242 };
    };
    const statusFile = path.join(home, 'login-status.json');
    const logFile = path.join(home, 'login-qr.log');
    const r = startLogin({
      root: path.resolve('.'), py: 'fake-python',
      spawnFn: fakeSpawn, statusFile, logFile,
    });
    assert.equal(r.ok, true);
    assert.equal(r.pid, 424242);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, 'fake-python');
    assert.match(spawnCalls[0].args[0], /login_headless\.py$/);
    assert.match(spawnCalls[0].args.join(' '), /--status-file/);
    assert.match(spawnCalls[0].args.join(' '), /--timeout 600/);
    assert.equal(spawnCalls[0].opts.windowsHide, true);
    const st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.equal(st.phase, 'waiting');
    assert.equal(st.running_pid, 424242);
    ok('startLogin 注入 spawn：参数/状态文件正确');
  }

  // ── startLogin：不传 statusFile/logFile 时，默认路径必须跟着 root ──
  //   2026-10-27 真宿主踩到：函数里算了 statusFile_/logFile_ 却用了未定义的
  //   statusFile/logFile，路由直接 500（The "path" argument must be of type string）。
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-login-root-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'tools', 'login_headless.py'), '# fake\n');
      const calls = [];
      const r = startLogin({
        root: tmpRoot, py: 'fake-python',
        spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 424243 }; },
      });
      assert.equal(r.ok, true, r.error || 'startLogin 应成功');
      assert.equal(r.pid, 424243);
      const st = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'data', 'login-status.json'), 'utf8'));
      assert.equal(st.running_pid, 424243);
      assert.ok(fs.existsSync(path.join(tmpRoot, 'data', 'login-qr.log')));
      assert.ok(calls[0].args.includes(path.join(tmpRoot, 'data', 'login-status.json')));
      ok('startLogin 默认路径跟随 root（无注入也不炸）');
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ── readLoginStatus：运行中判定 ──
  {
    writeJsonFile(statusPath(home), {
      phase: 'qr', ok: null, running_pid: process.pid, qr: 'C:/x/qr.png',
    });
    const st = readLoginStatus({ statusFile: statusPath(home) });
    assert.equal(st.phase, 'qr');
    assert.equal(st.running, true);              // 自己的 pid 一定活着
    assert.equal(st.qr, 'C:/x/qr.png');
    writeJsonFile(statusPath(home), {
      phase: 'ok', ok: true, running_pid: 2147483000,
    });
    const done = readLoginStatus({ statusFile: statusPath(home) });
    assert.equal(done.logged_in, true);
    assert.equal(done.running, false);           // 死 pid
    // 扫码进程被杀/超时：状态文件还停在 qr，但不能继续报「等待扫码」
    writeJsonFile(statusPath(home), {
      phase: 'qr', ok: null, running_pid: 2147483000, qr: 'C:/x/qr.png',
    });
    const killed = readLoginStatus({ statusFile: statusPath(home) });
    assert.equal(killed.running, false);
    assert.equal(killed.phase, 'idle');
    assert.equal(killed.qr, '');                 // 过期二维码不再下发给面板
    ok('readLoginStatus 运行中/已完成/被杀掉判定');
  }

  // ── 404 与坏 JSON ──
  {
    const nf = await get('/nope');
    assert.equal(nf.status, 404);
    const bad = await post('/config', undefined); // 无法构造坏 JSON，这里测空体
    assert.equal(bad.status, 400);
    ok('未知路由 404、空 body 400');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  server.close();
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.DSH_HOME;
}
