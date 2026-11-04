/**
 * lib/whale_tick.js —— 一轮「看私信 → 挑最早未回复 → 投值班 agent → 回读确认」。
 *
 * 这是从 scheduler/scheduler.mjs 的 tick 移植进插件的版本，两处不同：
 *   ① 大脑从 `zcode.cjs -p` 换成值班 agent 会话（lib/duty_agent.js）；
 *   ② 状态读写走 lib/whale_state.js（同一份 ~/.dsh 文件，两种运行模式互斥）。
 *
 * 安全设计原样保留：
 *   · 回读确认才算已回复 —— agent「跑完了」不等于私信发出去了；
 *   · 图文自动跳过（frames 只支持视频）；
 *   · 队列持久化 —— 私信页只渲染十来条，老卡片会被挤掉。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
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
import { memoryBlock, personaLine } from './persona.js';
import { buildWhaleTaskMessage } from './whale_prompt.js';
import { beginReplyMarker, endReplyMarker, readReplyMarker } from './reply_marker.js';
import {
  deliverySummary,
  judgeDelivery,
  meCardIds,
  meMediaCount,
  meTextSet,
} from './whale_readback.js';

// 兼容旧引用（测试/外部脚本可能从本模块拿这些纯函数）
export { meTextSet, meMediaCount, meCardIds, judgeDelivery };

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

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** 观看时段（对齐 scheduler.mjs 的 inWindow；end=24:00 表示当天结束） */
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

/** 读一次私信（直启 Python，不走 HTTP，零 token）。
 *  2026-11-03：read 偶发 exit 0 + stdout 空（Node/Win 管道丢失，~1/8）。
 *  Python 同时写一份 JSON 到 DOUYIN_IM_OUT_FILE；stdout 空就读文件，
 *  再空本轮重试一次（读操作幂等，重试安全）。 */
export function checkDm({ ownerNick, py, root = PLUGIN_ROOT, dataDir, log = () => {}, limit = 40 }) {
  const dyData = dataDir || path.join(root, 'data');
  const imScript = path.join(root, 'python', 'douyin_im.py');
  const outFile = path.join(os.tmpdir(), `dy-im-read-${process.pid}-${Date.now()}.json`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const r = spawnSync(py, [imScript, 'read', '--from', ownerNick, '--limit', String(limit)], {
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          DOUYIN_DATA_DIR: dyData,
          DOUYIN_HEADLESS: '1',
          DOUYIN_IM_OUT_FILE: outFile,
        },
        timeout: 180_000,
        encoding: 'utf8',
        windowsHide: true,
      });
      let text = (r.stdout ?? '').trim();
      if (!text) {
        try { text = readFileSync(outFile, 'utf8').trim(); } catch { text = ''; }
        if (text) log('[dm-check] stdout 为空，已从回退文件读取');
      }
      try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
      if (!text) {
        log(`[dm-check] 输出为空（attempt ${attempt}/2，status=${r.status}，signal=${r.signal}）`);
        continue;
      }
      const raw = text.split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}';
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log(`[dm-check] 输出不是 JSON（attempt ${attempt}/2，status=${r.status}，`
          + `stdout=${(r.stdout ?? '').length}B，stderr=${(r.stderr ?? '').slice(-160)}）`);
        if (attempt === 1) continue;
        return null;
      }
      if (!parsed.ok) {
        const stderrTail = (r.stderr ?? '').trim().slice(-160);
        log(`[dm-check] 读私信失败: ${parsed.error?.message ?? 'unknown'}`
          + `（status=${r.status}，stdout尾部=${(r.stdout ?? '').slice(-160)}`
          + (stderrTail ? `，stderr=${stderrTail}` : '') + '）');
        // 结构化错误给 tick 判断要不要进「登录失效冷却」；null 只表示读不到。
        return {
          __error: String(parsed.error?.code || 'unknown'),
          message: String(parsed.error?.message || 'unknown'),
        };
      }
      return parsed.data;
    } catch (e) {
      log(`[dm-check] 异常: ${e.message}`);
      return null;
    }
  }
  return null;
}

/** 给值班 agent 的任务消息（人设在它的 systemPrompt 里，这里只派活）。
 * 值班 agent 在宿主里没有 shell/文件工具，一切动作都走插件工具：
 * douyin_dm_send（带三道闸）/ douyin_meme_pick / douyin_video。
 * root 参数保留兼容旧签名（现无用处）。 */
export function buildTaskMessage(opts) {
  return buildWhaleTaskMessage({ ...opts, mode: 'tools', cfg: readConfig() });
}

/** 主动分享轮的任务消息：队列空闲时刷一条主人可能感兴趣的视频（原生卡片，无文案） */
export function buildProactiveShareMessage({ ownerNick, mem = null, cfg = {} }) {
  const likes = (cfg.preferences?.like ?? []).join('/') || '有意思的';
  const persona = personaLine({
    name: cfg.persona?.name ?? '大肥鱼',
    ownerTitle: cfg.persona?.ownerTitle ?? '主人',
  });
  return [
    '【值班任务】现在没有要回复的内容，去刷一会抖音：',
    `1) 用 douyin_hot {"count": 20} 看热榜，或 douyin_search {"keyword": "<偏好词>", "limit": 10}；`,
    `   主人偏好：${likes}。挑一条你真觉得主人会感兴趣的视频（别挑主人自己发的）。`,
    `2) douyin_dm_share {"aweme_id": "<id>", "to": "${ownerNick}", "send": true}`,
    persona,
    memoryBlock(mem, ownerNick),
    '⚠️ 一轮只分享一条；没有合适的就直说「没挑到」，宁缺毋滥。',
    '   发完只回一句「已分享」。',
  ].filter(Boolean).join('\n');
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
      const dm = checkDm({ ownerNick, py, root, dataDir, log });
      if (!dm) return;
      if (dm.__error) {
        if (dm.__error === 'NEED_LOGIN' || /登录|login/i.test(dm.message || '')) {
          const until = new Date(Date.now() + LOGIN_BACKOFF_MS).toISOString();
          updateState((cur) => ({ ...cur, loginBlockedUntil: until }), paths);
          log(`[tick] 未登录，${Math.round(LOGIN_BACKOFF_MS / 60_000)} 分钟内不再开浏览器（手动 tick 可跳过）`);
        }
        return;
      }

      const st = pre;
      if (st.loginBlockedUntil) {
        updateState((cur) => ({ ...cur, loginBlockedUntil: '' }), paths);
      }
      // 视频/图文带 item_id；纯文字消息没有 item_id；表情（aweType 501）也没有。
      const all = Array.isArray(dm.messages)
        ? dm.messages.filter((m) => m && typeof m === 'object' && m.from !== 'me')
        : [];
      // 文字消息只取最近 5 条：第一次接入时别把历史聊天一口气全回一遍。
      const textMsgs = all.filter((m) => !m.item_id && m.kind !== 'sticker' && String(m.text || '').trim());
      const keepTexts = new Set(textMsgs.slice(-5));
      const items = all.filter((m) => m.item_id || m.kind === 'sticker' || keepTexts.has(m));

      const merged = updateState((cur) => ({
        ...cur, queue: mergeQueue(cur.queue, items), loginBlockedUntil: '',
      }), paths);
      const queued = merged.queue;
      if (queued.length > (st.queue ?? []).length) {
        log(`[tick] 队列新增 ${queued.length - (st.queue ?? []).length} 条（共 ${queued.length}）`);
      }
      const replied = new Set(merged.repliedIds ?? []);

      const dailyMax = Number(cfg.watch?.dailyMax) || 0;
      if (!manual && dailyMax > 0 && (merged.watches ?? 0) >= dailyMax) {
        log(`[tick] 今日已回复 ${merged.watches} 条，达到上限 ${dailyMax}，明天继续`);
        return;
      }

      const pending = pendingOf(queued, merged.repliedIds);
      if (!pending.length) {
        // 常态空转也留一行：主人重发同图 sticker 会被 image_id 去重成「已回复」，
        // 没有这行看起来就像值班大脑死了
        log(`[tick] 没有待回复的内容（队列 ${queued.length} 条，已回复 ${replied.size} 条）`);
        await maybeProactiveShare({ cfg, paths, ownerNick, manual, merged, log, root });
        return;
      }

      const next = pending[0];
      // 表情包回复前先把对方发的图下载到本地，模型才能 Read 看画面
      if (next.kind === 'sticker' && next.image_url && !next.image_path) {
        const { spawnSync } = await import('node:child_process');
        const dl = spawnSync(process.execPath, [
          path.join(root, 'douyin.mjs'), 'dm-image', '--url', next.image_url,
        ], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
        // douyin.mjs 输出是多行美化 JSON：整体 parse，再退回逐行找
        let j = {};
        try { j = JSON.parse(String(dl.stdout || '').trim()); } catch { /* 整段不行就放弃 */ }
        if (j.ok) next.image_path = j.path;
        else log(`[tick] 表情图下载失败：${j.error ?? dl.error?.message ?? 'unknown'}`);
      }
      const meBefore = meTextSet(dm);
      const mem = (await import('../scheduler/memory.mjs')).dmContext(paths.home, ownerNick);
      const memeCfg = cfg.meme ?? {};
      const memeAllowed = next.kind === 'sticker'
        || (memeCfg.enabled !== false
          && Math.random() < (Number(memeCfg.probability) || 0.3)
          && (merged.memes ?? 0) < (Number(memeCfg.maxPerDay) || 6));
      log(`[tick] 队列 ${queued.length} 条，待回复 ${pending.length} 条 → 处理 ${next.id}（${next.kind}，第 ${(next.attempts || 0) + 1} 次${memeAllowed ? '，可带表情' : ''}）`
        + (mem ? `（记忆 ${mem.total_remembered} 条）` : ''));

      // 每轮只允许发一条：douyin.mjs send 会读这个标记并在发过一条后拒绝
      beginReplyMarker(paths.home, next);
      const sent = await dutyAgent.send(
        buildTaskMessage({ item: next, ownerNick, pendingCount: pending.length, mem, root, memeAllowed }),
      );
      if (!sent.ok) {
        endReplyMarker(paths.home);
        // 投递失败是宿主/会话的问题，不该把内容记成「这条不行」；不计 attempts
        log(`[tick] 投递失败：${sent.reason}（下轮重试 ${next.id}）`);
        return;
      }
      log(`[tick] 已投给值班会话 ${next.id}${sent.runningNow ? '（在跑，排队中）' : ''}`);

      if (meBefore === null) {
        endReplyMarker(paths.home);
        log('[tick] ⚠️ fiber 读不到发送方，无法回读确认 —— 不标记，下轮重试');
        return;
      }
      const idle = await dutyAgent.awaitIdle();
      log(`[tick] 值班会话轮次结束（${Math.round(idle.elapsedMs / 1000)}s${idle.timedOut ? '，超时' : ''}）`);

      // 回读确认：agent「跑完了」不等于私信发出去了
      const marker = readReplyMarker(paths.home);
      endReplyMarker(paths.home);
      const after = checkDm({ ownerNick, py, root, dataDir, log });
      const j = judgeDelivery({ marker, before: dm, after });
      const { delivered, textDelivered, emojiDelivered, cardDelivered, expected, fresh } = j;

      if (delivered) {
        updateState((cur) => ({
          ...cur,
          repliedIds: capRepliedIds([...(cur.repliedIds ?? []), next.id]),
          watches: (cur.watches ?? 0) + 1,
          memes: (cur.memes ?? 0) + (marker?.image ? 1 : 0),
        }), paths);
        try {
          if (after?.messages?.length) {
            (await import('../scheduler/memory.mjs'))
              .mergeDmMemory(paths.home, ownerNick, after.messages);
          }
        } catch (e) { log(`[tick] 记忆写入失败（不影响回复）: ${e.message}`); }
        const summary = cardDelivered && !textDelivered && !emojiDelivered
          ? `分享卡片 ${marker.video}，回读确认`
          : deliverySummary(j);
        log(`[tick] ${next.id} 已确认送达（${summary}），剩余 ${pending.length - 1} 条`);
      } else {
        const attempts = (next.attempts || 0) + 1;
        const reason = marker?.sent ? 'sent-but-not-readback' : 'no-send';
        updateState((cur) => ({ ...cur, queue: bumpAttempt(cur.queue, next.id, reason) }), paths);
        // 回读判据摘要：expected 是标记里的正文，fresh 是本轮新出现的「我发的」文本。
        // 两者对不上时，这行能直接分辨是「没发」还是「发了没读到/对不上」。
        log(`[tick] ⚠️ ${next.id} 未确认到私信（${reason}，第 ${attempts}/${MAX_ATTEMPTS} 次）`
          + `（marker=${marker ? `sent=${marker.sent},text=${String(marker.text || '').length}字${marker.emoji ? ',emoji' : ''}` : 'null(无标记文件)'}`
          + `，expected=${expected ? `「${expected.slice(0, 18)}」${expected.length}字` : '(空)'}`
          + `，fresh ${fresh.length} 条${fresh.length ? `：${fresh.slice(0, 2).map((t) => `「${t.slice(0, 14)}」`).join('')}` : ''}`
          + `，媒体 ${j.mediaBefore ?? '?'}→${j.mediaAfter ?? '?'}）`
          + (attempts >= MAX_ATTEMPTS ? '，已标记失败，不再重试' : '，下轮重试'));
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
    if (pc.enabled === false) return;
    if (manual) return;
    if (!ownerNick) return;
    const probability = Number(pc.probability);
    if (!(probability > 0) || Math.random() >= probability) return;
    const maxPerDay = Number(pc.maxPerDay) || 3;
    if ((merged.shares ?? 0) >= maxPerDay) {
      log(`[tick] 今日已分享 ${merged.shares ?? 0} 条，达到上限 ${maxPerDay}，明天再刷`);
      return;
    }
    try {
      const mem = (await import('../scheduler/memory.mjs')).dmContext(paths.home, ownerNick);
      beginReplyMarker(paths.home, { id: `share-${Date.now()}`, kind: 'video' });
      const sent = await dutyAgent.send(buildProactiveShareMessage({ ownerNick, mem, cfg }));
      if (!sent.ok) {
        endReplyMarker(paths.home);
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
      const after = checkDm({ ownerNick, py, root, dataDir, log });
      const cardSeen = Boolean(marker.video) && after ? meCardIds(after).has(String(marker.video)) : false;
      if (!cardSeen) {
        log(`[tick] ⚠️ 主动分享卡片未在回读里确认（aweme ${marker.video}）——不计数`);
        return;
      }
      const cur = updateState((c) => ({ ...c, shares: (c.shares ?? 0) + 1 }), paths);
      log(`[tick] 主动分享已确认（aweme ${marker.video}），今日第 ${cur.shares ?? 1} 条`);
    } catch (e) {
      try { endReplyMarker(paths.home); } catch { /* 已清理也算成功 */ }
      log(`[tick] 主动分享异常: ${e?.message ?? e}`);
    }
  }
}
