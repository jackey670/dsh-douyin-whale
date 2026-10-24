#!/usr/bin/env node
/**
 * douyin.mjs — Node CLI 适配层（给大肥鱼/ZCode 用）。
 *
 * 为什么有它
 * ----------
 * Python 的 HTTP API 已经解决了登录、签名、下载和抽帧；这里只负责把那些
 * 能力变成一条稳定、可被 agent 调用的 JSON 命令。默认会自动拉起本地 HTTP
 * 服务；也可以用 `--no-start` 只调用已运行的服务。
 *
 * 用法
 * ----
 *   node douyin.mjs help
 *   node douyin.mjs health
 *   node douyin.mjs start
 *   node douyin.mjs status
 *   node douyin.mjs trending
 *   node douyin.mjs search "猫" --count 5
 *   node douyin.mjs detail <aweme_id|分享链接>
 *   node douyin.mjs download <aweme_id|分享链接>
 *   node douyin.mjs frames <aweme_id|分享链接> --n 8
 *   node douyin.mjs profile <sec_uid|主页链接>
 *   node douyin.mjs watch <关键词> [--count N] [--n N] [--seen FILE] [--out FILE]
 *
 * 输出
 * ----
 *   始终是一段 JSON；失败时 `{ ok: false, error }` 并返回非零退出码。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  baseUrl,
  downloadVideo,
  ensureServer,
  request,
  searchVideos,
  trendingTopics,
  userProfile,
  videoDetail,
  videoFrames,
  DATA_DIR,
  ROOT,
} from './lib/douyin_http_client.mjs';

const HELP = `douyin.mjs — 大肥鱼抖音适配层

命令：
  health                                    检查本地 HTTP API 是否可用
  start                                     确保本地 HTTP API 已启动
  status                                    登录状态
  trending                                  抖音热榜
  search <关键词> [--count N] [--sort s]     搜索视频
  detail <id|链接>                           视频详情
  download <id|链接>                         下载无水印视频
  frames <id|链接> [--n N]                   下载并抽帧
  profile <sec_uid|主页链接>                  用户主页
  watch <关键词> [--count N] [--n N]         选一条没看过的视频并抽帧
  send --to <昵称> --text <文字> [--send]     私信（默认 dry-run）
  help                                      显示本说明

选项：
  --count N        搜索结果条数（1–20）
  --sort s         综合 / 最多点赞 / 最新发布
  --n N            抽帧数量（4–12）
  --seen FILE      已看过的 aweme_id 列表（默认 data/whale/douyin/seen.json）
  --out FILE       把本次 watch 结果写到指定 JSON 文件
  --to NICK        私信目标昵称（需完全一致）
  --text TEXT      私信内容（≤500 字）
  --send           真发（需要 DOUYIN_IM_ALLOW_SEND=1 环境变量）
  --no-start       不自动启动本地 HTTP API
  --base-url URL   指定 HTTP API 地址
`;

function fail(message, details) {
  console.log(JSON.stringify({ ok: false, error: message, details: details ?? null }, null, 2));
  process.exitCode = 1;
}

function ok(value) {
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-start') options.noStart = true;
    else if (arg === '--base-url') options.baseUrl = argv[++i] ?? '';
    else if (arg === '--count') options.count = Number(argv[++i] ?? '');
    else if (arg === '--sort') options.sort = argv[++i] ?? '';
    else if (arg === '--n') options.n = Number(argv[++i] ?? '');
    else if (arg === '--send') options.send = true;
    else if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      options[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else positional.push(arg);
  }
  return { options, positional };
}

function extractId(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (/^\d{15,25}$/.test(text)) return text;
  const match = text.match(/\/(?:video|note)\/(\d{15,25})/);
  if (match) return match[1];
  const bare = text.match(/(\d{15,25})/);
  return bare ? bare[1] : null;
}

function readSeenIds(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeSeenIds(file, ids) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ids, null, 2) + '\n', 'utf8');
}

function findImPython() {
  if (process.env.DOUYIN_PYTHON) return process.env.DOUYIN_PYTHON;
  const candidates = [
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
    'python',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'python';
}

async function run() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? 'help';
  const args = positional.slice(1);
  const start = options.noStart !== true;
  const base = options.baseUrl || baseUrl();

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'health': {
      const health = await request('/health', { base, start, timeoutMs: 60000 });
      ok({ ok: true, base, health });
      return;
    }
    case 'start': {
      const result = await ensureServer({ base, start: true });
      ok({ ok: true, base, started: result.started });
      return;
    }
    case 'status': {
      const payload = await request('/status', { base, start, timeoutMs: 60000 });
      ok(payload);
      return;
    }
    case 'trending': {
      const result = await trendingTopics({ base, start });
      ok({ ok: true, ...result });
      return;
    }
    case 'search': {
      const keyword = args[0];
      if (!keyword) return fail('search 需要一个关键词');
      const count = Number.isFinite(options.count) ? Math.max(1, Math.min(20, options.count)) : 10;
      const sort = ['综合', '最多点赞', '最新发布'].includes(options.sort) ? options.sort : '综合';
      const result = await searchVideos(keyword, { count, sort, base, start });
      ok({ ok: true, ...result });
      return;
    }
    case 'detail': {
      const id = extractId(args[0]);
      if (!id) return fail('detail 需要一个 aweme_id 或分享链接');
      const payload = await videoDetail(id, { base, start });
      ok({ ok: true, id, payload });
      return;
    }
    case 'download': {
      const id = extractId(args[0]);
      if (!id) return fail('download 需要一个 aweme_id 或分享链接');
      const payload = await downloadVideo(id, { base, start });
      ok({ ok: true, id, ...payload });
      return;
    }
    case 'frames': {
      const id = extractId(args[0]);
      if (!id) return fail('frames 需要一个 aweme_id 或分享链接');
      const n = Number.isFinite(options.n) ? Math.max(4, Math.min(12, options.n)) : 8;
      const payload = await videoFrames(id, { n, base, start });
      ok({ ok: true, id, ...payload });
      return;
    }
    case 'profile': {
      const user = args[0];
      if (!user) return fail('profile 需要一个 sec_uid 或主页链接');
      const result = await userProfile(user, { base, start });
      ok({ ok: true, ...result });
      return;
    }
    case 'watch': {
      const keyword = args[0];
      if (!keyword) return fail('watch 需要一个关键词');
      const count = Number.isFinite(options.count) ? Math.max(1, Math.min(20, options.count)) : 5;
      const n = Number.isFinite(options.n) ? Math.max(4, Math.min(12, options.n)) : 6;
      const seenPath = options.seen
        ? path.resolve(String(options.seen))
        : path.join(DATA_DIR, 'whale', 'douyin', 'seen.json');

      const result = await searchVideos(keyword, { count, base, start });
      const seen = readSeenIds(seenPath);
      const video = result.videos.find((v) => v.aweme_id && !seen.includes(v.aweme_id))
        ?? result.videos[0];
      if (!video?.aweme_id) return fail('watch 没有拿到可用视频');

      const frames = await videoFrames(video.aweme_id, { n, base, start });
      const seenIds = Array.from(new Set([...seen, video.aweme_id])).slice(-200);
      writeSeenIds(seenPath, seenIds);

      const watchResult = {
        ok: true,
        keyword,
        video,
        frames,
        seenPath,
        seenCount: seenIds.length,
      };
      if (options.out) {
        const outPath = path.resolve(String(options.out));
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(watchResult, null, 2) + '\n', 'utf8');
        watchResult.outPath = outPath;
      }
      ok(watchResult);
      return;
    }
    case 'send': {
      const to = options.to;
      const text = options.text;
      if (!to) return fail('send 需要 --to <昵称>');
      if (!text) return fail('send 需要 --text <文字>');
      const reallySend = options.send === true;

      const { spawnSync } = await import('node:child_process');
      const py = findImPython();
      const imScript = path.join(ROOT, 'python', 'douyin_im.py');
      const env = {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        DOUYIN_DATA_DIR: DATA_DIR,
        DOUYIN_HEADLESS: process.env.DOUYIN_HEADLESS ?? '1',
      };
      const args = [imScript, 'send', '--to', to, '--text', text];
      if (reallySend) args.push('--send');

      const result = spawnSync(py, args, { env, timeout: 180_000, encoding: 'utf8' });
      let payload;
      try { payload = JSON.parse((result.stdout ?? '').trim().split('\n').filter(l => l.startsWith('{')).pop() ?? '{}'); }
      catch { payload = { ok: false, error: (result.stderr ?? '').slice(0, 300) }; }
      ok(payload);
      if (!payload.ok) process.exitCode = 1;
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
      console.error(`未知命令：${command}`);
  }
}

try {
  await run();
} catch (error) {
  fail(String(error?.message ?? error), error?.details ?? null);
}
