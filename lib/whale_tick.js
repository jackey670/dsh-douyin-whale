/**
 * lib/whale_tick.js —— 值班大脑的一轮 tick（插件侧入口）。
 *
 * 主循环本体在 lib/whale_round.js（与 scheduler.mjs 共享）；这里只剩：
 *   · 前置检查（owner/开关/时段/登录冷却）；
 *   · brain 适配器：值班 agent 会话（lib/duty_agent.js）的 send/awaitIdle；
 *   · 队列空时的主动分享轮（maybeProactiveShare）。
 *
 * 安全设计原样保留：
 *   · 回读确认才算已回复 —— agent「跑完了」不等于私信发出去了；
 *   · 一轮一条标记（lib/reply_marker.js）；
 *   · 队列持久化 —— 私信页只渲染十来条，老卡片会被挤掉。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_ATTEMPTS,
  bumpAttempt,
  capRepliedIds,
  mergeQueue,
  pendingOf,
  readConfig,
  readState,
  updateState,
  whalePaths,
} from './whale_state.js';
import { buildWhaleTaskMessage, buildProactiveShareMessage } from './whale_prompt.js';
import { beginReplyMarker, endReplyMarker, readReplyMarker } from './reply_marker.js';
import { judgeDelivery, meCardIds, meMediaCount, meTextSet } from './whale_readback.js';
import { readDm } from './dm_reader.js';
import { inWatchWindow, runWatchRound, shouldProactiveShare } from './whale_round.js';
import { applyMoodEvent, applyRoundMood, readMood } from './mood.js';
import { petNotify, syncPetSleep } from './pet_bridge.js';
import { dmContext, mergeDmMemory } from '../scheduler/memory.mjs';

// 兼容旧引用（测试/外部脚本可能从本模块拿这些纯函数）
export { meTextSet, meMediaCount, meCardIds, judgeDelivery };
export { inWatchWindow };
export { buildProactiveShareMessage };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');

/** 登录失效后的冷却时长：账号没登录时不必每轮都开浏览器 */
export const LOGIN_BACKOFF_MS = 30 * 60_000;

/** 选 Python 解释器：env → 配置 → venv → PATH（对齐 tools/run-py.mjs） */
export function resolvePy({ pythonPath = '', root = PLUGIN_ROOT } = {}) {
  const envPy = String(process.env.DOUYIN_PYTHON || '').trim();
  if (envPy) return envPy;
  if (pythonPath && path.isAbsolute(pythonPath) && existsSync(pythonPath)) return pythonPath;
  for (const c of ['.venv/Scripts/python.exe', '.venv/bin/python']) {
    const p = path.join(root, c);
    if (existsSync(p)) return p;
  }
  return 'python';
}

/** 兼容导出：读一次私信（共享实现见 lib/dm_reader.js） */
export function checkDm(opts) {
  return readDm({ root: PLUGIN_ROOT, ...opts });
}

/** 给值班 agent 的任务消息（人设在它的 systemPrompt 里，这里只派活）。
 * 值班 agent 在宿主里没有 shell/文件工具，一切动作都走插件工具。
 * root 参数保留兼容旧签名（现无用处）。 */
export function buildTaskMessage(opts) {
  return buildWhaleTaskMessage({ ...opts, mode: 'tools', cfg: readConfig() });
}

// ── 每轮只发一条的标记（douyin.mjs send 读它，实现见 lib/reply_marker.js）──
/**
 * @param {object} opts
 *   log            (msg)=>void
 *   dutyAgent      createDutyAgent() 的返回值
 *   root           插件根目录（找 python/douyin_im.py 和 douyin.mjs）
 *   home           调度器状态目录（默认 ~/.dsh；测试传临时目录）
 */
export function createWhaleTick({
  log = () => {}, dutyAgent, root = PLUGIN_ROOT, home, dataDir,
} = {}) {
  const paths = whalePaths(home);
  let checking = false;

  return async function tick({ manual = false } = {}) {
    if (checking) return;
    checking = true;
    try {
      const cfg = readConfig(paths);
      const ownerNick = cfg.owner?.nickname;
      if (!ownerNick) {
        if (manual) log('[tick] config owner.nickname 未配置');
        return;
      }
      // 心情/作息：先让桌宠跟上（到点睡觉/起床），再决定这轮怎么说话
      const mood = readMood({ file: paths.mood, cfg });
      void syncPetSleep({ view: mood, home: paths.home, cfg, log });
      if (cfg.watch?.enabled === false) {
        if (manual) log('[tick] 观看已关闭（watch.enabled=false）');
        return;
      }
      if (!inWatchWindow(cfg.watch?.windows)) {
        if (manual) log('[tick] 当前不在观看时段内');
        return;
      }

      // 登录失效冷却：账号未登录时每轮都起浏览器读私信太浪费，
      // 失败后 30 分钟内不再试；手动 tick（--watch-now）可以跳过冷却。
      const pre = readState(paths);
      const blockedUntil = Date.parse(pre.loginBlockedUntil || '') || 0;
      if (!manual && blockedUntil > Date.now()) {
        log(`[tick] 登录态失效，暂停检查到 ${new Date(blockedUntil).toLocaleString('zh-CN', { hour12: false })}`);
        return;
      }

      const py = resolvePy({ pythonPath: cfg.pythonPath, root });
      const dm = readDm({ ownerNick, py, root, dataDir, log });
      if (!dm) return;
      if (dm.__error) {
        if (dm.__error === 'NEED_LOGIN' || /登录|login/i.test(dm.message || '')) {
          const until = new Date(Date.now() + LOGIN_BACKOFF_MS).toISOString();
          updateState((cur) => ({ ...cur, loginBlockedUntil: until }), paths);
          log(`[tick] 未登录，${Math.round(LOGIN_BACKOFF_MS / 60_000)} 分钟内不再开浏览器（手动 tick 可跳过）`);
        }
        return;
      }

      const mem = dmContext(paths.home, ownerNick);

      const result = await runWatchRound({
        cfg,
        dm,
        ownerNick,
        manual,
        state: {
          read: () => readState(paths),
          update: (mutate) => updateState(mutate, paths),
        },
        ops: { mergeQueue, pendingOf, bumpAttempt, capRepliedIds, maxAttempts: MAX_ATTEMPTS },
        brain: {
          dispatch: async ({ prompt, item }) => {
            const sent = await dutyAgent.send(prompt);
            if (sent.ok) {
              log(`[tick] 已投给值班会话 ${item.id}${sent.runningNow ? '（在跑，排队中）' : ''}`);
            }
            return sent;
          },
          awaitIdle: async () => {
            const idle = await dutyAgent.awaitIdle();
            log(`[tick] 值班会话轮次结束（${Math.round(idle.elapsedMs / 1000)}s${idle.timedOut ? '，超时' : ''}）`);
            return idle;
          },
        },
        buildPrompt: (ctx) => buildTaskMessage({ ...ctx, root }),
        checkDm: () => readDm({ ownerNick, py, root, dataDir, log }),
        log,
        home: paths.home,
        mem,
        root,
        mood,
        mergeMemory: (after) => mergeDmMemory(paths.home, ownerNick, after.messages),
        onEmpty: async ({ merged, manual: isManual }) => {
          // 常态空转也留一行：主人重发同图 sticker 会被 image_id 去重成「已回复」，
          // 没有这行看起来就像值班大脑死了
          log(`[tick] 没有待回复的内容（队列 ${merged.queue.length} 条，已回复 ${(merged.repliedIds ?? []).length} 条）`);
          await maybeProactiveShare({ cfg, paths, ownerNick, manual: isManual, merged });
        },
      });

      applyRoundMood({ file: paths.mood, round: result.round, cfg, log });
      if (result.round === 'delivered') {
        void petNotify({ text: '回完主人一条啦', home: paths.home, cfg, log });
      }
      if (result.round === 'dispatch-failed') {
        // 投递失败是宿主/会话的问题，不该把内容记成「这条不行」；不计 attempts
        log(`[tick] 投递失败：${result.r.reason}（下轮重试 ${result.next.id}）`);
      }
    } catch (e) {
      log(`[tick] 异常: ${e?.message ?? e}`);
    } finally {
      checking = false;
    }
  };

  /** 主动分享轮：队列空闲时按概率刷一条视频给主人（低频、独立每日上限、手动 tick 不触发）。
   * 卡片没有文本，回读按「我发的卡片 item_id === 标记里的 aweme」判定；没发出来不计数，
   * 下轮概率重摇——所以这里不设尝试次数，宁缺毋滥。 */
  async function maybeProactiveShare({ cfg, paths, ownerNick, manual, merged }) {
    const pc = cfg.proactiveShare ?? {};
    if (!ownerNick) return;
    const mood = readMood({ file: paths.mood, cfg });
    const gate = shouldProactiveShare({
      pc, merged, manual, mood,
      lastShareAt: merged.lastShareAt,
      minIntervalMinutes: pc.minIntervalMinutes,
    });
    if (!gate.ok) {
      if (gate.reason === 'daily-max') {
        log(`[tick] 今日已分享 ${merged.shares ?? 0} 条，达到上限 ${Number(pc.maxPerDay) || 3}，明天再刷`);
      }
      return;
    }
    const bumpMood = (event) => {
      try { applyMoodEvent({ file: paths.mood, event, cfg }); } catch (e) {
        log(`[mood] 状态写入失败（不影响分享）: ${e?.message ?? e}`);
      }
    };
    try {
      const mem = dmContext(paths.home, ownerNick);
      beginReplyMarker(paths.home, { id: `share-${Date.now()}`, kind: 'video' });
      const sent = await dutyAgent.send(buildProactiveShareMessage({ ownerNick, mem, cfg, mood }));
      if (!sent.ok) {
        endReplyMarker(paths.home);
        bumpMood('share_failed');
        log(`[tick] 主动分享投递失败：${sent.reason}（下轮重摇）`);
        return;
      }
      log('[tick] 已投主动分享任务（刷热榜/搜索 → 挑一条分享）');
      const idle = await dutyAgent.awaitIdle();
      log(`[tick] 主动分享轮结束（${Math.round(idle.elapsedMs / 1000)}s${idle.timedOut ? '，超时' : ''}）`);
      const marker = readReplyMarker(paths.home);
      endReplyMarker(paths.home);
      if (!marker?.sent) {
        log('[tick] 主动分享：agent 没发（没挑到合适的就宁可不发，正常）');
        return;
      }
      const py = resolvePy({ pythonPath: cfg.pythonPath, root });
      const after = readDm({ ownerNick, py, root, dataDir, log });
      const cardSeen = judgeDelivery({ marker, before: null, after }).cardDelivered;
      if (!cardSeen) {
        bumpMood('share_failed');
        log(`[tick] ⚠️ 主动分享卡片未在回读里确认（aweme ${marker.video}）——不计数`);
        return;
      }
      const cur = updateState((c) => ({ ...c, shares: (c.shares ?? 0) + 1 }), paths);
      bumpMood('share');
      void petNotify({ text: '刷到一条好玩的，发给主人了', home: paths.home, cfg, log });
      log(`[tick] 主动分享已确认（aweme ${marker.video}），今日第 ${cur.shares ?? 1} 条`);
    } catch (e) {
      try { endReplyMarker(paths.home); } catch { /* 已清理也算成功 */ }
      log(`[tick] 主动分享异常: ${e?.message ?? e}`);
    }
  }
}
