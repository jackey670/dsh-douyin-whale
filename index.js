/**
 * dsh-douyin-toolkit — a Cordis Host plugin that exposes Douyin read tools, a
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

export const name = 'douyin';
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
