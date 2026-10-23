/**
 * Model-facing Douyin tools. Each tool is a thin policy shell: argument
 * validation, one backend call, normalization, partial-success reporting, and
 * structured logging. Credentials never cross this boundary.
 */
import { DouyinError, jitterBetween, sleep } from './backend.js';
import {
  extractAwemeId, extractSecUid, jsonSafe, normalizeAweme, normalizeComments,
  normalizeHotItems, normalizeSearchPayload, normalizeUser, videoUrl,
} from './normalize.js';

/**
 * Minimal local equivalent of `defineTool` from @deepseek-ai/dsh-tools.
 *
 * A Host-only bundle has no dependencies, so this plugin cannot import the
 * harness package at runtime. This shim covers the subset the tools use:
 * the author-facing `required: true` property flag is lifted to the object
 * `required` array, and the output schema stays annotation-only (any JSON),
 * which is inside the registry's supported JSON Schema subset.
 */
function defineTool(definition) {
  const spec = definition.parameters ?? {};
  const properties = {};
  const required = [];
  for (const [key, node] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = node;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  return {
    ...definition,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    output: {
      ...definition.output,
      schema: {},
    },
  };
}

const text = (value) => [{ type: 'text', text: String(value) }];

function intArg(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function backendNote(value) {
  return {
    backend: 'dy-cli (httpx + X-Bogus reverse API)',
    fetched_at: new Date().toISOString(),
    ...value,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function encodeCursor(offset, logid) {
  return Buffer.from(JSON.stringify({ o: offset, l: logid }), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (typeof value !== 'string' || value.length === 0) return { offset: 0, logid: '' };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const offset = Number(parsed?.o);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('bad offset');
    return { offset, logid: typeof parsed?.l === 'string' ? parsed.l : '' };
  } catch {
    throw new DouyinError('invalid_args', 'cursor 无效：请只回传上一次结果里的 next_cursor。');
  }
}

function summarizeSearch(value) {
  const lines = [`搜索「${value.keyword}」：${value.items.length} 条结果`
    + (value.partial ? '（部分成功）' : '')];
  for (const item of value.items) {
    const likes = item.stats?.likes ?? '?';
    lines.push(`- ${item.title ?? '(无标题)'} | ${item.author?.nickname ?? '?'} | 赞 ${likes} | ${item.aweme_id}`);
  }
  if (value.failures?.length) {
    lines.push(`失败页：${value.failures.map((f) => `p${f.page}:${f.code}`).join(', ')}`);
  }
  if (value.count === 0 && value.note) lines.push(value.note);
  if (value.next_cursor) lines.push(`next_cursor: ${value.next_cursor}`);
  return lines.join('\n');
}

function summarizeHot(value) {
  return [`抖音热榜：${value.items.length} 条`, ...value.items.map((item) => `${item.rank}. ${item.title ?? '?'} (${item.hot_value ?? '?'})`)].join('\n');
}

function summarizeVideo(value) {
  const stats = value.video?.stats ?? {};
  return [
    `视频 ${value.video?.aweme_id ?? '?'}：${value.video?.title ?? '(无文案)'}`,
    `作者：${value.video?.author?.nickname ?? '?'} | 赞 ${stats.likes ?? '?'} | 评 ${stats.comments ?? '?'} | 藏 ${stats.collects ?? '?'}`,
    `评论：${value.comments ? `${value.comments.length} 条` : '未获取'}${value.partial ? '（部分成功）' : ''}`,
  ].join('\n');
}

function summarizeUser(value) {
  const user = value.user ?? {};
  return [`用户：${user.nickname ?? '?'} (@${user.unique_id ?? '?'})`,
    `粉丝 ${user.follower_count ?? '?'} | 关注 ${user.following_count ?? '?'} | 获赞 ${user.total_favorited ?? '?'}`,
    `近期作品：${value.posts?.length ?? 0} 条`].join('\n');
}

function summarizeLogin(value) {
  if (value.phase === 'logged_in') {
    return `登录成功（${value.verified_via ?? 'cookie'}）${value.nickname ? `，账号：${value.nickname}` : ''}。`;
  }
  const map = {
    qrcode: '等待扫码：请打开专用 Edge 窗口，用抖音 App 扫描二维码。',
    sms_verification: '已切换到验证码登录页：请先输入手机号并获取验证码。',
    sms_code_input: '等待短信验证码：请调用 douyin_login_submit 传入 codes。',
    challenge_required: '出现安全验证：请在那个 Edge 窗口里手动完成，然后继续轮询 status。',
    starting: '正在打开专用 Edge 窗口…',
    expired: '登录等待已超时，请重新调用 douyin_login_start。',
    failed: '登录进程失败，详见 error。',
    stopped: '登录进程已结束，请重新调用 douyin_login_start。',
    idle: '当前没有登录会话。',
  };
  return `${map[value.phase] ?? `phase=${value.phase}`}${value.screenshot ? `\n二维码截图：${value.screenshot}` : ''}`;
}

/**
 * Build the complete tool set for one backend instance.
 * @param {import('./backend.js').Backend} backend
 */
export function createTools(backend) {
  const cfg = backend.config;

  const run = (name, fn) => async (args, exec) => {
    const startedAt = Date.now();
    try {
      const value = await fn(args ?? {}, exec);
      backend.log({ tool: name, ok: true, durationMs: Date.now() - startedAt });
      return jsonSafe(value);
    } catch (error) {
      const code = error instanceof DouyinError ? error.code : 'backend_unavailable';
      const message = error instanceof DouyinError
        ? error.message
        : String(error?.message ?? error);
      backend.lastError = backend.lastError ?? { code, message, at: nowIso(), tool: name };
      backend.log({ tool: name, ok: false, code, message, durationMs: Date.now() - startedAt });
      throw new Error(`[${code}] ${message}`);
    }
  };

  return [
    defineTool({
      name: 'douyin_hot',
      description: 'Read the current Douyin hot-search list (抖音热榜). Read-only; uses dy-cli reverse API. Count is capped in configuration.',
      parameters: {
        count: {
          type: 'integer',
          description: `Number of entries, 1-${cfg.maxResults} (default 10).`,
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(summarizeHot(value)),
      },
      timeoutMs: 90_000,
      isConcurrencySafe: () => false,
      execute: run('douyin_hot', async (args, exec) => {
        const count = intArg(args.count, 1, cfg.maxResults, 10);
        const result = await backend.runDy(
          ['trending', '--count', String(count), '--json-output'],
          { tool: 'douyin_hot', timeoutMs: 75_000, signal: exec.signal, units: 1 },
        );
        const items = normalizeHotItems(result.data).slice(0, count);
        return backendNote({
          items,
          count: items.length,
          requested: count,
          partial: false,
          failures: [],
        });
      }),
    }),

    defineTool({
      name: 'douyin_search',
      description: 'Search Douyin videos by keyword. Read-only. Returns at most `limit` results and pages through the backend\'s search_id chain (`next_cursor`), with a randomized 3-8 s gap between pages and at most maxSearchPages pages per call. A verify_check from Douyin is surfaced as challenge_required, never bypassed.',
      parameters: {
        keyword: { type: 'string', required: true, description: 'Search keyword.' },
        limit: { type: 'integer', description: `Results per page, 1-${cfg.maxResults} (default 10).` },
        pages: { type: 'integer', description: `Pages to fetch, 1-${cfg.maxSearchPages} (default 1).` },
        cursor: { type: 'string', description: 'Opaque next_cursor returned by a previous call. Omit for the first page.' },
        sort: {
          type: 'string',
          enum: ['综合', '最多点赞', '最新发布', 'general', 'most_like', 'latest'],
          description: 'Sort order (default 综合 / general).',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(summarizeSearch(value)),
      },
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      execute: run('douyin_search', async (args, exec) => {
        const keyword = String(args.keyword ?? '').trim();
        if (!keyword) throw new DouyinError('invalid_args', 'keyword 不能为空。');
        const limit = intArg(args.limit, 1, cfg.maxResults, 10);
        const pages = intArg(args.pages, 1, cfg.maxSearchPages, 1);
        const sort = String(args.sort ?? '综合');
        let cursor = decodeCursor(args.cursor);
        const items = [];
        const failures = [];
        const pageTrace = [];
        let nextCursor = null;

        for (let page = 0; page < pages; page += 1) {
          if (page > 0) {
            await sleep(jitterBetween(cfg.pageDelayMinMs, cfg.pageDelayMaxMs));
            exec.signal?.throwIfAborted?.();
          }
          try {
            const command = [
              'search', keyword, '--count', String(limit),
              '--offset', String(cursor.offset), '--sort', sort,
            ];
            if (cursor.logid) command.push('--logid', cursor.logid);
            const result = await backend.runDyQuery(command, {
              tool: 'douyin_search', timeoutMs: 90_000, signal: exec.signal, units: 1,
            });
            const normalized = normalizeSearchPayload(result.data);
            items.push(...normalized.items);
            pageTrace.push({
              page: page + 1,
              offset: cursor.offset,
              raw_count: normalized.raw_count,
              items: normalized.items.length,
              has_more: normalized.has_more,
              chained_with_logid: Boolean(cursor.logid),
            });
            const nextOffset = normalized.next_offset ?? (cursor.offset + limit);
            if (normalized.has_more && normalized.logid) {
              cursor = { offset: nextOffset, logid: normalized.logid };
              nextCursor = encodeCursor(cursor.offset, cursor.logid);
            } else {
              cursor = { offset: nextOffset, logid: '' };
              nextCursor = null;
              break;
            }
            if (normalized.items.length === 0) break;
          } catch (error) {
            if (page === 0) throw error;
            failures.push({
              page: page + 1,
              code: error instanceof DouyinError ? error.code : 'backend_unavailable',
              message: error instanceof DouyinError ? error.message : String(error),
            });
            nextCursor = null;
            break;
          }
        }

        const capped = items.slice(0, limit * pages);
        return backendNote({
          keyword,
          sort,
          items: capped,
          count: capped.length,
          requested: limit * pages,
          partial: failures.length > 0,
          failures,
          coverage: {
            pages_requested: pages,
            pages_completed: pageTrace.length,
            offsets: pageTrace,
          },
          next_cursor: nextCursor,
          note: nextCursor
            ? 'More results may exist; pass next_cursor to continue.'
            : 'Backend reported no further results for this keyword.',
        });
      }),
    }),

    defineTool({
      name: 'douyin_video',
      description: 'Read one Douyin video: caption, author, interaction statistics, and optionally the first N comments. Accepts an aweme_id or a douyin.com / v.douyin.com URL. Comments are read in the dedicated Edge profile (not headless) and are reported as a partial failure if unavailable.',
      parameters: {
        aweme_id: { type: 'string', description: 'Numeric aweme id. Omit when url is given.' },
        url: { type: 'string', description: 'Video, note, share, or short URL.' },
        comment_limit: { type: 'integer', description: 'Comments to read, 0-20 (default 0).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(summarizeVideo(value)),
      },
      timeoutMs: 240_000,
      isConcurrencySafe: () => false,
      execute: run('douyin_video', async (args, exec) => {
        let id = extractAwemeId(args.aweme_id);
        if (!id && args.url) {
          const raw = String(args.url).trim();
          id = extractAwemeId(raw);
          if (!id && /v\.douyin\.com/i.test(raw)) {
            try {
              const response = await fetch(raw, { redirect: 'follow', signal: exec.signal });
              id = extractAwemeId(response.url);
            } catch (error) {
              throw new DouyinError('backend_unavailable', `短链接解析失败：${error.message}`);
            }
          }
        }
        if (!id) throw new DouyinError('invalid_args', '需要合法的 aweme_id 或抖音视频链接。');
        const commentLimit = intArg(args.comment_limit, 0, 20, 0);
        let rawVideo = null;
        let rawComments = null;
        let source = 'dy-cli (httpx + X-Bogus reverse API)';
        let fallbackFrom = null;

        if (!backend.detailApiBroken) {
          try {
            const detail = await backend.runDy(
              ['detail', id, '--json-output'],
              { tool: 'douyin_video', timeoutMs: 75_000, signal: exec.signal, units: 1 },
            );
            rawVideo = detail.data;
          } catch (error) {
            const code = error instanceof DouyinError ? error.code : 'backend_unavailable';
            if (!['not_found', 'parse_failed', 'backend_unavailable'].includes(code)) throw error;
            // The reverse detail endpoint is unreliable for this account;
            // remember it and use the signed XHR the page itself makes.
            backend.detailApiBroken = true;
            fallbackFrom = code;
          }
        }

        if (!rawVideo) {
          const captured = await backend.runBrowser(
            'video',
            ['--aweme-id', id, '--comment-count', String(commentLimit)],
            { tool: 'douyin_video', timeoutMs: 150_000, signal: exec.signal },
          );
          rawVideo = captured.video;
          rawComments = captured.comments ?? null;
          source = 'browser_xhr (Edge, signed by the page)';
        }

        const video = normalizeAweme(rawVideo);
        if (!video) throw new DouyinError('parse_failed', `视频 ${id} 的详情为空或无法解析。`);

        let comments = rawComments ? normalizeComments(rawComments).slice(0, commentLimit) : null;
        const failures = [];
        if (commentLimit > 0 && comments === null) {
          try {
            const scraped = await backend.runBrowser(
              'comments',
              ['--aweme-id', id, '--count', String(commentLimit)],
              { tool: 'douyin_video', timeoutMs: 150_000, signal: exec.signal },
            );
            comments = normalizeComments(scraped.comments).slice(0, commentLimit);
          } catch (error) {
            failures.push({
              field: 'comments',
              code: error instanceof DouyinError ? error.code : 'backend_unavailable',
              message: error instanceof DouyinError ? error.message : String(error),
            });
          }
        }

        return backendNote({
          video,
          comments,
          partial: failures.length > 0,
          failures,
          video_url: videoUrl(id),
          backend: source,
          fallback_from: fallbackFrom,
        });
      }),
    }),

    defineTool({
      name: 'douyin_user',
      description: 'Read a Douyin creator profile and recent works. Accepts a profile URL or a sec_uid. Read-only; profile and works count as two backend requests.',
      parameters: {
        user: { type: 'string', description: 'Profile URL (https://www.douyin.com/user/<sec_uid>) or sec_uid.' },
        sec_uid: { type: 'string', description: 'Alternative to user.' },
        post_limit: { type: 'integer', description: `Recent works, 0-${cfg.maxResults} (default 10).` },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(summarizeUser(value)),
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      execute: run('douyin_user', async (args, exec) => {
        const secUid = extractSecUid(args.user ?? args.sec_uid);
        if (!secUid) {
          throw new DouyinError('invalid_args', '无法从输入中提取 sec_uid；请传主页链接或 sec_uid。');
        }
        const postLimit = intArg(args.post_limit, 0, cfg.maxResults, 10);
        let rawUser = null;
        let rawPosts = null;
        let source = 'dy-cli (httpx + X-Bogus reverse API)';
        const failures = [];

        try {
          const result = await backend.runDy(
            ['profile', secUid, '--json-output'],
            { tool: 'douyin_user', timeoutMs: 60_000, signal: exec.signal, units: 1 },
          );
          rawUser = result.data ?? null;
        } catch (error) {
          const code = error instanceof DouyinError ? error.code : 'backend_unavailable';
          if (code === 'not_authenticated') throw error;
        }

        if (postLimit > 0) {
          try {
            const captured = await backend.runBrowser(
              'user',
              ['--sec-uid', secUid, '--post-limit', String(postLimit)],
              { tool: 'douyin_user', timeoutMs: 150_000, signal: exec.signal },
            );
            if (!rawUser) rawUser = captured.user ?? null;
            rawPosts = Array.isArray(captured.posts) ? captured.posts : [];
            source = 'browser_xhr (Edge, signed by the page)';
          } catch (error) {
            failures.push({
              field: 'posts',
              code: error instanceof DouyinError ? error.code : 'backend_unavailable',
              message: error instanceof DouyinError ? error.message : String(error),
            });
          }
        }

        if (!rawUser && !rawPosts) {
          throw new DouyinError('parse_failed', `用户 ${secUid} 的资料和作品都无法获取。`);
        }
        const posts = (rawPosts ?? []).map(normalizeAweme).filter(Boolean).slice(0, postLimit);
        return backendNote({
          user: normalizeUser(rawUser),
          posts,
          partial: failures.length > 0,
          failures,
          coverage: { profile: Boolean(rawUser), posts_returned: posts.length, posts_requested: postLimit },
          backend: source,
        });
      }),
    }),

    defineTool({
      name: 'douyin_status',
      description: 'Self-check entry point: reports whether Douyin is usable right now and why, including login phase, backend health, hourly request budget, and the last error. Read-only and never performs a network request (apart from a cached import probe).',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text([
          String(value.summary ?? 'douyin_status'),
          `登录：${value.login?.phase ?? 'idle'}${value.authenticated ? '（已确认）' : '（未确认）'}`,
          `本小时请求：${value.quota?.used ?? 0}/${value.quota?.limit ?? '?'}，剩余 ${value.quota?.remaining ?? '?'}`,
          value.last_error ? `上次错误：${value.last_error.code} — ${value.last_error.message}` : null,
        ].filter(Boolean).join('\n')),
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      execute: run('douyin_status', async (_args, exec) => backend.status({ signal: exec.signal })),
    }),

    defineTool({
      name: 'douyin_login_start',
      description: 'Open a visible, dedicated Edge window for Douyin login and return the current phase. This is a pollable state machine, not a blocking wait: scan the QR code yourself, then call douyin_login_status. Only one login browser may own the profile; a second start returns profile_in_use. Never headless.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(summarizeLogin(value)),
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: run('douyin_login_start', async (_args, exec) => {
        const value = await backend.loginStart({ signal: exec.signal });
        return { ...value, next_action: value.phase === 'qrcode' ? 'scan_qr_then_douyin_login_status' : undefined };
      }),
    }),

    defineTool({
      name: 'douyin_login_status',
      description: 'Poll the Douyin login state machine. Phases: idle, qrcode, sms_verification, sms_code_input, challenge_required, logged_in, expired, failed, stopped. Returns the QR screenshot path when one exists.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(summarizeLogin(value)),
      },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      execute: run('douyin_login_status', async (_args, exec) => backend.loginStatus({ signal: exec.signal })),
    }),

    defineTool({
      name: 'douyin_login_submit',
      description: 'Submit an SMS verification code to the running login session. Only valid while the phase is sms_code_input (or a pending verification page). Never bypasses a slider/security challenge; those must be completed manually in the visible window.',
      parameters: {
        codes: { type: 'string', required: true, description: '4-8 digit SMS code.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(summarizeLogin(value)),
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: run('douyin_login_submit', async (args, exec) => {
        const codes = String(args.codes ?? '').trim();
        if (!/^\d{4,8}$/.test(codes)) throw new DouyinError('invalid_args', 'codes 必须是 4-8 位数字。');
        return backend.loginSubmit(codes, { signal: exec.signal });
      }),
    }),

    defineTool({
      name: 'douyin_verify',
      description: 'Open a Douyin page in the dedicated Edge profile so YOU can manually complete a slider / SMS security challenge. Use this after douyin_search reports challenge_required. The plugin never solves or bypasses the challenge; it only makes the page visible and polls until the security text disappears.',
      parameters: {
        keyword: { type: 'string', description: 'Optional search keyword to open the affected search page.' },
        timeout_seconds: { type: 'integer', description: 'How long to keep the window open, 20-600 (default 180).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value.verified
          ? `验证已通过（耗时 ${Math.round((value.elapsed_ms ?? 0) / 1000)} 秒）。可以重试原工具。`
          : `验证尚未完成或超时。窗口截图：${value.screenshot ?? '(无)'}；若已手动完成，请直接重试原工具。`),
      },
      timeoutMs: 660_000,
      isConcurrencySafe: () => false,
      execute: run('douyin_verify', async (args, exec) => {
        const keyword = String(args.keyword ?? '').trim();
        const seconds = intArg(args.timeout_seconds, 20, 600, 180);
        const url = keyword
          ? `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`
          : 'https://www.douyin.com/';
        const value = await backend.runExclusive(() => backend.runBridge(
          'verify',
          ['--url', url, '--seconds', String(seconds)],
          { timeoutMs: (seconds + 30) * 1000, signal: exec.signal },
        ));
        return { ...value, url };
      }),
    }),

    defineTool({
      name: 'douyin_comment',
      description: 'Post ONE comment on one video. Dry-run by default: set dry_run=false and confirm=true to actually send. Disabled unless writesEnabled is true in plugin config. Refuses when the account fingerprint changed. At most one comment per call; no bulk or automated campaigns.',
      parameters: {
        aweme_id: { type: 'string', description: 'Target aweme id.' },
        url: { type: 'string', description: 'Alternative target video URL.' },
        content: { type: 'string', required: true, description: 'Comment text, 1-100 characters.' },
        dry_run: { type: 'boolean', description: 'Default true. When true, nothing is sent.' },
        confirm: { type: 'boolean', description: 'Must be exactly true to send when dry_run is false.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value.sent
          ? `评论已提交：${value.aweme_id}`
          : `未发送（${value.reason ?? (value.dry_run ? 'dry_run' : 'not_sent')}）。`),
      },
      timeoutMs: 240_000,
      isConcurrencySafe: () => false,
      execute: run('douyin_comment', async (args, exec) => {
        const id = extractAwemeId(args.aweme_id) ?? extractAwemeId(args.url);
        if (!id) throw new DouyinError('invalid_args', '需要合法的 aweme_id 或视频链接。');
        const content = String(args.content ?? '').trim();
        if (content.length === 0) throw new DouyinError('invalid_args', 'content 不能为空。');
        if (content.length > 100) throw new DouyinError('invalid_args', 'content 超过 100 字上限。');
        const dryRun = args.dry_run !== false;
        const preview = { aweme_id: id, content, video_url: videoUrl(id) };

        if (dryRun) {
          return { sent: false, dry_run: true, reason: 'dry_run', preview, next_step: 'Set dry_run=false and confirm=true to send (writesEnabled must also be true).' };
        }
        if (!cfg.writesEnabled) {
          return { sent: false, dry_run: false, reason: 'writes_disabled', preview, next_step: 'Set writesEnabled: true in the douyin plugin config before confirming.' };
        }
        if (args.confirm !== true) {
          return { sent: false, dry_run: false, reason: 'confirm_required', preview, next_step: 'Set confirm=true to send.' };
        }

        await backend.assertAccountMatch({ signal: exec.signal });
        const result = await backend.runBrowser(
          'comment',
          ['--aweme-id', id, '--content', content],
          { tool: 'douyin_comment', timeoutMs: 180_000, signal: exec.signal },
        );
        return {
          sent: Boolean(result.sent),
          dry_run: false,
          aweme_id: id,
          content,
          evidence: result.evidence ?? null,
          at: nowIso(),
        };
      }),
    }),

    defineTool({
      name: 'douyin_publish',
      description: 'Reserved publishing interface. Deliberately not implemented in this version: publishing is an irreversible public action that requires separate authorization. Always returns implemented=false without performing any action.',
      parameters: {
        title: { type: 'string', description: 'Planned title (interface only).' },
        content: { type: 'string', description: 'Planned caption (interface only).' },
        video_path: { type: 'string', description: 'Planned local video path (interface only).' },
        visibility: { type: 'string', enum: ['公开', '私密'], description: 'Planned visibility (interface only).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => text(value.message),
      },
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      execute: run('douyin_publish', async () => ({
        implemented: false,
        reason: 'not_authorized',
        message: '发布接口按任务书要求只保留签名，本次未实现，也没有执行任何动作。需要单独授权后再实现。',
      })),
    }),
  ];
}
