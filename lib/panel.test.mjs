/**
 * lib/panel.test.mjs —— 面板状态层与 API 辅助函数的自测（纯本地，不联网）。
 *
 * 运行：node lib/panel.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  readConfig,
  readState,
  readGate,
  daemonAlive,
  tailLog,
  queueView,
  summary,
  whalePaths,
} from './whale_state.js';
import { sanitizeConfigPatch, applyConfigPatch } from './panel_api.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-panel-'));
const paths = whalePaths(home);
fs.mkdirSync(paths.memoryDir, { recursive: true });

let pass = 0;
const ok = (name) => { pass++; console.log(`[PASS] ${name}`); };
const write = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
};

try {
  // ── 配置：半截存储也要能并出完整默认值 ──
  write(paths.config, { owner: { nickname: '漱月鸣筝' } });
  const cfg = readConfig(paths);
  assert.equal(cfg.owner.nickname, '漱月鸣筝');
  assert.equal(cfg.watch.intervalMinutes, 10);           // 默认值兜底
  assert.equal(cfg.persona.name, '大肥鱼');
  ok('readConfig 半截配置并出默认值');

  // ── 状态：跨天清零、字段补齐 ──
  write(paths.state, { date: '2000-01-01', watches: 9 });
  const stOld = readState(paths);
  assert.equal(stOld.date, new Date().toLocaleDateString('sv-SE'));
  assert.equal(stOld.watches, 0);
  assert.deepEqual(stOld.repliedIds, []);
  write(paths.state, {
    date: new Date().toLocaleDateString('sv-SE'),
    watches: 3,
    repliedIds: ['111'],
    queue: [
      { item_id: '111', title: 'A', kind: 'video', seen_at: '2026-10-26T00:00:00Z' },
      { item_id: '222', title: 'B', kind: 'video', seen_at: '2026-10-26T01:00:00Z' },
      { item_id: '333', title: 'C', kind: 'note', seen_at: '2026-10-26T02:00:00Z' },
    ],
  });
  ok('readState 跨天清零、字段补齐');

  // ── 队列视图 ──
  const qv = queueView(paths);
  assert.equal(qv.total, 3);
  assert.equal(qv.pending, 1);                    // 111 已回复，333 是图文
  assert.equal(qv.items.find(i => i.item_id === '111').status, 'replied');
  assert.equal(qv.items.find(i => i.item_id === '222').status, 'pending');
  ok('queueView 合成每条内容的状态');

  // ── 发送闸 ──
  write(path.join(paths.home, 'im-send-gate.json'), {
    blocked_until: Date.now() / 1000 + 42,
    blocked_reason: '安全验证',
    last_send_at: Date.now() / 1000 - 5,
  });
  const gate = readGate(paths);
  assert.ok(gate.cooldown_remaining_s > 40 && gate.cooldown_remaining_s <= 42);
  assert.equal(gate.blocked_reason, '安全验证');
  assert.equal(gate.last_send_ago_s, 5);
  write(path.join(paths.home, 'im-send-gate.json'), { last_send_at: Date.now() / 1000 - 900 });
  assert.equal(readGate(paths).cooldown_remaining_s, 0);
  ok('readGate 冷却剩余与过期归零');

  // ── 守护进程存活判定 ──
  write(paths.pid, { pid: process.pid, startedAt: 'now' });   // 自己一定活着
  assert.equal(daemonAlive(paths).running, true);
  write(paths.pid, { pid: 2147483000, startedAt: 'gone' });   // 不存在的 pid
  assert.equal(daemonAlive(paths).running, false);
  assert.equal(daemonAlive(paths).pid, 2147483000);
  ok('daemonAlive 按 pid 文件判定');

  // ── 日志 tail ──
  fs.writeFileSync(paths.log, Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n') + '\n');
  const lines = tailLog(5, paths);
  assert.deepEqual(lines, ['line-26', 'line-27', 'line-28', 'line-29', 'line-30']);
  assert.deepEqual(tailLog(999, paths).length, 30);           // 上限 400，取到全部
  assert.deepEqual(tailLog(3, paths), ['line-28', 'line-29', 'line-30']);
  ok('tailLog 取尾部且不超上限');

  // ── 配置补丁：钳制与拒收 ──
  const p1 = sanitizeConfigPatch({
    owner: { nickname: '  新主人  ' },
    watch: { intervalMinutes: 99999, dailyMax: -5, enabled: true, windows: [{ start: '09:00', end: '23:00' }] },
    evil: 'x',
  });
  assert.equal(p1.owner.nickname, '新主人');                    // 会 trim
  assert.ok(p1.watch.intervalMinutes <= 240);
  assert.ok(p1.watch.dailyMax >= 1);
  assert.ok(!('evil' in p1));
  assert.equal(sanitizeConfigPatch({ evil: 1 }), null);         // 全部不认识 → null
  assert.equal(sanitizeConfigPatch(null), null);
  ok('sanitizeConfigPatch 钳制范围、丢弃未知字段');

  // ── 配置写入：深合并、保留未知字段、原子替换 ──
  write(paths.config, { owner: { nickname: '旧' }, keepMe: { a: 1 } });
  const next = applyConfigPatch({ owner: { nickname: '新' }, watch: { enabled: false } }, paths);
  assert.equal(next.owner.nickname, '新');
  assert.deepEqual(next.keepMe, { a: 1 });                      // 未知字段不丢
  assert.equal(next.watch.enabled, false);
  assert.equal(readConfig(paths).owner.nickname, '新');         // 落盘可读回
  ok('applyConfigPatch 深合并并保留未知字段');

  // ── 汇总（面板首屏）──
  const s = summary(paths);
  assert.equal(s.ok, true);
  assert.equal(s.owner, '新');
  assert.equal(s.queue.total, 3);
  assert.ok('gate' in s && 'memory' in s && 'daemon' in s);
  ok('summary 一次给齐首屏数据');

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
