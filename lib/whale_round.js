/**
 * lib/whale_round.js —— 一轮「看私信 → 派活 → 回读确认」的共享主循环。
 *
 * 调度器（scheduler.mjs）和值班大脑（whale_tick.js）以前各写一份 tick 主体：
 * 队列合并 → 挑最早 → 下载贴图 → 建提示词 → 写标记 → 投递 → 等空闲 → 回读 →
 * 推进状态。v1.9.3 起收进这里，两条路径只保留：
 *   · 前置检查（时段/开关/登录冷却/重入守卫）——各自的环境不同；
 *   · brain 适配器——shell 唤醒（wakeAgent）或宿主会话（dutyAgent）；
 *   · 失败/空转的文案——写在各自的 onEmpty / 调用方。
 *
 * 纯注入：状态走 `state = { read, update }`，队列操作走 `ops`（两边模块语义
 * 已验证等价），这样不必强迫某一侧换状态模块。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { deliverySummary, judgeDelivery, meTextSet } from './whale_readback.js';
import { beginReplyMarker, endReplyMarker, readReplyMarker } from './reply_marker.js';

/** 观看时段（end=24:00 表示当天结束；空/缺省 = 全天；畸形串按 00:00 处理） */
export function inWatchWindow(windows, now = new Date()) {
  const arr = Array.isArray(windows) && windows.length
    ? windows : [{ start: '00:00', end: '24:00' }];
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm ?? '').split(':').map(Number);
    const hh = Number.isFinite(h) ? h : 0;
    const mm = Number.isFinite(m) ? m : 0;
    return (hh === 24 ? 1440 : hh * 60) + mm;
  };
  return arr.some((w) => {
    const start = toMin(w?.start);
    const end = toMin(w?.end);
    return minutes >= start && minutes < end;
  });
}

/** 主人发来的内容 → 待入队条目。视频/图文带 item_id；表情（501/507）和
 *  纯文字没有。文字只取最近 5 条：第一次接入时别把历史聊天一口气回完。 */
export function collectIncoming(dm) {
  const msgs = Array.isArray(dm?.messages) ? dm.messages : [];
  const all = msgs.filter((m) => m && typeof m === 'object' && m.from !== 'me');
  const textMsgs = all.filter((m) => !m.item_id && m.kind !== 'sticker' && String(m.text || '').trim());
  const keepTexts = new Set(textMsgs.slice(-5));
  return all.filter((m) => m.item_id || m.kind === 'sticker' || keepTexts.has(m));
}

/** 本轮是否允许配表情包：主人发表情必须带图回敬；其余按概率 + 每日上限。 */
export function memeAllowedFor({ kind, cfg, merged }) {
  if (kind === 'sticker') return true;
  const memeCfg = cfg.meme ?? {};
  return memeCfg.enabled !== false
    && Math.random() < (Number(memeCfg.probability) || 0.3)
    && ((merged.memes ?? 0) < (Number(memeCfg.maxPerDay) || 6));
}

/** 主动分享轮的闸门（纯函数，两条路径共用同一套条件）。
 *  依次看：开关 → 手动跳过 → 概率 → 每日上限 → 最小间隔（省 token 的关键）。 */
export function shouldProactiveShare({
  pc = {}, merged = {}, manual = false, now = new Date(),
  lastShareAt = '', minIntervalMinutes = 120,
} = {}) {
  if (pc.enabled === false) return { ok: false, reason: 'disabled' };
  if (manual) return { ok: false, reason: 'manual' };
  const probability = Number(pc.probability);
  if (!(probability > 0) || Math.random() >= probability) return { ok: false, reason: 'roll' };
  const maxPerDay = Number(pc.maxPerDay) || 3;
  if ((merged.shares ?? 0) >= maxPerDay) return { ok: false, reason: 'daily-max' };
  const minMs = (Number(minIntervalMinutes) || 120) * 60_000;
  const last = Date.parse(lastShareAt || '') || 0;
  if (last && now.getTime() - last < minMs) return { ok: false, reason: 'too-soon' };
  return { ok: true };
}

/**
 * 跑一轮回复主循环。dm 必须是已经读到的会话数据（调用方先处理 NEED_LOGIN 等）。
 *
 * @param {object} opts
 *   cfg         运行配置（watch.dailyMax / meme.*）
 *   dm          checkDm 的成功结果
 *   ownerNick   主人昵称
 *   manual      手动触发（跳过 dailyMax；onEmpty 自行决定日志）
 *   state       { read(), update(mutate) } —— 读写调度器状态文件
 *   ops         { mergeQueue, pendingOf, bumpAttempt, capRepliedIds, maxAttempts }
 *   brain       { dispatch({prompt,item}) -> {ok, response?, reason?}, awaitIdle?() }
 *   buildPrompt ({ item, ownerNick, pendingCount, mem, memeAllowed }) => string
 *   checkDm     () => after（回读；闭包封装 py/dataDir/log）
 *   log         (msg) => void
 *   home        回复标记目录（DSH_HOME）
 *   mem         dmContext 结果（可空）
 *   root        插件根（找 douyin.mjs 下载贴图）
 *   mergeMemory (after) => void     合并会话记忆（引擎内 try/catch）
 *   onEmpty     async ({ merged, manual }) => void —— 队列空时（值班：主动分享）
 * @returns { round, merged, next?, r?, j?, after? }
 *   round: 'daily-max' | 'empty' | 'fiber-unreadable' | 'dispatch-failed'
 *        | 'delivered' | 'unconfirmed'
 */
export async function runWatchRound({
  cfg, dm, ownerNick, manual = false,
  state, ops, brain, buildPrompt, checkDm,
  log = () => {}, home, mem = null, root = process.cwd(),
  mergeMemory = null, onEmpty = null,
}) {
  const maxAttempts = Number(ops?.maxAttempts) || 3;

  // 1) 主人发来的内容并入队列（页面只渲染十来条，老卡片会被挤掉）
  const items = collectIncoming(dm);
  const prev = state.read();
  const merged = state.update((cur) => ({
    ...cur, queue: ops.mergeQueue(cur.queue, items), loginBlockedUntil: '',
  }));
  const queued = merged.queue;
  if (queued.length > (prev.queue ?? []).length) {
    log(`[tick] 队列新增 ${queued.length - (prev.queue ?? []).length} 条（共 ${queued.length}）`);
  }

  // 2) 每日回复上限
  const dailyMax = Number(cfg.watch?.dailyMax) || 0;
  if (!manual && dailyMax > 0 && (merged.watches ?? 0) >= dailyMax) {
    log(`[tick] 今日已回复 ${merged.watches} 条，达到上限 ${dailyMax}，明天继续`);
    return { round: 'daily-max', merged };
  }

  // 3) 挑最早未回复；没有就交给调用方（值班会去主动分享）
  const pending = ops.pendingOf(queued, merged.repliedIds);
  if (!pending.length) {
    if (onEmpty) await onEmpty({ merged, manual });
    return { round: 'empty', merged };
  }
  const next = pending[0];

  // 4) 表情回复前先把对方发的图下载到本地，模型才能看画面
  if (next.kind === 'sticker' && next.image_url && !next.image_path) {
    const dl = spawnSync(process.execPath, [
      path.join(root, 'douyin.mjs'), 'dm-image', '--url', next.image_url,
    ], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
    let dlJson = {};
    try { dlJson = JSON.parse(String(dl.stdout || '').trim()); } catch { /* 整段不行就放弃 */ }
    if (dlJson.ok) next.image_path = dlJson.path;
    else log(`[tick] 表情图下载失败：${dlJson.error ?? dl.error?.message ?? 'unknown'}`
      + `（stderr=${String(dl.stderr || '').slice(-120)}）`);
  }

  // 5) fiber 读不到发送方就无法回读确认 —— 投递前就 bail，省一轮 token
  const meBefore = meTextSet(dm);
  if (meBefore === null) {
    log('[tick] ⚠️ fiber 读不到发送方，无法回读确认 —— 不标记，下轮重试');
    return { round: 'fiber-unreadable', next, merged };
  }

  // 6) 派活
  const memeAllowed = memeAllowedFor({ kind: next.kind, cfg, merged });
  log(`[tick] 队列 ${queued.length} 条，待回复 ${pending.length} 条 → 处理 ${next.id}`
    + `（${next.kind}，第 ${(next.attempts || 0) + 1} 次${memeAllowed ? '，可带表情' : ''}）`
    + (mem ? `（记忆 ${mem.total_remembered} 条）` : ''));

  // 7) 每轮只允许发一条：标记由 douyin.mjs send/share/emoji 读取并拒绝第二条
  beginReplyMarker(home, next);
  const prompt = buildPrompt({ item: next, ownerNick, pendingCount: pending.length, mem, memeAllowed });
  const r = await brain.dispatch({ prompt, item: next });
  if (!r || r.ok !== true) {
    endReplyMarker(home);
    // 投递失败是大脑/宿主的问题，不该把内容记成「这条不行」；不计 attempts
    return { round: 'dispatch-failed', r: r || { ok: false, reason: 'no result' }, next, merged };
  }

  // 8) 等这一轮跑完（值班会话才有；shell 唤醒 dispatch 本身就是同步等完的）
  if (typeof brain.awaitIdle === 'function') {
    await brain.awaitIdle();
  }

  // 9) 回读确认：agent「跑完了」不等于私信发出去了
  const marker = readReplyMarker(home);
  endReplyMarker(home);
  const after = checkDm();
  const j = judgeDelivery({ marker, before: dm, after });
  const { textDelivered, emojiDelivered, cardDelivered } = j;

  if (j.delivered) {
    state.update((cur) => ({
      ...cur,
      repliedIds: ops.capRepliedIds([...(cur.repliedIds ?? []), next.id]),
      watches: (cur.watches ?? 0) + 1,
      memes: (cur.memes ?? 0) + (marker?.image ? 1 : 0),
    }));
    if (after?.messages?.length && typeof mergeMemory === 'function') {
      try { mergeMemory(after); } catch (e) { log(`[tick] 记忆写入失败（不影响回复）: ${e.message}`); }
    }
    const summary = cardDelivered && !textDelivered && !emojiDelivered
      ? `分享卡片 ${marker.video}，回读确认`
      : deliverySummary(j);
    log(`[tick] ${next.id} 已确认送达（${summary}），剩余 ${pending.length - 1} 条`);
    return { round: 'delivered', j, r, next, after, merged };
  }

  // 10) 未确认：记尝试次数，下轮重试（判据摘要能分辨「没发」还是「发了没读到」）
  const attempts = (next.attempts || 0) + 1;
  const reason = marker?.sent ? 'sent-but-not-readback' : 'no-send';
  state.update((cur) => ({ ...cur, queue: ops.bumpAttempt(cur.queue, next.id, reason) }));
  log(`[tick] ⚠️ ${next.id} 未确认到私信（${reason}，第 ${attempts}/${maxAttempts} 次）`
    + `（marker=${marker ? `sent=${marker.sent},text=${String(marker.text || '').length}字${marker.emoji ? ',emoji' : ''}` : 'null(无标记文件)'}`
    + `，expected=${j.expected ? `「${j.expected.slice(0, 18)}」${j.expected.length}字` : '(空)'}`
    + `，fresh ${j.fresh.length} 条${j.fresh.length ? `：${j.fresh.slice(0, 2).map((t) => `「${t.slice(0, 14)}」`).join('')}` : ''}`
    + `，媒体 ${j.mediaBefore ?? '?'}→${j.mediaAfter ?? '?'}）`
    + (attempts >= maxAttempts ? '，已标记失败，不再重试' : '，下轮重试'));
  return { round: 'unconfirmed', j, r, next, after, merged };
}
