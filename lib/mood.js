/**
 * lib/mood.js —— 大肥鱼的心情状态（值班大脑与调度器共用）。
 *
 * 状态放在独立文件 ~/.dsh/whale-mood.json，不并进 douyin-whale-state.json：
 * 那边两边各有一份字段白名单，新字段很容易在某一侧被写丢（lastShareAt 就踩过）。
 *
 * 三条轴都是 0–100：
 *   energy   精力：干活掉、睡觉回
 *   social   想念：长时间没人说话会涨，回完消息就降
 *   boredom  无聊：闲着会涨，刷视频/分享会降
 *
 * 读取只算不写（惰性漂移），事件才落盘；两边 tick 按设计不同时跑，原子替换足够。
 */
import fs from 'node:fs';
import path from 'node:path';

export const MOOD_DEFAULTS = { energy: 72, social: 48, boredom: 35 };

// 每小时自然漂移；睡眠窗口内反过来恢复
const DRIFT_AWAKE = { energy: -1.2, social: 1.5, boredom: 2.0 };
const DRIFT_ASLEEP = { energy: 6.0, social: 0.8, boredom: -1.0 };

// 事件增量：只记真正发生的事，「什么都没发生」交给漂移
const EVENTS = {
  reply: { social: -15, energy: -4, boredom: -12, touch: true },
  reply_unconfirmed: { social: 3, energy: -5 },
  dispatch_failed: { energy: -3 },
  share: { social: -6, boredom: -28, energy: -3 },
  share_failed: { boredom: -8, energy: -2 },
  poke: { social: -18, boredom: -14, energy: 2, touch: true },
};

const clamp100 = (n) => Math.max(0, Math.min(100, n));
const round1 = (n) => Math.round(n * 10) / 10;

function readJson(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function toMin(hhmm) {
  const [h, m] = String(hhmm ?? '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 24 || m < 0 || m > 59) return null;
  return (h === 24 ? 1440 : h * 60) + m;
}

/** 作息窗口：空数组 = 不睡；start > end 视为跨午夜（23:30–07:30）。
 *  与 inWatchWindow 分开实现——那边空数组是「全天」，语义正好相反。 */
export function inQuietHours(windows, now = new Date()) {
  if (!Array.isArray(windows) || !windows.length) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return windows.some((w) => {
    const start = toMin(w?.start);
    const end = toMin(w?.end);
    if (start === null || end === null || start === end) return false;
    return start < end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end;
  });
}

function computeView(raw, { now = new Date(), cfg = {} } = {}) {
  const enabled = cfg.mood?.enabled !== false;
  const updated = Date.parse(raw.updatedAt || '') || now.getTime();
  const hours = Math.max(0, Math.min(24, (now.getTime() - updated) / 3_600_000));
  const sleeping = enabled && inQuietHours(cfg.mood?.sleepWindows, now);
  const rate = sleeping ? DRIFT_ASLEEP : DRIFT_AWAKE;
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const view = {
    enabled,
    sleeping,
    energy: round1(clamp100(num(raw.energy, MOOD_DEFAULTS.energy) + rate.energy * hours)),
    social: round1(clamp100(num(raw.social, MOOD_DEFAULTS.social) + rate.social * hours)),
    boredom: round1(clamp100(num(raw.boredom, MOOD_DEFAULTS.boredom) + rate.boredom * hours)),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    lastInteractionAt: typeof raw.lastInteractionAt === 'string' ? raw.lastInteractionAt : '',
    driftedHours: round1(hours),
  };
  view.label = moodLabel(view);
  return view;
}

/** 读心情视图。只读文件、不落盘，面板/日志可以随便调。 */
export function readMood({ file, now = new Date(), cfg = {} } = {}) {
  return computeView(file ? readJson(file) : {}, { now, cfg });
}

/** 记一个事件并落盘（先算漂移，事件叠加在最新值上）。 */
export function applyMoodEvent({ file, event, now = new Date(), cfg = {} } = {}) {
  if (!file) return computeView({}, { now, cfg });
  const raw = readJson(file);
  const view = computeView(raw, { now, cfg });
  if (!view.enabled) return view;              // 心情关掉时只读不写，开回来还能接上
  const delta = EVENTS[event];
  if (!delta) return view;
  const next = {
    updatedAt: now.toISOString(),
    energy: round1(clamp100(view.energy + (delta.energy || 0))),
    social: round1(clamp100(view.social + (delta.social || 0))),
    boredom: round1(clamp100(view.boredom + (delta.boredom || 0))),
    lastInteractionAt: delta.touch ? now.toISOString() : view.lastInteractionAt,
    sleeping: view.sleeping,
  };
  writeJson(file, next);
  return { ...computeView(next, { now, cfg }), driftedHours: 0 };
}

/** 一轮结束后按结果记事件；没发生实质动作的轮次不记。 */
export function applyRoundMood({ file, round, now = new Date(), cfg = {}, log = () => {} } = {}) {
  const event = {
    delivered: 'reply',
    unconfirmed: 'reply_unconfirmed',
    'dispatch-failed': 'dispatch_failed',
  }[round];
  if (!event) return null;
  try {
    return applyMoodEvent({ file, event, now, cfg });
  } catch (e) {
    log(`[mood] 状态写入失败（不影响本轮）: ${e?.message ?? e}`);
    return null;
  }
}

export function moodLabel(view, { awake = false } = {}) {
  if (!view) return '';
  if (view.sleeping) return awake ? '迷迷糊糊' : '睡着';
  if (view.energy < 25) return '困';
  if (view.social > 75) return '黏人';
  if (view.boredom > 70) return '无聊';
  if (view.energy > 65 && view.social < 45) return '精神';
  return '平静';
}

/** 提示词里的状态块。只描述状态，不要求模型「表演」心情。 */
export function moodHint(view, { awake = false } = {}) {
  if (!view?.enabled) return '';
  const label = moodLabel(view, { awake });
  if (!label) return '';
  return [
    `［现在的状态］${label}｜精力 ${Math.round(view.energy)}／想念 ${Math.round(view.social)}／无聊 ${Math.round(view.boredom)}（0–100）。`,
    '只让语气和话的长短自然体现（困了就话少，黏人可以主动一点），不要报数值，也不要说「我现在的状态」。',
  ].join('\n');
}
