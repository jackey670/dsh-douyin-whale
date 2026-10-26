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

/** 配置：读到的值逐层并进默认值，避免面板拿到半截对象 */
export function readConfig(paths = whalePaths()) {
  const stored = readJsonSafe(paths.config, {}) || {};
  const base = defaultConfig();
  const merge = (def, cur) => {
    if (Array.isArray(def) || def === null || typeof def !== 'object') {
      return cur === undefined ? def : cur;
    }
    const out = { ...def };
    for (const k of Object.keys(def)) out[k] = merge(def[k], cur?.[k]);
    return out;
  };
  return merge(base, stored);
}

/** 调度器同款状态归一化：跨天清零、字段补齐 */
export function readState(paths = whalePaths()) {
  const raw = readJsonSafe(paths.state, {}) || {};
  if (raw.date !== today()) {
    return { date: today(), watches: 0, repliedIds: [], queue: [], loginFails: 0 };
  }
  return {
    date: raw.date,
    watches: Number(raw.watches) || 0,
    repliedIds: Array.isArray(raw.repliedIds) ? raw.repliedIds : [],
    queue: Array.isArray(raw.queue) ? raw.queue : [],
    loginFails: Number(raw.loginFails) || 0,
  };
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
  const items = st.queue.map((q) => ({
    item_id: q.item_id || '',
    title: q.title || '',
    kind: q.kind || 'video',
    seen_at: q.seen_at || '',
    status: replied.has(q.item_id) ? 'replied' : 'pending',
  }));
  return {
    date: st.date,
    watches: st.watches,
    loginFails: st.loginFails,
    total: items.length,
    pending: items.filter((i) => i.status === 'pending' && i.kind === 'video').length,
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
