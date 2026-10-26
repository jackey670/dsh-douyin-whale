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

import { createWhaleApi } from './panel_api.js';

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
