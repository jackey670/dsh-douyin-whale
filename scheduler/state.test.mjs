/**
 * scheduler/state.test.mjs —— 状态、队列、回复标记、提示词的离线自测
 *
 * 重点守住四个曾经踩过的坑：
 *   ① 跨天不能清 repliedIds / queue（否则旧卡片第二天被重回一遍）
 *   ② 文字消息必须能进队列（以前只收带 item_id 的卡片）
 *   ③ 队列顺序必须是旧→新，失败 3 次后不再堵住队头
 *   ④ 一轮只发一条的标记要能拒绝第二次发送、能记录正文
 *
 * 运行：node scheduler/state.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  MAX_ATTEMPTS, bumpAttempt, mergeQueue, pendingOf, readState, textId, writeState,
} from './state.mjs';
import {
  beginReplyMarker, endReplyMarker, markerPath, markReplySent, readReplyMarker,
} from '../lib/reply_marker.js';
import { buildTaskPrompt } from './prompt.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-state-'));
const stateFile = path.join(dir, 'state.json');
const home = path.join(dir, 'home');
const today = new Date().toLocaleDateString('sv-SE');

let pass = 0;
const ok = (name) => { pass++; console.log(`[PASS] ${name}`); };

try {
  // ① 跨天只清计数，保留已回复 id 和队列
  {
    writeState(stateFile, {
      date: '2020-01-01',
      watches: 5,
      repliedIds: ['V1', 'text:abc'],
      queue: [{
        id: 'V1', item_id: 'V1', kind: 'video', title: '旧视频',
        seen_at: '2020-01-01T00:00:00.000Z', attempts: 0,
      }],
      loginFails: 2,
      loginBlockedUntil: '2020-01-01T01:00:00.000Z',
    });
    const st = readState(stateFile);
    assert.equal(st.date, today);
    assert.equal(st.watches, 0);
    assert.equal(st.loginFails, 0);
    assert.equal(st.loginBlockedUntil, '');
    assert.deepEqual(st.repliedIds, ['V1', 'text:abc']);
    assert.equal(st.queue.length, 1);
    ok('① 跨天保留 repliedIds/queue，只清计数');
  }

  // ② 文字/图文/视频都能入队；重复内容只进一次；顺序保持传入顺序
  {
    const items = [
      { kind: 'text', from: 'them', text: '在吗' },
      { kind: 'video', item_id: 'V2', title: '视频2' },
      { kind: 'note', item_id: 'N1', title: '图文1', text: '图文正文' },
      { kind: 'text', from: 'them', text: '在吗' },
      { kind: 'text', from: 'them', text: '   ' },
    ];
    const q = mergeQueue([], items);
    assert.equal(q.length, 3);
    assert.deepEqual(q.map((x) => x.kind), ['text', 'video', 'note']);
    assert.equal(q[0].id, textId('them', '在吗'));
    assert.equal(q[0].item_id, '');
    assert.equal(q[1].id, 'V2');
    assert.equal(q[2].id, 'N1');
    // 再并一次不会重复
    assert.equal(mergeQueue(q, items).length, 3);
    ok('② 文字/图文/视频入队 + 去重 + 顺序');
  }

  // ③ 待处理：排除已回复与失败项，按 seen_at 旧→新
  {
    const q = [
      { id: 'A', kind: 'video', seen_at: '2020-01-01T00:00:02.000Z', attempts: 0 },
      { id: 'B', kind: 'video', seen_at: '2020-01-01T00:00:01.000Z', attempts: 0 },
      { id: 'C', kind: 'video', seen_at: '2020-01-01T00:00:03.000Z', attempts: MAX_ATTEMPTS },
      { id: 'D', kind: 'text', seen_at: '2020-01-01T00:00:00.000Z', attempts: 1 },
    ];
    assert.deepEqual(pendingOf(q, []).map((x) => x.id), ['D', 'B', 'A']);
    assert.deepEqual(pendingOf(q, ['B']).map((x) => x.id), ['D', 'A']);
    assert.deepEqual(pendingOf(q, ['B', 'D']).map((x) => x.id), ['A']);
    ok('③ pendingOf 排除已回复/失败，旧→新');
  }

  // ④ 失败次数累加，不改原数组
  {
    const q = [{ id: 'A', kind: 'video', seen_at: '2020-01-01T00:00:00.000Z', attempts: 0 }];
    const q2 = bumpAttempt(q, 'A', 'no-send');
    assert.equal(q2[0].attempts, 1);
    assert.equal(q2[0].last_error, 'no-send');
    assert.equal(q[0].attempts, 0);
    ok('④ bumpAttempt 只改副本');
  }

  // ⑤ 回复标记：写入 → 发送成功记正文 → 清理
  {
    assert.equal(readReplyMarker(home), null);
    beginReplyMarker(home, { id: 'V2', kind: 'video' });
    let m = readReplyMarker(home);
    assert.equal(m.sent, false);
    assert.equal(m.item_id, 'V2');
    markReplySent(home, '回复正文');
    m = readReplyMarker(home);
    assert.equal(m.sent, true);
    assert.equal(m.text, '回复正文');
    endReplyMarker(home);
    assert.equal(readReplyMarker(home), null);
    ok('⑤ 回复标记写入/记账/清理');
  }

  // ⑥ 过期标记视为不存在（手动发私信不受影响）
  {
    beginReplyMarker(home, { id: 'X', kind: 'text' });
    const file = markerPath(home);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    j.expires_at = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(j), 'utf8');
    assert.equal(readReplyMarker(home), null);
    endReplyMarker(home);
    ok('⑥ 过期标记不生效');
  }

  // ⑦ 三种提示词各司其职
  {
    const base = { ownerNick: '主人', pendingCount: 2, root: 'C:/repo', home: 'C:/dsh' };
    const text = buildTaskPrompt({ ...base, item: { id: 'text:1', kind: 'text', text: '在吗' } });
    assert.match(text, /在吗/);
    assert.doesNotMatch(text, /frames/);
    assert.match(text, /本轮风格/);

    const note = buildTaskPrompt({
      ...base, item: { id: 'N1', item_id: 'N1', kind: 'note', title: '图文标题', text: '正文' },
    });
    assert.match(note, /拿不到画面/);
    assert.match(note, /图文标题/);
    assert.doesNotMatch(note, /frames N1/);
    assert.match(note, /本轮风格/);

    const video = buildTaskPrompt({
      ...base, item: { id: 'V9', item_id: 'V9', kind: 'video', title: '视频标题' },
    });
    assert.match(video, /内容 ID：V9/);
    assert.match(video, /frames V9/);
    assert.match(video, /FRAMES_FAILED/);
    assert.match(video, /whale-diary\.md/);
    assert.match(video, /本轮风格/);
    ok('⑦ 视频/图文/文字三种提示词');
  }

  // ⑧ 队列上限：只留最近 50 条
  {
    const many = Array.from({ length: 60 }, (_, i) => ({
      kind: 'video', item_id: `V${i}`, title: `t${i}`,
    }));
    const q = mergeQueue([], many, { max: 50 });
    assert.equal(q.length, 50);
    assert.equal(q[0].id, 'V10');
    assert.equal(q.at(-1).id, 'V59');
    ok('⑧ 队列上限保留最近 50 条');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
