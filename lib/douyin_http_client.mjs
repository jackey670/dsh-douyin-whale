/**
 * Node HTTP client for the local Douyin HTTP API.
 *
 * Design goals:
 * - never read cookies or credentials directly; the Python service owns auth;
 * - give agents one stable JSON boundary for search / frames / download;
 * - start the local HTTP service on demand so callers don't need to know how.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeAweme, normalizeHotItems, normalizeUser } from './normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SCRIPT = path.join(ROOT, 'python', 'douyin_http.py');
const DATA_DIR = process.env.DOUYIN_DATA_DIR
  ? path.resolve(process.env.DOUYIN_DATA_DIR)
  : path.join(ROOT, 'data');

function findPython() {
  if (process.env.DOUYIN_PYTHON) return path.resolve(process.env.DOUYIN_PYTHON);
  const candidates = [
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
    path.join(ROOT, '.venv', 'bin', 'python3'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return 'python';
}

export function baseUrl({ host, port } = {}) {
  if (process.env.DOUYIN_HTTP_BASE) return String(process.env.DOUYIN_HTTP_BASE).replace(/\/+$/, '');
  const usedHost = host ?? process.env.DOUYIN_HTTP_HOST ?? '127.0.0.1';
  const usedPort = port ?? process.env.DOUYIN_HTTP_PORT ?? '7709';
  return `http://${usedHost}:${usedPort}`;
}

async function probeHealth(base) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnServer(base) {
  if (!existsSync(SERVER_SCRIPT)) {
    throw new Error(`douyin HTTP 脚本不存在：${SERVER_SCRIPT}`);
  }
  const py = findPython();
  const child = spawn(py, [SERVER_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      DOUYIN_DATA_DIR: process.env.DOUYIN_DATA_DIR || DATA_DIR,
    },
    stdio: 'ignore',
    detached: false,
    windowsHide: true,
  });
  child.unref();
  return base;
}

/** Make sure the local HTTP API is reachable; start it if allowed. */
export async function ensureServer({
  base = baseUrl(),
  start = true,
  timeoutMs = 12000,
} = {}) {
  if (await probeHealth(base)) return { base, started: false };

  if (!start) {
    throw new Error(`douyin HTTP API 未启动：${base}（可用 --start 自动启动）`);
  }
  spawnServer(base);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (await probeHealth(base)) return { base, started: true };
  }
  throw new Error(`douyin HTTP API 启动超时：${base}`);
}

/** One HTTP call; JSON only, no cookie/credential handling. */
export async function request(path, {
  base = baseUrl(),
  method = 'GET',
  body,
  start = true,
  timeoutMs = 180000,
} = {}) {
  await ensureServer({ base, start });
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`douyin HTTP 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 240)}`);
  }
  if (!res.ok || (parsed && typeof parsed === 'object' && parsed.ok === false)) {
    const message = parsed?.error?.message ?? parsed?.error ?? `HTTP ${res.status}`;
    const error = new Error(`douyin HTTP 调用失败：${message}`);
    error.code = parsed?.error?.code;
    error.details = parsed;
    throw error;
  }
  return parsed;
}

/** Search results → normalized video rows. */
export async function searchVideos(keyword, {
  count = 10,
  sort = '综合',
  start = true,
  base,
} = {}) {
  const payload = await request('/search', {
    base,
    method: 'POST',
    body: { keyword, count, sort },
    start,
  });
  const rows = Array.isArray(payload?.data?.data) ? payload.data.data : [];
  const videos = rows
    .map((row) => normalizeAweme(row?.aweme_info))
    .filter(Boolean);
  return {
    keyword,
    count: videos.length,
    videos,
    has_more: Boolean(payload?.data?.has_more),
    next_offset: payload?.data?.next_offset ?? null,
    logid: payload?.data?.logid ?? null,
  };
}

/** Douyin hot list → normalized rows. */
export async function trendingTopics({ start = true, base } = {}) {
  const payload = await request('/trending', { base, method: 'POST', start });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return { count: rows.length, items: normalizeHotItems(rows) };
}

/** One video detail. */
export async function videoDetail(id, { start = true, base } = {}) {
  const payload = await request('/detail', {
    base,
    method: 'POST',
    body: { id },
    start,
  });
  return payload;
}

/** Download the no-watermark video; returns local path metadata. */
export async function downloadVideo(id, { start = true, base } = {}) {
  return request('/download', {
    base,
    method: 'POST',
    body: { aweme_id: id },
    start,
  });
}

/** Download + ffmpeg frames; returns local frame paths. */
export async function videoFrames(id, { n = 8, start = true, base } = {}) {
  return request('/frames', {
    base,
    method: 'POST',
    body: { aweme_id: id, n },
    start,
  });
}

/** Creator profile. */
export async function userProfile(user, { start = true, base } = {}) {
  const payload = await request('/profile', {
    base,
    method: 'POST',
    body: { user },
    start,
  });
  const rawUser = payload?.data?.user ?? payload?.data?.author ?? payload?.user ?? null;
  return { user: normalizeUser(rawUser), raw: payload };
}

export { DATA_DIR, ROOT, SERVER_SCRIPT };
