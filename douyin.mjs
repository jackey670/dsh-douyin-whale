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

import { markReplySent, readReplyMarker } from './lib/reply_marker.js';
import { listPacks, pickMeme, searchMemes } from './lib/meme.js';

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
       [--image <表情包路径>]                 附带本地图片（路径须在图库白名单里）
  meme pick <情绪|关键词>                     从图库挑一张表情包（返回 path/caption）
  meme list                                   列出可用图库
  dm-image --url <CDN地址> [--out FILE]       下载私信里收到的表情/图片（给模型看）
  share --aweme <ID> --to <昵称> [--send]    把视频以原生分享卡片发给对方
  read-dm --from <昵称> [--limit N]          读私信（提取视频链接）
  help                                      显示本说明

选项：
  --count N        搜索结果条数（1–20）
  --sort s         综合 / 最多点赞 / 最新发布
  --n N            抽帧数量（4–12）
  --seen FILE      已看过的 aweme_id 列表（默认 data/whale/douyin/seen.json）
  --out FILE       把本次 watch 结果写到指定 JSON 文件
  --to NICK        私信目标昵称（需完全一致）
  --text TEXT      私信内容（≤500 字）
  --image PATH     私信附带图片（只允许图库白名单目录内的文件）
  --url URL        dm-image 用：图片 CDN 地址（来自 read-dm 的 image_url）
  --aweme ID       视频 ID（share 用）
  --to-id SEC_UID  对方 sec_uid（share 时昵称重名才需要）
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

      // 调度器模式：一轮只允许发一条。已经发过就直接拒绝，
      // 避免 agent 顺着对话多回几条，把回复顺序和对象都搅乱。
      const marker = reallySend ? readReplyMarker() : null;
      if (marker?.sent) {
        return fail('本轮已经发过一条私信（调度器限制：每条内容只回一次）', {
          item_id: marker.item_id,
        });
      }

      const { spawnSync } = await import('node:child_process');
      const py = findImPython();
      const imScript = process.env.DOUYIN_IM_SCRIPT || path.join(ROOT, 'python', 'douyin_im.py');
      const env = {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        DOUYIN_DATA_DIR: DATA_DIR,
        DOUYIN_HEADLESS: process.env.DOUYIN_HEADLESS ?? '1',
      };
      const args = [imScript, 'send', '--to', to, '--text', text];
      if (options.image) args.push('--image', String(options.image));
      if (reallySend) args.push('--send');

      const result = spawnSync(py, args, { env, timeout: 180_000, encoding: 'utf8', windowsHide: true });
      let payload;
      try { payload = JSON.parse((result.stdout ?? '').trim().split('\n').filter(l => l.startsWith('{')).pop() ?? '{}'); }
      catch { payload = { ok: false, error: (result.stderr ?? '').slice(0, 300) }; }
      ok(payload);
      if (payload.ok && reallySend) markReplySent(undefined, text, { image: Boolean(options.image) });
      if (!payload.ok) process.exitCode = 1;
      return;
    }
    case 'meme': {
      // meme pick <情绪|关键词> / meme list / meme search <词>
      const sub = String(args[0] || 'pick').toLowerCase();
      if (sub === 'list') {
        const packs = listPacks();
        if (!packs.length) return fail('没有可用图库（~/.dsh/meme-packs 下没有 index.db）');
        return ok({ ok: true, packs });
      }
      if (sub === 'search') {
        const q = args.slice(1).join(' ').trim();
        if (!q) return fail('meme search 需要 <关键词>');
        return ok({ ok: true, memes: searchMemes({ query: q, limit: 8 }) });
      }
      const q = args.slice(1).join(' ').trim();
      if (!q) return fail('meme pick 需要 <情绪|关键词>，例如 meme pick 开心');
      const m = pickMeme(q);
      if (!m) return fail(`图库里没找到匹配「${q}」的表情`, { hint: 'meme list 看看有哪些 tag' });
      return ok({
        ok: true,
        path: m.absPath,
        tag: m.tag,
        caption: m.caption,
        pack: m.pack,
        usage: `send --to "<昵称>" --text "<一句话>" --image "${m.absPath}" --send`,
      });
    }
    case 'dm-image': {
      // 下载私信里收到的表情/图片（给模型 Read 用）。out 默认落在 data/media/dm-images/
      const url = String(options.url || '').trim();
      if (!/^https:\/\/([a-z0-9-]+\.)*douyin(pic|static)?\.com\//i.test(url) && !/^https:\/\//i.test(url)) {
        return fail('dm-image 需要 --url <https CDN 地址>');
      }
      const { createHash } = await import('node:crypto');
      const dir = path.join(DATA_DIR, 'media', 'dm-images');
      let out = String(options.out || '').trim();
      if (out) {
        const rp = path.resolve(out);
        if (!rp.startsWith(path.resolve(dir))) return fail(`--out 必须在 ${dir} 里面`);
        out = rp;
      } else {
        const ext = /\.png(\?|$)/i.test(url) ? '.png' : /\.gif(\?|$)/i.test(url) ? '.gif' : '.webp';
        out = path.join(dir, `${createHash('sha1').update(url).digest('hex').slice(0, 16)}${ext}`);
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) return fail(`下载失败 HTTP ${res.status}`, { url });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return fail('下载内容为空', { url });
      fs.writeFileSync(out, buf);
      return ok({ ok: true, path: out, bytes: buf.length });
    }
    case 'share': {
      const aweme = extractId(options.aweme) || '';
      const to = options.to;
      if (!aweme) return fail('share 需要 --aweme <视频ID>');
      if (!to) return fail('share 需要 --to <昵称>');
      const reallySend = options.send === true;

      // 调度器/值班模式：一轮只发一条。视频分享和文字/表情共用同一个标记。
      const marker = reallySend ? readReplyMarker() : null;
      if (marker?.sent) {
        return fail('本轮已经发过一条私信（调度器限制：每条内容只回一次）', {
          item_id: marker.item_id,
        });
      }

      const { spawnSync } = await import('node:child_process');
      const py = findImPython();
      const imScript = process.env.DOUYIN_IM_SCRIPT || path.join(ROOT, 'python', 'douyin_im.py');
      const env = {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        DOUYIN_DATA_DIR: DATA_DIR,
        DOUYIN_HEADLESS: process.env.DOUYIN_HEADLESS ?? '1',
      };
      const args = [imScript, 'share', '--aweme', aweme, '--to', to];
      if (options['to-id']) args.push('--to-id', String(options['to-id']));
      if (reallySend) args.push('--send');

      const result = spawnSync(py, args, { env, timeout: 300_000, encoding: 'utf8', windowsHide: true });
      let payload;
      try { payload = JSON.parse((result.stdout ?? '').trim().split('\n').filter(l => l.startsWith('{')).pop() ?? '{}'); }
      catch { payload = { ok: false, error: (result.stderr ?? '').slice(0, 300) }; }
      ok(payload);
      if (payload.ok && reallySend && payload.data?.sent) {
        markReplySent(undefined, options.text ? String(options.text) : `视频分享 ${aweme}`, { video: aweme });
      }
      if (!payload.ok) process.exitCode = 1;
      return;
    }
    case 'read-dm': {
      const from = options.from;
      if (!from) return fail('read-dm 需要 --from <昵称>');
      const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, options.limit)) : 20;

      const { spawnSync } = await import('node:child_process');
      const py = findImPython();
      const imScript = process.env.DOUYIN_IM_SCRIPT || path.join(ROOT, 'python', 'douyin_im.py');
      const env = {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        DOUYIN_DATA_DIR: DATA_DIR,
        DOUYIN_HEADLESS: process.env.DOUYIN_HEADLESS ?? '1',
      };
      const result = spawnSync(py, [imScript, 'read', '--from', from, '--limit', String(limit)],
        { env, timeout: 180_000, encoding: 'utf8', windowsHide: true });
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
