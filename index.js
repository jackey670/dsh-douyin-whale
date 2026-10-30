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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Backend, resolveConfig } from './lib/backend.js';
import { createTools } from './lib/tools.js';
import { createWhaleApi } from './lib/panel_api.js';
import { createDutyAgent } from './lib/duty_agent.js';
import { createWhaleTick } from './lib/whale_tick.js';
import { readConfig, whalePaths } from './lib/whale_state.js';

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

  // 面板的「测试值班会话」按钮用：值班 fiber 就绪后指向真正的 ensure()。
  // 关掉 whaleEnabled 或宿主没有 agents 时保持 null，路由会回 400 说明原因。
  let dutyProbe = null;

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
    // webServer 可能比本插件晚就绪，用 ctx.inject 等它；宿主没有这个能力时
    // 回调永远不执行，工具照常工作 —— 绝不因面板让插件挂掉。
    // 不能直接 ctx.get / ctx.webServer：没写进静态 inject 会抛错（见 lib/services.js）。
    const panelFiber = ctx.inject(['webServer'], (webCtx) => {
      try {
        const webServer = webCtx.webServer;
        if (!webServer || typeof webServer.register !== 'function') {
          backend.log({
            tool: 'panel',
            ok: false,
            event: 'webServer_unavailable',
            hint: '宿主 webServer 没有 register，设置页面板不可用（工具不受影响）',
          });
          return;
        }
        const apiLog = (message) => {
          try {
            backend.log({ tool: 'panel', ok: true, event: 'api', message });
          } catch {
            /* 日志失败不影响请求 */
          }
        };
        const handle = createWhaleApi({
          log: apiLog,
          dataDir: resolved.dataDir,
          dutyEnabled: resolved.whaleEnabled !== false,
          dutyProbe: () => (typeof dutyProbe === 'function' ? dutyProbe() : null),
        });
        webCtx.effect(() => webServer.register({
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
      } catch (e) {
        backend.log({
          tool: 'panel',
          ok: false,
          event: 'router_error',
          message: String(e?.message ?? e),
        });
      }
    });

    // ── 值班 tick（发布版的大脑；需要宿主 agents 能力）──
    // agents 不可用时降级：只打日志，工具和面板照常。独立调度器（ZCode 版）
    // 仍是本地执行路径，两者写同一份 ~/.dsh 状态，**不要同时开**。
    let dutyFiber = null;
    if (resolved.whaleEnabled === false) {
      backend.log({
        tool: 'duty',
        ok: true,
        event: 'disabled',
        hint: 'whaleEnabled=false，值班大脑不启动（工具与面板不受影响）',
      });
    } else {
      dutyFiber = ctx.inject(['agents'], (agentCtx) => {
        try {
          const dutyLog = (message) => {
            try { backend.log({ tool: 'duty', ok: true, event: 'log', message }); } catch { /* ignore */ }
          };
          const dutyAgent = createDutyAgent({
            ctx: agentCtx,
            log: dutyLog,
            sessionId: 'douyin-whale-duty-v1',
            cwd: resolved.dataDir || join(ROOT, 'data'),
            // 值班会话模型路由：配置了 duty.provider/duty.model 就用它们
            // （pi-ai 自定义网关），否则跟随宿主默认。
            modelSelection: (resolved.dutyProvider && resolved.dutyModel)
              ? { provider: resolved.dutyProvider, model: resolved.dutyModel }
              : null,
            // 人设已内置在 lib/duty_agent.js 的 DEFAULT_SYSTEM_PROMPT 里；
            // 需要个性化时读 ~/.dsh 配置再拼 personaText 即可。
          });
          const tick = createWhaleTick({
            log: dutyLog, dutyAgent, root: ROOT, dataDir: resolved.dataDir,
          });
          // 面板自检：只拉会话（get/resume/create），不投任务、不发私信。
          // 20 秒超时兜底，避免 agents.create 卡住 HTTP 请求。
          dutyProbe = async () => {
            try {
              const handle = await Promise.race([
                dutyAgent.ensure(),
                new Promise((resolve) => setTimeout(() => resolve('timeout'), 20_000)),
              ]);
              if (handle === 'timeout') {
                return { ok: false, error: '值班会话创建超时（20s）——看插件日志确认 agents.create 卡在哪' };
              }
              return handle
                ? { ok: true, sessionId: 'douyin-whale-duty-v1', note: '值班会话已就绪' }
                : { ok: false, error: '值班会话没拉起来（宿主 agents 不可用或 create 失败，详见插件日志）' };
            } catch (e) {
              return { ok: false, error: String(e?.message ?? e) };
            }
          };
          agentCtx.effect(() => () => { dutyProbe = null; }, 'douyin-whale: duty probe');
          agentCtx.effect(() => {
            let disposed = false;
            let timer = null;
            const schedule = (afterMs) => {
              if (disposed) return;
              timer = setTimeout(async () => {
                try { await tick(); } catch { /* tick 内部已兜底 */ }
                schedule(Math.max(1, Number(readConfig(whalePaths()).watch?.intervalMinutes ?? 10) || 10) * 60_000);
              }, afterMs);
            };
            schedule(15_000); // 装载后 15 秒先跑一轮，之后按配置间隔
            return () => { disposed = true; if (timer) clearTimeout(timer); };
          }, 'douyin-whale: duty timer');
          backend.log({ tool: 'duty', ok: true, event: 'timer_started' });
        } catch (e) {
          backend.log({
            tool: 'duty', ok: false, event: 'timer_error', message: String(e?.message ?? e),
          });
        }
      });
    }

    return () => {
      for (const fiber of [dutyFiber, panelFiber]) {
        try { fiber?.dispose?.(); } catch { /* unloading must not throw */ }
      }
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
