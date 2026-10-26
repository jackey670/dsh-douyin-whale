/**
 * lib/panel_api.js —— 设置页面板用的 HTTP 路由（挂 /api/douyin-whale/*）。
 *
 * 设计原则（对齐 dsh-douyin-scroll 的做法）：
 *   ① 面板**只读**运行时状态，状态唯一来源是 ~/.dsh/ 下的文件（scheduler 维护）；
 *   ② 写操作只允许：改配置、启动/停止调度器。**不提供绕过发送闸的口子**——
 *      面板想发消息也必须走 douyin_im.py 的闸；
 *   ③ 路由处理函数不抛错：出错返回 JSON，别让宿主的连接挂死。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  memoryStats,
  queueView,
  readConfig,
  readGate,
  summary,
  tailLog,
  whalePaths,
} from './whale_state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');

const MAX_LOG_LINES = 400;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const asInt = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
};
const asStr = (v, max = 120) =>
  typeof v === 'string' ? v.slice(0, max) : undefined;

/** 配置写入：只接受已知字段、逐项钳制范围。返回 null 表示没有合法改动。 */
export function sanitizeConfigPatch(body) {
  if (!body || typeof body !== 'object') return null;
  const patch = {};
  const ownerNick = asStr(body.owner?.nickname, 60);
  if (ownerNick !== undefined) patch.owner = { nickname: ownerNick.trim() };
  if (body.persona && typeof body.persona === 'object') {
    const name = asStr(body.persona.name, 30);
    const ownerTitle = asStr(body.persona.ownerTitle, 20);
    if (name !== undefined || ownerTitle !== undefined) {
      patch.persona = {};
      if (name !== undefined) patch.persona.name = name;
      if (ownerTitle !== undefined) patch.persona.ownerTitle = ownerTitle;
    }
  }
  const w = body.watch;
  if (w && typeof w === 'object') {
    patch.watch = {};
    if (typeof w.enabled === 'boolean') patch.watch.enabled = w.enabled;
    if (w.intervalMinutes !== undefined) {
      patch.watch.intervalMinutes = clamp(asInt(w.intervalMinutes, 10), 1, 240);
    }
    if (w.dailyMax !== undefined) patch.watch.dailyMax = clamp(asInt(w.dailyMax, 60), 1, 200);
    if (Array.isArray(w.windows)) {
      const windows = w.windows
        .map((win) => ({
          start: asStr(win?.start, 5) || '00:00',
          end: asStr(win?.end, 5) || '24:00',
        }))
        .slice(0, 6);
      if (windows.length) patch.watch.windows = windows;
    }
  }
  return Object.keys(patch).length ? patch : null;
}

/** 把 patch 深合并进磁盘上的配置（保留未知字段），返回写入后的文件内容 */
export function applyConfigPatch(patch, paths = whalePaths()) {
  const file = paths.config;
  const stored = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  })();
  const deepMerge = (base, extra) => {
    const out = { ...base };
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      out[k] = v && typeof v === 'object' && !Array.isArray(v)
        ? deepMerge(out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? out[k] : {}, v)
        : v;
    }
    return out;
  };
  const next = deepMerge(stored, patch);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/** 启动调度器：借 VBS 的静默启动（窗口隐藏 + 与宿主进程解耦） */
export function startScheduler(root = PLUGIN_ROOT) {
  const vbs = path.join(root, 'start-whale.vbs');
  if (!fs.existsSync(vbs)) {
    return { ok: false, error: `找不到 ${vbs}` };
  }
  const child = spawn('cscript', ['//nologo', vbs], {
    cwd: root,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, note: '已启动（异步），几秒后用 status 确认' };
}

export function stopScheduler(root = PLUGIN_ROOT) {
  const script = path.join(root, 'scheduler', 'scheduler.mjs');
  const r = spawnSync(process.execPath, [script, '--stop'], {
    cwd: root,
    timeout: 30_000,
    windowsHide: true,
    encoding: 'utf8',
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, output: text.slice(-400) };
}

/** 工厂：返回 (req, res, url) => Promise<void>；log 用于面板访问审计 */
export function createWhaleApi({ log = () => {} } = {}) {
  const paths = whalePaths();

  const sendJson = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) {
          resolve(null);
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });

  return async function handle(req, res, url) {
    const route = `${req.method} ${path.posix.normalize(url.pathname)}`;
    try {
      if (route === 'GET /api/douyin-whale/status') {
        return sendJson(res, 200, summary(paths));
      }
      if (route === 'GET /api/douyin-whale/queue') {
        return sendJson(res, 200, { ok: true, queue: queueView(paths) });
      }
      if (route === 'GET /api/douyin-whale/log') {
        const n = clamp(asInt(url.searchParams.get('n'), 60), 5, MAX_LOG_LINES);
        return sendJson(res, 200, { ok: true, lines: tailLog(n, paths) });
      }
      if (route === 'GET /api/douyin-whale/gate') {
        return sendJson(res, 200, { ok: true, gate: readGate(paths) });
      }
      if (route === 'GET /api/douyin-whale/memory') {
        return sendJson(res, 200, { ok: true, memory: memoryStats(paths) });
      }
      if (route === 'GET /api/douyin-whale/config') {
        return sendJson(res, 200, { ok: true, config: readConfig(paths) });
      }
      if (route === 'POST /api/douyin-whale/config') {
        const body = await readBody(req);
        const patch = sanitizeConfigPatch(body);
        if (!patch) return sendJson(res, 400, { ok: false, error: '没有可识别的配置字段' });
        const next = applyConfigPatch(patch, paths);
        log(`面板更新配置：${JSON.stringify(patch)}`);
        return sendJson(res, 200, { ok: true, config: next });
      }
      if (route === 'POST /api/douyin-whale/scheduler/start') {
        const r = startScheduler();
        log(`面板请求启动调度器：${r.ok ? '已发起' : r.error}`);
        return sendJson(res, r.ok ? 200 : 500, r);
      }
      if (route === 'POST /api/douyin-whale/scheduler/stop') {
        const r = stopScheduler();
        log(`面板请求停止调度器：${r.ok ? '已停止' : r.output}`);
        return sendJson(res, 200, r);
      }
      return sendJson(res, 404, { ok: false, error: `unknown ${route}` });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };
}
