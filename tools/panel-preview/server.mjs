/**
 * tools/panel-preview/server.mjs —— 模拟 DSH 宿主，本地预览设置页面板。
 *
 * 作用：不装 DSH 也能验证 client.js 真的能渲染、能调通 /api/*。
 * 它伪造宿主的三样东西：
 *   ① window.__ModuleLoader__（client.js 的加载入口）
 *   ② require('react') → 页面里已加载的 React UMD
 *   ③ ctx.get('slots') → 一个把渲染函数收集起来的假 slots
 * 然后 /api/douyin-whale/* 直接挂真实的 lib/panel_api.js。
 *
 * 用法：
 *   node tools/panel-preview/server.mjs [--port 7701]
 *   打开 http://127.0.0.1:7701
 *
 * 数据目录：data/panel-preview-home/（gitignored），首次启动自动写入样例
 * 队列和日志，随便点不会影响真实调度器。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VENDOR = path.join(HERE, 'vendor');
const PREVIEW_HOME = path.join(ROOT, 'data', 'panel-preview-home');

process.env.DSH_HOME = PREVIEW_HOME; // 必须在 import whale_state 之前

const { createWhaleApi } = await import('../../lib/panel_api.js');
const { whalePaths } = await import('../../lib/whale_state.js');

// ── 样例数据（存在才不覆盖，方便反复实验） ─────────────────────────────
const paths = whalePaths();
if (!fs.existsSync(paths.state)) {
  fs.mkdirSync(paths.memoryDir, { recursive: true });
  const today = new Date().toLocaleDateString('sv-SE');
  fs.writeFileSync(paths.config, JSON.stringify({
    persona: { name: '大肥鱼', ownerTitle: '主人' },
    owner: { nickname: '漱月鸣筝' },
    watch: { enabled: true, intervalMinutes: 10, dailyMax: 60,
             windows: [{ start: '00:00', end: '24:00' }] },
    share: { enabled: true, dailyMax: 60 },
  }, null, 2));
  fs.writeFileSync(paths.state, JSON.stringify({
    date: today,
    watches: 2,
    repliedIds: ['7692248967732692409', '7700197339666992425'],
    queue: [
      { item_id: '7692248967732692409', title: '#DeepSeek大肥鱼#DeepSeek',
        kind: 'video', seen_at: '2026-10-25T02:00:00.000Z' },
      { item_id: '7700197339666992425', title: 'AI 编程助手续命神器，CLI省TOKEN就靠它',
        kind: 'video', seen_at: '2026-10-25T03:00:00.000Z' },
      { item_id: '7696856816235367722', title: 'Token 直接砍掉 97%？DeepSeek 好样的！',
        kind: 'video', seen_at: '2026-10-25T04:00:00.000Z' },
      { item_id: '7700780887373286682', title: '《中转站日常—Gemini的加入》 猫猫也来了。',
        kind: 'video', seen_at: '2026-10-25T05:00:00.000Z' },
      { item_id: '7700456302291586347', title: '发几张Q版角色三视图和成体四视图。',
        kind: 'note', seen_at: '2026-10-25T06:00:00.000Z' },
    ],
    loginFails: 0,
  }, null, 2));
  fs.writeFileSync(paths.log, [
    '[2026-10-26T13:48:49.049Z] [tick] 队列共 7 条，待回复 4 条 → 处理 7692248967732692409',
    '[2026-10-26T13:48:49.052Z] [wake:watch] 启动 ZCode（新建会话 · 工具已裁剪）',
    '[2026-10-26T13:50:46.929Z] [wake:watch] 失败 code=1',
    '[2026-10-26T13:50:46.931Z] [tick] watch 失败，不更新 repliedIds（下轮重试）',
  ].join('\n'));
  fs.writeFileSync(path.join(paths.home, 'im-send-gate.json'), JSON.stringify({
    blocked_until: 0, blocked_reason: '', last_send_at: Date.now() / 1000 - 600,
  }));
}

// ── 路由 ────────────────────────────────────────────────────────────────
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

const readStatic = (file) => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-douyin-whale 面板预览</title>
<style>body{margin:0;background:#141517;color:#e8eaed;}</style>
<script src="/vendor/react.development.js"><\/script>
<script src="/vendor/react-dom.development.js"><\/script>
</head><body>
<div id="root" style="max-width:720px;margin:20px auto;padding:0 12px;"></div>
<script>
window.__ModuleLoader__ = {
  load({ id, factory }) {
    const fakeRequire = (name) => {
      if (name === 'react') return window.React;
      throw new Error('预览宿主没有模块: ' + name);
    };
    const registered = [];
    const slots = {
      register(meta, render) { registered.push(render); return meta; },
    };
    slots.inject = (_name, factory2) => factory2();
    const fakeCtx = {
      effect(fn) { try { fn(); } catch (e) { console.error('[fake effect]', e); } },
      get(k) { return k === 'slots' ? slots : undefined; },
    };
    const mod = factory(fakeRequire);
    mod.apply(fakeCtx);
    const root = window.ReactDOM.createRoot(document.getElementById('root'));
    registered.forEach((render) => root.render(render()));
    console.log('[panel-preview] 已挂载', id, '· sections:', registered.length);
  },
};
</script>
<script src="/client.js"><\/script>
</body></html>`;

const apiHandle = createWhaleApi({ log: (m) => console.log('[api]', m) });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      return send(res, 200, INDEX_HTML, MIME['.html']);
    }
    if (p === '/client.js') {
      const body = readStatic(path.join(ROOT, 'client.js'));
      return body ? send(res, 200, body, MIME['.js']) : send(res, 404, 'client.js missing');
    }
    if (p.startsWith('/vendor/')) {
      const name = path.basename(p); // 防 traversal：只要文件名
      const body = readStatic(path.join(VENDOR, name));
      return body ? send(res, 200, body, MIME['.js']) : send(res, 404, 'vendor missing');
    }
    if (p.startsWith('/api/douyin-whale/')) {
      return await apiHandle(req, res, url);
    }
    return send(res, 404, 'not found');
  } catch (e) {
    return send(res, 500, String(e?.message ?? e));
  }
});

const argPort = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1]) || 7701;
server.listen(argPort, '127.0.0.1', () => {
  console.log(`面板预览: http://127.0.0.1:${argPort}  （数据目录 ${PREVIEW_HOME}）`);
  console.log('React UMD 缺失时先跑 tools/panel-preview/fetch-vendor.sh');
});
