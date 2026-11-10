/**
 * scheduler/prompt.mjs —— 独立调度器的任务提示词（纯函数，可离线测试）。
 *
 * 具体文案在 `lib/whale_prompt.js`（mode='shell'）：唤醒的 agent 有 Bash/Read，
 * 用 `node douyin.mjs ...` 执行、Read 看帧图、写两本日记。
 * 值班大脑走同一构造器的 mode='tools'，两边不会再各写一份。
 */
import { buildWhaleTaskMessage, buildProactiveShareMessage } from '../lib/whale_prompt.js';

export function buildTaskPrompt({
  item, ownerNick, pendingCount, mem = null, root, home, persona = {}, memeAllowed = false, mood = null,
}) {
  return buildWhaleTaskMessage({
    mode: 'shell',
    item,
    ownerNick,
    pendingCount,
    mem,
    root,
    home,
    memeAllowed,
    mood,
    cfg: { persona },
  });
}

/** 主动分享轮（shell 版）：trending/search → share 原生卡片，不带文案、不写日记 */
export function buildSharePrompt({ ownerNick, mem = null, cfg = {}, root, mood = null }) {
  return buildProactiveShareMessage({ mode: 'shell', ownerNick, mem, cfg, root, mood });
}
