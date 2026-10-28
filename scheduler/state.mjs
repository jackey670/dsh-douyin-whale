/**
 * scheduler/state.mjs —— 调度器状态与队列（纯函数，可离线测试）
 *
 * 从 scheduler.mjs 里抽出来的原因：跨天重置、队列合并、重试次数这些
 * 规则直接决定「回哪一条、按什么顺序回」，必须能单独测。
 *
 * 状态形状：
 *   {
 *     date, watches, repliedIds,
 *     queue: [{ id, item_id, kind, title, text, seen_at, attempts, last_error }],
 *     loginFails, loginBlockedUntil
 *   }
 *
 * 三个不变量：
 *   ① **跨天只清计数，不清已回复 id**。以前连 repliedIds/queue 一起清，
 *      第二天私信页上还留着的旧卡片会被当成新内容再回一遍 —— 顺序乱、
 *      内容对不上号，很大一部分来自这里。
 *   ② **队列按抖音侧顺序（旧→新）追加**，处理时永远取最老的一条。
 *   ③ 文字消息也要进队列（kind=text），不能只收带 item_id 的卡片。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 同一条内容最多尝试几轮；超过就标记 failed，避免永远卡住队列头 */
export const MAX_ATTEMPTS = 3;

/** 一条文字消息在队列里的稳定 id（DOM 没有消息 id，只能对内容做哈希） */
export function textId(from, text) {
  const h = createHash('sha1')
    .update(`${from || 'unknown'}|${String(text || '').trim()}`)
    .digest('hex')
    .slice(0, 16);
  return `text:${h}`;
}

export const today = (now = new Date()) => now.toLocaleDateString('sv-SE');

/** 旧状态没有 id 字段，读的时候补齐（老队列项都是卡片） */
export function normalizeQueue(queue) {
  if (!Array.isArray(queue)) return [];
  return queue
    .filter((q) => q && (q.id || q.item_id))
    .map((q) => ({
      id: String(q.id || q.item_id),
      item_id: String(q.item_id || (String(q.id || '').startsWith('text:') ? '' : q.id)),
      kind: q.kind === 'video' || q.kind === 'note' ? q.kind : 'text',
      title: String(q.title || '').slice(0, 140),
      text: String(q.text || '').slice(0, 300),
      seen_at: q.seen_at || new Date(0).toISOString(),
      attempts: Number(q.attempts) || 0,
      last_error: String(q.last_error || ''),
    }));
}

export function readState(file, now = new Date()) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { raw = {}; }
  const repliedIds = Array.isArray(raw.repliedIds) ? raw.repliedIds.filter((x) => typeof x === 'string') : [];
  const queue = normalizeQueue(raw.queue);
  if (raw.date !== today(now)) {
    // 跨天：只重置当天计数，保留 repliedIds / queue
    return {
      date: today(now), watches: 0, repliedIds, queue,
      loginFails: 0, loginBlockedUntil: '',
    };
  }
  return {
    date: raw.date,
    watches: Number(raw.watches) || 0,
    repliedIds,
    queue,
    loginFails: Number(raw.loginFails) || 0,
    loginBlockedUntil: typeof raw.loginBlockedUntil === 'string' ? raw.loginBlockedUntil : '',
  };
}

export function writeState(file, st) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function updateState(file, mutate, now = new Date()) {
  const next = mutate(readState(file, now));
  writeState(file, next);
  return next;
}

/** 只保留最近 N 个已回复 id，防止状态文件无限增长 */
export function capRepliedIds(ids, max = 300) {
  const arr = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  return arr.length > max ? arr.slice(-max) : arr;
}

/**
 * 把本轮读到的主人消息并进队列。
 *
 * items 必须是**旧→新**（douyin_im.py 已经排好）。带 item_id 的算卡片
 * （video/note），不带 item_id 但有正文的算 text。同一个 id 只进一次。
 */
export function mergeQueue(queue, items, { max = 50, now = new Date() } = {}) {
  const base = normalizeQueue(queue);
  const seen = new Set(base.map((q) => q.id));
  const at = now.toISOString();
  for (const it of items || []) {
    if (!it) continue;
    const kind = it.kind === 'video' ? 'video' : it.kind === 'note' ? 'note' : 'text';
    const itemId = String(it.item_id || '');
    const text = String(it.text || '').trim();
    if (kind !== 'text' && !itemId) continue;
    if (kind === 'text' && !text) continue;
    const id = kind === 'text' ? textId(it.from, text) : itemId;
    if (seen.has(id)) continue;
    seen.add(id);
    base.push({
      id,
      item_id: kind === 'text' ? '' : itemId,
      kind,
      title: String(it.title || '').slice(0, 140),
      text: kind === 'text' ? text.slice(0, 300) : '',
      seen_at: at,
      attempts: 0,
      last_error: '',
    });
  }
  return base.length > max ? base.slice(-max) : base;
}

/** 待处理：没回过、且没超过重试上限；按入队顺序（旧→新） */
export function pendingOf(queue, repliedIds) {
  const replied = new Set(repliedIds || []);
  return normalizeQueue(queue)
    .filter((q) => !replied.has(q.id) && q.attempts < MAX_ATTEMPTS)
    .sort((a, b) => String(a.seen_at).localeCompare(String(b.seen_at)));
}

/** 记一次失败尝试，返回新的 queue（不改原数组） */
export function bumpAttempt(queue, id, error = '') {
  return normalizeQueue(queue).map((q) => (
    q.id === id
      ? { ...q, attempts: q.attempts + 1, last_error: String(error).slice(0, 200) }
      : q
  ));
}

/** 状态里的队列项（面板/调试用） */
export function findQueueItem(queue, id) {
  return normalizeQueue(queue).find((q) => q.id === id) || null;
}
