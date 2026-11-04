/**
 * lib/whale_readback.test.mjs —— 共享回读判定的单测（纯函数，不碰浏览器/状态）。
 *
 * 覆盖两条路径共用的三种送达形态：
 *   文字（按新出现的正文） / 原生表情（媒体条数 +1） / 分享卡片（item_id）
 * 以及 fiber 读不到时的保守行为。
 *
 * 运行：node lib/whale_readback.test.mjs
 */
import assert from 'node:assert/strict';

import {
  deliverySummary,
  judgeDelivery,
  meCardIds,
  meMediaCount,
  meTextSet,
} from './whale_readback.js';

let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

const msg = (from, text = '', extra = {}) => ({
  from, text, kind: 'text', item_id: '', image_uri: '', image_id: '', ...extra,
});
const dm = (...messages) => ({ messages });

try {
  // ── ① 文字：新出现一条与标记正文相同的「我发的」消息 ──
  {
    const before = dm(msg('them', '看看这个'), msg('me', '旧回复'));
    const after = dm(msg('them', '看看这个'), msg('me', '旧回复'), msg('me', '这条是新的'));
    const j = judgeDelivery({ marker: { sent: true, text: '这条是新的' }, before, after });
    assert.equal(j.delivered, true);
    assert.equal(j.textDelivered, true);
    assert.equal(j.emojiDelivered, false);
    assert.equal(j.cardDelivered, false);
    assert.deepEqual(j.fresh, ['这条是新的']);
    assert.match(deliverySummary(j), /回复 5 字/);
    ok('① 文字按新正文确认');
  }

  // ── ② 旧消息滚出 DOM（条数不变、集合差仍能认出）──
  {
    const before = dm(msg('me', 'A'), msg('me', 'B'));
    const after = dm(msg('me', 'B'), msg('me', 'C'));   // A 滚出，C 新进
    const j = judgeDelivery({ marker: { text: 'C' }, before, after });
    assert.equal(j.delivered, true);
    assert.deepEqual(j.fresh, ['C']);
    ok('② 集合差不受滚动影响');
  }

  // ── ③ 没标记 / 正文对不上 → 不确认 ──
  {
    const before = dm(msg('me', '旧'));
    const after = dm(msg('me', '旧'), msg('me', '新'));
    assert.equal(judgeDelivery({ marker: null, before, after }).delivered, false);
    assert.equal(judgeDelivery({ marker: { sent: true, text: '别的' }, before, after }).delivered, false);
    ok('③ 无标记/对不上不确认');
  }

  // ── ④ 原生表情：媒体条数 +1 + marker.emoji ──
  {
    const before = dm(msg('them', '', { kind: 'sticker', image_uri: 'x' }), msg('me', '话'));
    const after = dm(msg('them', '', { kind: 'sticker', image_uri: 'x' }), msg('me', '话'),
      msg('me', '', { kind: 'sticker', image_uri: 'emoji://new' }));
    const j = judgeDelivery({ marker: { sent: true, emoji: true }, before, after });
    assert.equal(j.delivered, true);
    assert.equal(j.emojiDelivered, true);
    assert.equal(j.mediaBefore, 0);
    assert.equal(j.mediaAfter, 1);
    assert.match(deliverySummary(j), /原生表情，媒体 0→1 条/);
    ok('④ 原生表情按媒体 +1 确认');
  }

  // ── ⑤ 表情标记但媒体没涨 → 不确认 ──
  {
    const d = dm(msg('me', '', { kind: 'sticker', image_uri: 'x' }));
    assert.equal(judgeDelivery({ marker: { sent: true, emoji: true }, before: d, after: d }).delivered, false);
    ok('⑤ 媒体没涨不确认');
  }

  // ── ⑥ 分享卡片：按 item_id 认 ──
  {
    const before = dm(msg('me', '旧'));
    const after = dm(msg('me', '旧'),
      msg('me', '', { kind: 'video', item_id: 'V9' }));
    const j = judgeDelivery({ marker: { sent: true, video: 'V9' }, before, after });
    assert.equal(j.delivered, true);
    assert.equal(j.cardDelivered, true);
    assert.equal(meCardIds(after).has('V9'), true);
    assert.match(deliverySummary(j), /分享卡片/);
    // 别的 aweme 不算
    assert.equal(judgeDelivery({ marker: { video: 'V1' }, before, after }).delivered, false);
    ok('⑥ 分享卡片按 item_id 确认');
  }

  // ── ⑦ fiber 读不到：返回 null，判定保守 ──
  {
    assert.equal(meTextSet(dm('纯文本行')), null);
    assert.equal(meTextSet(dm()), null);
    assert.equal(meMediaCount(dm('纯文本行')), null);
    const j = judgeDelivery({ marker: { sent: true, text: 'x' }, before: dm('字符串'), after: dm('字符串') });
    assert.equal(j.delivered, false);
    assert.equal(j.textAfter, null);
    ok('⑦ fiber 不可用时保守不确认');
  }

  console.log(`\nALL PASSED (${pass})`);
} catch (e) {
  console.error('FAILED');
  throw e;
}
