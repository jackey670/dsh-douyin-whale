/**
 * lib/reply_marker.js —— 「一轮只发一条私信」的本地标记
 *
 * 调度器/值班插件在唤醒 agent 前写标记；`douyin.mjs send --send` 读标记：
 *   · 已经 sent=true → 拒绝第二条（防止 agent 顺着对话多回几条）
 *   · 发送成功后把 sent=true 和正文写回 → 调度器能确认「这条回复属于哪条内容」
 *
 * 标记 60 分钟过期。没有调度器在跑时（手动发私信）完全不受影响。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 唤醒最长 45 分钟（scheduler.mjs 的超时），标记必须活得比它久，
// 否则 agent 跑太久时标记先过期，第二轮就能再发一条。
export const REPLY_WINDOW_MS = 60 * 60_000;

export const defaultHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

export const markerPath = (home = defaultHome()) => path.join(home, '.whale-reply-marker.json');

export function beginReplyMarker(home, item) {
  const file = markerPath(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      wake_id: `wake-${Date.now()}`,
      item_id: item?.id || item?.item_id || '',
      kind: item?.kind || 'video',
      sent: false,
      text: '',
      image: false,
      video: '',
      emoji: false,
      expires_at: new Date(Date.now() + REPLY_WINDOW_MS).toISOString(),
    }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function readReplyMarker(home) {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(home), 'utf8'));
    if (!m || !m.wake_id) return null;
    if (Date.parse(m.expires_at || '') < Date.now()) return null;
    return m;
  } catch {
    return null;
  }
}

/** 真发成功后调用：记下正文，供调度器回读比对；image 标记这轮带了表情包；
 *  emoji 标记这轮发的是抖音原生表情（没有正文，回读按「我发的媒体条数 +1」确认） */
export function markReplySent(home, text, { image = false, video = '', emoji = false } = {}) {
  const m = readReplyMarker(home);
  if (!m) return false;
  try {
    fs.writeFileSync(markerPath(home), `${JSON.stringify({
      ...m, sent: true, text, image, video, emoji, sent_at: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function endReplyMarker(home) {
  try { fs.rmSync(markerPath(home), { force: true }); } catch { /* ignore */ }
}

/**
 * 封存标记：保留 sent/text/video 等字段，附加 `sealed_until`。
 * 用途：值班「确认发送后提前收轮」时 agent 可能还在生成后续内容——
 * 不能直接删标记（否则闸门失守，agent 可能再发一条）；封存期内闸门继续拦，
 * 过期后自动放行（手动发送恢复）。下一次 beginReplyMarker 会整体覆盖。
 */
export function sealReplyMarker(home, sealMs = 15 * 60_000) {
  const m = readReplyMarker(home);
  if (!m?.sent) return false;
  try {
    fs.writeFileSync(markerPath(home), `${JSON.stringify({
      ...m,
      sealed_until: new Date(Date.now() + Math.max(1000, Number(sealMs) || 0)).toISOString(),
    }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 发送闸门：本轮已发过（sent）就拦。封存标记过期后放行；畸形时间保守拦。 */
export function markerBlocksSend(marker, now = Date.now()) {
  if (!marker?.sent) return false;
  if (!marker.sealed_until) return true;
  const until = Date.parse(marker.sealed_until);
  return !Number.isFinite(until) || until > now;
}
