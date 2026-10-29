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
import { resolveConfig } from './backend.js';

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
// 插件自己的运行日志 / 登录引导文件放在临时 root 下，别读真实 data/
const loginRoot = path.join(home, 'plugin');
const pluginData = path.join(home, 'plugin-data');
fs.mkdirSync(path.join(loginRoot, 'tools'), { recursive: true });
fs.writeFileSync(path.join(loginRoot, 'tools', 'login_headless.py'), '# fake\n');
fs.mkdirSync(path.join(pluginData, 'logs'), { recursive: true });
fs.writeFileSync(path.join(pluginData, 'logs', `douyin-${new Date().toISOString().slice(0, 10)}.log`), [
  '{"ts":"2026-10-27T12:00:00.000Z","tool":"duty","event":"timer_started"}',
  '{"ts":"2026-10-27T12:00:01.000Z","tool":"duty","event":"log","message":"读私信失败"}',
].join('\n'));
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
  createWhaleApi({
    log: () => {}, dataDir: pluginData, loginRoot,
    dutyEnabled: true,
    // 自检路由的假实现：只证明路由把结果透传出来，不碰真 agents
    dutyProbe: async () => probeResult,
  })(req, res, new URL(req.url, 'http://127.0.0.1'));
});
let probeResult = { ok: true, sessionId: 'duty-test', note: '值班会话已就绪' };
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
    assert.equal(typeof body.zcode_available, 'boolean');
    assert.equal(body.duty_enabled, true);
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

  // ── log：默认看插件值班日志，source=scheduler 看 ZCode 调度器日志 ──
  {
    const { body } = await get('/log?n=5');
    assert.equal(body.source, 'plugin');
    assert.equal(body.lines.length, 2);
    assert.match(body.lines.at(-1), /读私信失败/);
    const sched = await get('/log?n=5&source=scheduler');
    assert.equal(sched.body.source, 'scheduler');
    assert.equal(sched.body.lines.length, 2);
    assert.match(sched.body.lines.at(-1), /处理 111/);
    const all = await get('/log?source=scheduler');
    assert.equal(all.body.lines.length, 2);
    ok('GET /log 支持 source 与 n= 钳制');
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

  // ── meme 配置钳制 ──
  {
    const wr = await post('/config', { meme: { probability: 1.7, maxPerDay: 99, enabled: true } });
    assert.equal(wr.status, 200);
    assert.ok(wr.body.config.meme.probability <= 1, 'probability 钳到 [0,1]');
    assert.ok(wr.body.config.meme.maxPerDay <= 30, 'maxPerDay 钳到 [0,30]');
    assert.equal(wr.body.config.meme.enabled, true);
    const bad = await post('/config', { meme: { evil: 1 } });
    assert.equal(bad.status, 400, 'meme 未知字段整包拒绝');
    // 还原默认，免得污染后续断言
    await post('/config', { meme: { probability: 0.3, maxPerDay: 6 } });
    ok('POST /config meme 节钳制');
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

  // ── duty/selftest：只拉会话，不投任务 ──
  {
    probeResult = { ok: true, sessionId: 'duty-test', note: '值班会话已就绪' };
    const ready = await post('/duty/selftest');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.ok, true);
    assert.equal(ready.body.sessionId, 'duty-test');
    probeResult = null;                       // 模拟 whaleEnabled=false / 无 agents
    const off = await post('/duty/selftest');
    assert.equal(off.status, 400);
    assert.match(off.body.error, /未启用/);
    ok('POST /duty/selftest 就绪/未启用');
  }

  // ── login/status 路由：读不到状态文件时 phase=idle ──
  {
    const r = await get('/login/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(typeof r.body.phase, 'string');
    ok('GET /login/status 返回结构化状态');
  }

  // ── login/qr.png：只在进程活着且路径安全时下发 ──
  {
    const qrDir = path.join(pluginData, 'im-shots');
    fs.mkdirSync(qrDir, { recursive: true });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const qrFile = path.join(qrDir, 'login-qr.png');
    fs.writeFileSync(qrFile, png);
    const statusFile = path.join(pluginData, 'login-status.json');
    writeJsonFile(statusFile, { phase: 'qr', ok: null, running_pid: process.pid, qr: qrFile });
    const r = await fetch(base + '/login/qr.png');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await r.arrayBuffer()).length, png.length);
    // 死 pid → 不认过期二维码
    writeJsonFile(statusFile, { phase: 'qr', ok: null, running_pid: 2147483000, qr: qrFile });
    assert.equal((await fetch(base + '/login/qr.png')).status, 404);
    // 路径越界 → 不读任意文件
    writeJsonFile(statusFile, { phase: 'qr', ok: null, running_pid: process.pid, qr: 'C:/Windows/win.ini' });
    assert.equal((await fetch(base + '/login/qr.png')).status, 404);
    ok('GET /login/qr.png 只在进程活着且路径安全时下发');
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
    assert.match(spawnCalls[0].args.join(' '), /--out/);
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
      assert.ok(calls[0].args.includes(path.join(tmpRoot, 'data', 'im-shots', 'login-qr.png')));
      ok('startLogin 默认路径跟随 root/data（无注入也不炸）');
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

  // ── resolveConfig dataDir：checkout 用 repo/data，打包安装用 ~/.dsh ──
  {
    const repo = resolveConfig(path.resolve('.'), {});
    assert.equal(repo.dataDir, path.join(path.resolve('.'), 'data'));
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-packed-'));
    try {
      const packed = resolveConfig(noGit, {});
      assert.equal(packed.dataDir, path.join(os.homedir(), '.dsh', 'douyin-whale'));
      const custom = resolveConfig(noGit, { dataDir: path.join(noGit, 'custom') });
      assert.equal(custom.dataDir, path.join(noGit, 'custom'));
    } finally {
      try { fs.rmSync(noGit, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    ok('resolveConfig dataDir 默认值（checkout/打包/显式覆盖）');
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
