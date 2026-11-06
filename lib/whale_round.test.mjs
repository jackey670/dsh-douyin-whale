/**
 * lib/whale_round.test.mjs —— 共享回合引擎的单测（假 brain / 内存状态 / 真 ops）。
 *
 * 引擎是调度器与值班大脑共用的主循环，这里把两种 brain、三种送达形态、
 * 三类提前退出都钉住。运行：node lib/whale_round.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { runWatchRound } from './whale_round.js';
import { markReplySent, readReplyMarker } from './reply_marker.js';
import {
  bumpAttempt, capRepliedIds, mergeQueue, pendingOf, textId, MAX_ATTEMPTS,
} from '../scheduler/state.mjs';

let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

const msg = (from, text = '', extra = {}) => ({
  from, text, kind: 'text', item_id: '', image_uri: '', image_id: '', ...extra,
});
const baseCfg = { watch: { dailyMax: 0 }, meme: { enabled: false } };
const state0 = () => ({ date: '2026-11-06', watches: 0, memes: 0, shares: 0, repliedIds: [], queue: [] });

/** 内存状态 + 真 ops + 可编程 brain/checkDm 的一轮引擎 */
function scaffold({
  cfg = baseCfg,
  st0 = state0(),
  dispatch = async () => ({ ok: true, response: 'ok' }),
  after = null,
  onEmpty = null,
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-round-'));
  let st = JSON.parse(JSON.stringify(st0));
  const logLines = [];
  const sent = [];
  const run = (dm) => runWatchRound({
    cfg, dm, ownerNick: '主人', manual: false,
    state: {
      read: () => JSON.parse(JSON.stringify(st)),
      update: (mutate) => { st = mutate(st); return st; },
    },
    ops: { mergeQueue, pendingOf, bumpAttempt, capRepliedIds, maxAttempts: MAX_ATTEMPTS },
    brain: {
      dispatch: async (ctx) => { sent.push(ctx); return dispatch(ctx, home); },
    },
    buildPrompt: ({ item }) => `prompt:${item.id}`,
    checkDm: () => (typeof after === 'function' ? after() : after),
    log: (m) => logLines.push(m),
    home,
    mem: null,
    root: process.cwd(),
    mergeMemory: () => { st._memoryMerged = true; },
    onEmpty,
  });
  return {
    home, logLines, sent,
    state: () => st,
    run,
    cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

try {
  // ── ① 文字送达：入队 → 派活 → 标记正文回读命中 → 推进状态 ──
  {
    const s = scaffold({
      dispatch: async (ctx, home) => {
        markReplySent(home, '收到啦', {});
        return { ok: true, response: 'ok' };
      },
      after: { messages: [msg('me', '收到啦')] },
    });
    const r = await s.run({ messages: [msg('them', '在吗')] });
    assert.equal(r.round, 'delivered');
    assert.equal(s.state().watches, 1);
    assert.ok(s.state().repliedIds.includes(textId('them', '在吗')), '文字按 textId 入已回复');
    assert.equal(s.state()._memoryMerged, true);
    assert.ok(s.logLines.some((l) => l.includes('已确认送达') && l.includes('回复 3 字')));
    assert.equal(readReplyMarker(s.home), null, '标记应被清理');
    s.cleanup();
    ok('① 文字送达推进状态并清标记');
  }

  // ── ② 原生表情：媒体条数 +1 ──
  {
    const s = scaffold({
      dispatch: async (ctx, home) => {
        markReplySent(home, '', { emoji: true });
        return { ok: true, response: 'ok' };
      },
      after: { messages: [msg('me', '', { kind: 'sticker', image_uri: 'emoji://x' })] },
    });
    const r = await s.run({ messages: [msg('them', '晚上好')] });
    assert.equal(r.round, 'delivered');
    assert.ok(s.logLines.some((l) => l.includes('原生表情，媒体 0→1 条')));
    s.cleanup();
    ok('② 原生表情按媒体 +1 确认');
  }

  // ── ③ 分享卡片：按 item_id 认 ──
  {
    const s = scaffold({
      dispatch: async (ctx, home) => {
        markReplySent(home, '', { video: 'V9' });
        return { ok: true, response: 'ok' };
      },
      after: { messages: [msg('me', '', { kind: 'video', item_id: 'V9' })] },
    });
    const r = await s.run({ messages: [msg('them', '', { kind: 'video', item_id: 'V1', title: 'T' })] });
    assert.equal(r.round, 'delivered');
    assert.ok(s.logLines.some((l) => l.includes('分享卡片 V9')));
    s.cleanup();
    ok('③ 分享卡片按 item_id 确认');
  }

  // ── ④ 派活失败：不计 attempts、清标记 ──
  {
    const s = scaffold({
      dispatch: async () => ({ ok: false, reason: '值班会话没拉起来' }),
    });
    const r = await s.run({ messages: [msg('them', '在吗')] });
    assert.equal(r.round, 'dispatch-failed');
    const q = s.state().queue.find((x) => x.kind === 'text');
    assert.equal(q.attempts, 0, '投递失败不该记 attempts');
    assert.equal(readReplyMarker(s.home), null);
    s.cleanup();
    ok('④ 派活失败不记 attempts');
  }

  // ── ⑤ fiber 读不到：投递前 bail ──
  {
    const s = scaffold({
      st0: { ...state0(), queue: [{
        id: textId('them', '在吗'), item_id: '', kind: 'text', text: '在吗',
        title: '', image_url: '', image_id: '', seen_at: '2026-11-06T00:00:00.000Z',
        attempts: 0, last_error: '',
      }] },
    });
    const r = await s.run({ messages: ['纯文本行'] });
    assert.equal(r.round, 'fiber-unreadable');
    assert.equal(s.sent.length, 0);
    assert.ok(s.logLines.some((l) => l.includes('无法回读确认')));
    s.cleanup();
    ok('⑤ fiber 不可读不投递');
  }

  // ── ⑥ 队列空：走 onEmpty，不派活 ──
  {
    let emptySeen = null;
    const s = scaffold({
      st0: { ...state0(), repliedIds: [textId('them', '已回过的')] },
      onEmpty: async ({ merged, manual }) => { emptySeen = { merged, manual }; },
    });
    const r = await s.run({ messages: [msg('them', '已回过的')] });
    assert.equal(r.round, 'empty');
    assert.notEqual(emptySeen, null);
    assert.equal(emptySeen.manual, false);
    assert.equal(s.sent.length, 0);
    s.cleanup();
    ok('⑥ 空队列走 onEmpty');
  }

  // ── ⑦ daily-max：非 manual 拦截 ──
  {
    const s = scaffold({
      cfg: { watch: { dailyMax: 5 }, meme: { enabled: false } },
      st0: { ...state0(), watches: 5 },
    });
    const r = await s.run({ messages: [msg('them', '在吗')] });
    assert.equal(r.round, 'daily-max');
    assert.equal(s.sent.length, 0);
    s.cleanup();
    ok('⑦ daily-max 拦截');
  }

  // ── ⑧ 未确认：bumpAttempt 记原因 ──
  {
    const s = scaffold({
      dispatch: async (ctx, home) => {
        markReplySent(home, '这条没到', {});
        return { ok: true, response: 'ok' };
      },
      after: { messages: [msg('me', '旧消息')] },   // 回读无新增
    });
    const r = await s.run({ messages: [msg('them', '在吗')] });
    assert.equal(r.round, 'unconfirmed');
    const q = s.state().queue.find((x) => x.kind === 'text');
    assert.equal(q.attempts, 1);
    assert.equal(q.last_error, 'sent-but-not-readback');
    assert.ok(s.logLines.some((l) => l.includes('未确认到私信') && l.includes('sent-but-not-readback')));
    s.cleanup();
    ok('⑧ 未确认记 attempts');
  }

  console.log(`\nALL PASSED (${pass})`);
} catch (e) {
  console.error('FAILED');
  throw e;
}
