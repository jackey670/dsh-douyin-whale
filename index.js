/**
 * dsh-douyin-whale — a Cordis Host plugin that exposes Douyin read tools, a
 * pollable QR/SMS login state machine, one guarded comment tool, and a
 * reserved publish interface.
 *
 * Architecture (Plan A): this package never implements X-Bogus, cookies, or
 * anti-bot logic. Read paths shell out to dy-cli (`python -m dy_cli.main`);
 * the only extra Python is an offset flag for search and a small Playwright
 * bridge that drives the system Edge for login and comment.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Backend, resolveConfig } from './lib/backend.js';
import { createTools } from './lib/tools.js';
import { createWhaleApi } from './lib/panel_api.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Map tool names to the per-tool switches in `config.toolEnabled`. */
const TOOL_SWITCH = {
  douyin_hot: 'hot',
  douyin_search: 'search',
  douyin_video: 'video',
  douyin_user: 'user',
  douyin_status: 'status',
  douyin_login_start: 'login',
  douyin_login_status: 'login',
  douyin_login_submit: 'login',
  douyin_verify: 'verify',
  douyin_comment: 'comment',
  douyin_publish: 'publish',
};

export const name = 'douyin-whale';
export const inject = ['tools'];

/**
 * Register every Douyin tool and release the backend when the plugin unloads.
 * @param ctx Cordis plugin context carrying the tool registry.
 * @param config Loader row config (all fields optional).
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(ROOT, config ?? {});
  if (!resolved.enabled) return;

  ctx.effect(() => {
    const backend = new Backend(resolved);
    const tools = createTools(backend).filter((tool) => {
      const key = TOOL_SWITCH[tool.name];
      return key ? resolved.toolEnabled[key] !== false : true;
    });
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    backend.log({
      tool: 'plugin',
      ok: true,
      event: 'registered',
      tools: disposers.length,
      disabled: Object.entries(TOOL_SWITCH)
        .filter(([name, key]) => resolved.toolEnabled[key] === false)
        .map(([name]) => name),
    });

    // ── 设置页面板（可选宿主能力）──
    // ctx.webServer 没有时只影响面板，工具照常工作 —— 绝不因它让插件挂掉。
    try {
      const webServer =
        (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) ??
        ctx.webServer;
      if (webServer && typeof webServer.register === 'function') {
        const apiLog = (message) => {
          try {
            backend.log({ tool: 'panel', ok: true, event: 'api', message });
          } catch {
            /* 日志失败不影响请求 */
          }
        };
        const handle = createWhaleApi({ log: apiLog });
        ctx.effect(() => webServer.register({
          kind: 'prefix',
          path: '/api/douyin-whale',
          handler: async (req, res) => {
            try {
              await handle(req, res, new URL(req.url, 'http://127.0.0.1'));
            } catch {
              /* handle 内部已兜底成 JSON，这里不该再抛 */
            }
          },
        }), 'douyin-whale: /api/douyin-whale 路由');
        backend.log({ tool: 'panel', ok: true, event: 'router_registered' });
      } else {
        backend.log({
          tool: 'panel',
          ok: false,
          event: 'webServer_unavailable',
          hint: '宿主没有提供 webServer 能力，设置页面板不可用（工具不受影响）',
        });
      }
    } catch (e) {
      backend.log({
        tool: 'panel',
        ok: false,
        event: 'router_error',
        message: String(e?.message ?? e),
      });
    }

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* unloading must not throw */
        }
      }
      backend.dispose();
    };
  }, 'douyin tools');
}
