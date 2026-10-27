/**
 * lib/services.js —— 读取「可选」Cordis 服务
 * ============================================================================
 * 为什么不能直接 `ctx.get(name)`：
 *   Cordis 4 的 `ctx` 是代理，访问没有写进插件 `inject` 的服务会直接抛
 *   `cannot get property "x" without inject`。把 webServer / agents 写进
 *   `inject` 又会让插件在缺这些能力的宿主上**整个不加载**（inject 是硬依赖）。
 *
 *   `ctx.reflect.get(name)` 是官方留的旁路：不要求 inject，服务不存在时返回
 *   undefined。这样面板和值班大脑都是「有就接上、没有就降级」，工具始终可用。
 *
 * 2026-10-27 在真 DSH 宿主上实测：不加这层，面板路由注册直接失败
 * （日志 `router_error: cannot get property "webServer" without inject`）。
 * ============================================================================
 */

/**
 * 安全读取一个可选服务。
 * @param {object} ctx Cordis 插件上下文
 * @param {string} name 服务名（webServer / agents / agentDefaultModel …）
 * @returns {any} 服务实例，或 undefined
 */
export function serviceOf(ctx, name) {
  if (!ctx || !name) return undefined;
  try {
    if (typeof ctx.reflect?.get === 'function') {
      const found = ctx.reflect.get(name);
      if (found !== undefined) return found;
    }
  } catch {
    /* reflect 不可用就继续试下一条路 */
  }
  try {
    if (typeof ctx.get === 'function') {
      const found = ctx.get(name);
      if (found !== undefined) return found;
    }
  } catch {
    /* 没 inject —— 正常情况，继续 */
  }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}
