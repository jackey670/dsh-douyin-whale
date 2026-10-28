/**
 * lib/whale_state.js —— 调度器状态的**只读**视图。
 *
 * 大肥鱼流水线的运行时状态写在 `~/.dsh/`（scheduler/scheduler.mjs 维护），
 * 设置页面板直接读同一批文件，不要自己另存一份——两份状态一定会漂。
 *
 * 这个模块刻意保持「纯读 + 纯函数」：不发网络请求、不起浏览器、不写文件，
 * 方便在 tests/ 里离线验证。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function whalePaths(home = dshHome()) {
  return {
    home,
    config: path.join(home, 'douyin-whale.config.json'),
    state: path.join(home, 'douyin-whale-state.json'),
    log: path.join(home, 'douyin-whale-scheduler.log'),
    pid: path.join(home, 'douyin-whale-scheduler.pid'),
    memoryDir: path.join(home, 'memory'),
  };
}

export function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const today = () => new Date().toLocaleDateString('sv-SE');

export function defaultConfig() {
  return {
    persona: { name: '大肥鱼', ownerTitle: '主人' },
    owner: { nickname: '' },
    preferences: { like: [], dislike: [] },
    watch: {
      enabled: true,
      intervalMinutes: 10,
      dailyMax: 60,
      windows: [{ start: '00:00', end: '24:00' }],
    },
    share: { enabled: true, dailyMax: 60 },
  };
}

/** 配置：读到的值逐层并进默认值，并保留默认里没有的键（如 pythonPath） */
export function readConfig(paths = whalePaths()) {
  const stored = readJsonSafe(paths.config, {}) || {};
  const base = defaultConfig();
  const merge = (def, cur) => {
    if (Array.isArray(def) || def === null || typeof def !== 'object') {
      return cur === undefined ? def : cur;
    }
    const out = { ...def };
    for (const k of Object.keys(def)) out[k] = merge(def[k], cur?.[k]);
    // 默认里没有、存储里有的兄弟键也保留（否则 pythonPath 这类会被丢掉）
    for (const k of Object.keys(cur ?? {})) {
      if (!(k in out) && cur[k] !== undefined) out[k] = cur[k];
    }
    return out;
  };
  return merge(base, stored);
}

/** 调度器同款状态归一化：跨天只清计数，**保留已回复 id 和队列** */
export function readState(paths = whalePaths()) {
  const raw = readJsonSafe(paths.state, {}) || {};
  const repliedIds = Array.isArray(raw.repliedIds)
    ? raw.repliedIds.filter((x) => typeof x === 'string') : [];
  const queue = normalizeQueue(raw.queue);
  if (raw.date !== today()) {
    // 以前这里把 repliedIds/queue 一起清掉，第二天私信页上的旧卡片会被
    // 当成新内容再回一遍 —— 顺序乱、内容对不上号，很大一部分来自这里。
    return {
      date: today(), watches: 0, repliedIds, queue,
      loginFails: 0, loginBlockedUntil: '',
    };
  }
  return {
    date: raw.date,
    watches: Number(raw.watches) || 0,
    repliedIds,
    queue,
    loginFails: Number(raw.loginFails) || 0,
    // 插件 tick 的登录失效冷却（独立调度器不读这个字段，共存无害）
    loginBlockedUntil: typeof raw.loginBlockedUntil === 'string' ? raw.loginBlockedUntil : '',
  };
}

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

/**
 * 原子写状态：`mutate(可变副本)` 返回新状态后 tmp+rename 落盘。
 * 插件内的 tick 和独立调度器写的是同一份文件，两边不应同时跑
 * （二选一的运行模式），但原子替换保证即使并发也不会写坏 JSON。
 */
export function updateState(mutate, paths = whalePaths()) {
  const next = mutate(readState(paths));
  const tmp = `${paths.state}.tmp`;
  fs.mkdirSync(path.dirname(paths.state), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, paths.state);
  return next;
}

/** 只保留最近 N 个已回复 id（对齐 scheduler.mjs 的 capRepliedIds） */
export const capRepliedIds = (ids, max = 300) =>
  ids.length > max ? ids.slice(-max) : ids;

/** 把本轮看到的内容并进队列（对齐 scheduler/state.mjs） */
export function mergeQueue(queue, items, max = 50) {
  const base = normalizeQueue(queue);
  const seen = new Set(base.map((q) => q.id));
  const at = new Date().toISOString();
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

/** 同一条内容最多尝试几轮；超过就标记 failed */
export const MAX_ATTEMPTS = 3;

/** 一条文字消息在队列里的稳定 id（DOM 没有消息 id，只能对内容做哈希） */
export function textId(from, text) {
  return `text:${createHash('sha1')
    .update(`${from || 'unknown'}|${String(text || '').trim()}`)
    .digest('hex')
    .slice(0, 16)}`;
}

/** 待处理：没回过、且没超过重试上限；按入队顺序（旧→新） */
export function pendingOf(queue, repliedIds, maxAttempts = MAX_ATTEMPTS) {
  const replied = new Set(repliedIds || []);
  return normalizeQueue(queue)
    .filter((q) => !replied.has(q.id) && q.attempts < maxAttempts)
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

export function readGate(paths = whalePaths()) {
  const raw = readJsonSafe(path.join(paths.home, 'im-send-gate.json'), {}) || {};
  const now = Date.now() / 1000;
  const blockedUntil = Number(raw.blocked_until) || 0;
  const lastSendAt = Number(raw.last_send_at) || 0;
  return {
    cooldown_remaining_s: blockedUntil > now ? Math.ceil(blockedUntil - now) : 0,
    blocked_reason: raw.blocked_reason || '',
    last_send_ago_s: lastSendAt ? Math.max(0, Math.floor(now - lastSendAt)) : null,
    min_interval_s: Number(process.env.DOUYIN_SEND_MIN_INTERVAL) || 30,
  };
}

export function daemonAlive(paths = whalePaths()) {
  const pidDoc = readJsonSafe(paths.pid, null);
  const pid = typeof pidDoc === 'number' ? pidDoc : Number(pidDoc?.pid) || 0;
  if (!pid) return { running: false, pid: 0, startedAt: '' };
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  return { running: alive, pid, startedAt: pidDoc?.startedAt || '' };
}

export function tailLog(n = 50, paths = whalePaths()) {
  try {
    const text = fs.readFileSync(paths.log, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    return lines.slice(-Math.max(1, Math.min(400, n)));
  } catch {
    return [];
  }
}

/** 队列视图：把 queue 和 repliedIds 合成「每条内容 + 当前状态」 */
export function queueView(paths = whalePaths()) {
  const st = readState(paths);
  const replied = new Set(st.repliedIds);
  const items = st.queue.map((q) => {
    const status = replied.has(q.id)
      ? 'replied'
      : q.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    return {
      item_id: q.item_id,
      id: q.id,
      title: q.title || q.text || '',
      kind: q.kind || 'video',
      seen_at: q.seen_at || '',
      attempts: q.attempts || 0,
      last_error: q.last_error || '',
      status,
    };
  });
  return {
    date: st.date,
    watches: st.watches,
    loginFails: st.loginFails,
    total: items.length,
    pending: items.filter((i) => i.status === 'pending').length,
    failed: items.filter((i) => i.status === 'failed').length,
    items,
  };
}

export function memoryStats(paths = whalePaths()) {
  const out = { dir: paths.memoryDir, files: 0, bytes: 0 };
  try {
    for (const f of fs.readdirSync(paths.memoryDir)) {
      if (!/\.json$/.test(f)) continue;
      out.files += 1;
      try {
        out.bytes += fs.statSync(path.join(paths.memoryDir, f)).size;
      } catch {
        /* 读不到就跳过 */
      }
    }
  } catch {
    /* 目录不存在 = 还没有记忆 */
  }
  return out;
}

/** 面板首屏要的全部内容，一次拿齐 */
export function summary(paths = whalePaths()) {
  const cfg = readConfig(paths);
  const st = readState(paths);
  return {
    ok: true,
    daemon: daemonAlive(paths),
    watch: cfg.watch,
    owner: cfg.owner?.nickname || '',
    persona: cfg.persona?.name || '',
    today: { watches: st.watches, loginFails: st.loginFails, date: st.date },
    gate: readGate(paths),
    queue: queueView(paths),
    memory: memoryStats(paths),
  };
}
