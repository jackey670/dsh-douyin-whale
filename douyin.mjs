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
 *
 * 输出
 * ----
 *   始终是一段 JSON；失败时 `{ ok: false, error }` 并返回非零退出码。
 */

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
  help                                      显示本说明

选项：
  --count N        搜索结果条数（1–20）
  --sort s         综合 / 最多点赞 / 最新发布
  --n N            抽帧数量（4–12）
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
    else if (arg.startsWith('--')) {
      // unknown flag: keep going; commands that need it should fail explicitly.
      options[arg] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
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
