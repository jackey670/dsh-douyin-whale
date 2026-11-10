/**
 * lib/pet_bridge.js —— 把大肥鱼的动作播报到桌宠（dsh-pet）。
 *
 * 只走独立通道：/broadcast 气泡 + /sleep /wake。
 * 刻意不碰 /work-status —— 那个槽位和 ZCode hook 共用（hook 每次工具调用都写
 * task:null），调度器写进去会被立刻覆盖，看起来像在抽风。
 *
 * 桌宠没开、端口/token 变了、请求超时都只是 no-op：播报失败绝不能影响值班。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROUTE = '/dsh-pet-7340';
const TIMEOUT_MS = 1500;

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

const petStateFile = (home) => path.join(home, 'whale-pet-state.json');

/** 读桌宠运行态（port/token 每次启动都会变，不能缓存）。进程不活着就当离线。 */
export function petRuntime(home) {
  if (!home) return null;
  const rt = readJson(path.join(home, 'dsh-pet', 'standalone-runtime.json'));
  const port = Number(rt.port);
  const token = String(rt.token || '');
  if (!port || !token) return null;
  const pid = Number(rt.pid) || 0;
  if (pid) {
    try {
      process.kill(pid, 0);
    } catch {
      return null;
    }
  }
  return { port, token, pid };
}

async function post({ runtime, pathname, body, fetchImpl, timeoutMs = TIMEOUT_MS }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${runtime.port}${ROUTE}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-pet-token': runtime.token,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 冒一个短气泡。普通播报受 pet.minIntervalMinutes 限流，
 * force=true 用于「摸摸头」这种必须立刻有反馈的交互。
 */
export async function petNotify({
  text, durationMs = 8000, force = false,
  home, cfg = {}, log = () => {}, fetchImpl = globalThis.fetch,
} = {}) {
  if (cfg.pet?.enabled === false) return { ok: false, reason: 'disabled' };
  if (!home || !text) return { ok: false, reason: 'noop' };
  const runtime = petRuntime(home);
  if (!runtime) return { ok: false, reason: 'offline' };

  const file = petStateFile(home);
  const st = readJson(file);
  const minMs = Math.max(1, Number(cfg.pet?.minIntervalMinutes) || 15) * 60_000;
  const last = Date.parse(st.lastNotifyAt || '') || 0;
  if (!force && last && Date.now() - last < minMs) {
    return { ok: false, reason: 'rate-limited' };
  }
  // 先记时间再发：失败了也不要每轮重试刷屏
  writeJson(file, { ...st, lastNotifyAt: new Date().toISOString() });

  try {
    const r = await post({
      runtime, fetchImpl,
      pathname: '/broadcast?pet=main&surface=desktop',
      body: { text: String(text).slice(0, 120), anim: false, duration: durationMs },
    });
    if (!r.ok) log(`[pet] 气泡失败（HTTP ${r.status}）`);
    return r;
  } catch (e) {
    log(`[pet] 气泡异常: ${e?.message ?? e}`);
    return { ok: false, reason: 'error' };
  }
}

/** 睡觉/起床：只在状态真的变化时调用，失败不记状态，下轮再试。 */
export async function petSetSleep({
  sleeping, home, cfg = {}, log = () => {}, fetchImpl = globalThis.fetch,
} = {}) {
  if (cfg.pet?.enabled === false || cfg.pet?.sleepEnabled === false) {
    return { ok: false, reason: 'disabled' };
  }
  if (!home) return { ok: false, reason: 'noop' };
  const runtime = petRuntime(home);
  if (!runtime) return { ok: false, reason: 'offline' };

  const file = petStateFile(home);
  const st = readJson(file);
  const want = !!sleeping;
  if (!!st.sleeping === want) return { ok: true, reason: 'unchanged' };
  try {
    const r = await post({
      runtime, fetchImpl,
      pathname: want ? '/sleep?pet=main' : '/wake?pet=main',
    });
    if (r.ok) writeJson(file, { ...st, sleeping: want });
    else log(`[pet] ${want ? '睡觉' : '起床'}失败（HTTP ${r.status}）`);
    return r;
  } catch (e) {
    log(`[pet] ${want ? '睡觉' : '起床'}异常: ${e?.message ?? e}`);
    return { ok: false, reason: 'error' };
  }
}

/** 每次 tick 开头对齐作息：心情说在睡就让桌宠睡，反之叫醒。 */
export function syncPetSleep({ view, home, cfg = {}, log = () => {}, fetchImpl } = {}) {
  if (!view?.enabled) return Promise.resolve({ ok: false, reason: 'disabled' });
  return petSetSleep({ sleeping: view.sleeping, home, cfg, log, fetchImpl });
}
