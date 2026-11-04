/**
 * lib/whale_readback.js —— 两条运行路径共享的「回读判定」。
 *
 * 调度器（scheduler.mjs）和值班大脑（whale_tick.js）以前各写一份：
 * 数我发的文字、数媒体、认卡片、按标记判断送达。字面一样，但改一处忘另一处
 * 就会出「卡片永远回读不到」「纯表情被当没发」这类事故（v1.9.1 刚修过）。
 *
 * 这里只做**纯函数**：输入两次读私信的 JSON + 回复标记，输出判定结果。
 * 浏览器、状态文件、日志都不碰，方便单测。
 */

/** 空白归一化：抖音会压空白，回读也要按同一规则比。 */
export const normalizeText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 「我发的」消息正文集合；完全读不到结构化消息时返回 null。 */
export function meTextSet(dm) {
  const msgs = Array.isArray(dm?.messages) ? dm.messages : [];
  const objs = msgs.filter((m) => m && typeof m === 'object');
  if (!objs.length) return null;
  const set = new Set();
  for (const m of objs) {
    if (m.from !== 'me') continue;
    const t = normalizeText(m.text);
    if (t) set.add(t);
  }
  return set;
}

/** 「我发的」媒体条数（原生表情/贴纸/图片）。读不到时返回 null。 */
export function meMediaCount(dm) {
  const msgs = Array.isArray(dm?.messages) ? dm.messages : [];
  const objs = msgs.filter((m) => m && typeof m === 'object');
  if (!objs.length) return null;
  return objs.filter((m) => m.from === 'me' && (
    m.image_uri || m.image_id || m.kind === 'sticker'
    || (String(m.text || '').trim() === '' && !m.item_id)
  )).length;
}

/** 「我发的」视频卡片 itemId 集合（卡片没有正文，只能认 item_id）。 */
export function meCardIds(dm) {
  const msgs = Array.isArray(dm?.messages) ? dm.messages : [];
  return new Set(msgs
    .filter((m) => m && typeof m === 'object' && m.from === 'me' && m.item_id)
    .map((m) => String(m.item_id)));
}

/**
 * 判断这一轮到底发出去没有。
 *
 * @param {object} opts
 *   marker  回复标记（lib/reply_marker.js），可能为 null
 *   before  派任务前读到的私信 JSON
 *   after   回读到的私信 JSON（读失败传 null）
 * @returns {{
 *   delivered: boolean, textDelivered: boolean, emojiDelivered: boolean,
 *   cardDelivered: boolean, expected: string, fresh: string[],
 *   mediaBefore: number|null, mediaAfter: number|null,
 *   textBefore: Set<string>|null, textAfter: Set<string>|null,
 * }}
 */
export function judgeDelivery({ marker = null, before = null, after = null } = {}) {
  const textBefore = before ? meTextSet(before) : null;
  const textAfter = after ? meTextSet(after) : null;
  const fresh = (textBefore && textAfter)
    ? [...textAfter].filter((t) => !textBefore.has(t))
    : [];
  const expected = normalizeText(marker?.text);
  const textDelivered = Boolean(expected)
    && fresh.some((t) => t === expected || t.includes(expected) || expected.includes(t));

  const mediaBefore = before ? meMediaCount(before) : null;
  const mediaAfter = after ? meMediaCount(after) : null;
  const emojiDelivered = Boolean(marker?.emoji)
    && mediaBefore !== null && mediaAfter !== null && mediaAfter > mediaBefore;

  const cardDelivered = Boolean(marker?.video) && after
    ? meCardIds(after).has(String(marker.video))
    : false;

  return {
    delivered: textDelivered || emojiDelivered || cardDelivered,
    textDelivered,
    emojiDelivered,
    cardDelivered,
    expected,
    fresh,
    mediaBefore,
    mediaAfter,
    textBefore,
    textAfter,
  };
}

/** 送达日志的一句话摘要（两条路径共用同一套措辞）。 */
export function deliverySummary(j) {
  if (j.cardDelivered && !j.textDelivered && !j.emojiDelivered) {
    return `分享卡片，回读确认`;
  }
  if (j.emojiDelivered && !j.textDelivered) {
    return `原生表情，媒体 ${j.mediaBefore}→${j.mediaAfter} 条`;
  }
  return `回复 ${j.expected.length || (j.fresh[0]?.length ?? 0)} 字`;
}
