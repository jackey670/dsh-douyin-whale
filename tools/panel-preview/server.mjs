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
const { writeMemoryStore } = await import('../../lib/memory_layers.js');

// ── 样例数据（存在才不覆盖，方便反复实验） ─────────────────────────────
const paths = whalePaths();
if (!fs.existsSync(paths.state)) {
  fs.mkdirSync(paths.memoryDir, { recursive: true });
  // 记忆样例：1 事实 + 2 待确认（批量操作有东西可点）+ 公开/私人情节各一条
  writeMemoryStore(PREVIEW_HOME, {
    profile: {
      version: 1,
      updatedAt: '2026-11-20T00:00:00.000Z',
      facts: [{
        id: 'f_prev_01', text: '主人喜欢咖啡', category: 'preference', confidence: 0.9,
        first_seen: '2026-11-01', last_seen: '2026-11-20', pinned: true,
        superseded_by: '', visibility: 'public',
      }, {
        id: 'f_prev_02', text: '主人最近总在加班', category: 'fact', confidence: 0.8,
        first_seen: '2026-11-10', last_seen: '2026-11-20', pinned: false,
        superseded_by: '', visibility: 'public',
      }, {
        id: 'f_prev_03', text: '主人换了工作', category: 'fact', confidence: 0.8,
        first_seen: '2026-08-01', last_seen: '2026-08-01', pinned: false,
        superseded_by: 'f_prev_04', visibility: 'public',
      }, {
        id: 'f_prev_04', text: '主人在学吉他', category: 'fact', confidence: 0.8,
        first_seen: '2026-11-19', last_seen: '2026-11-19', pinned: false,
        superseded_by: '', visibility: 'public',
      }, {
        id: 'f_prev_05', text: '主人的生日在冬天', category: 'fact', confidence: 0.7,
        first_seen: '2026-11-12', last_seen: '2026-11-12', pinned: false,
        superseded_by: '', visibility: 'private',
      }],
      pending: [{
        id: 'p_prev_01', text: '主人最近在学吉他', category: 'preference', confidence: 0.65,
        first_seen: '2026-11-19', last_seen: '2026-11-19', evidence: '', visibility: 'public',
      }, {
        id: 'p_prev_02', text: '主人不喜欢吵闹的地方', category: 'boundary', confidence: 0.6,
        first_seen: '2026-11-20', last_seen: '2026-11-20', evidence: '', visibility: 'public',
      }],
      relationship: { stage: '', milestones: [] },
    },
    episodes: [{
      id: 'ep_prev_01', ts: '2026-11-18T12:00:00.000Z', kind: 'chat',
      summary: '主人加班到很晚，聊了会儿天。',
      evidence: [
        { source: 'dm', quote: '今天又加班到十点', at: '2026-11-18T12:00:00.000Z' },
        { source: 'dm', quote: '有点累但还行', at: '2026-11-18T12:05:00.000Z' },
      ],
      tags: ['加班'], importance: 3, valence: -1, visibility: 'public',
    }, {
      id: 'ep_prev_02', ts: '2026-11-19T12:00:00.000Z', kind: 'diary',
      summary: '私人日记：今天很想主人。',
      evidence: [{ source: 'diary', quote: '今天有点想主人' }],
      tags: ['私人日记'], importance: 2, valence: 1, visibility: 'private',
    }, {
      id: 'ep_prev_03', ts: '2026-11-20T12:00:00.000Z', kind: 'chat',
      summary: '主人又加班了，这周第三次，给他打了打气。',
      evidence: [{ source: 'dm', quote: '这周第三次加班了', at: '2026-11-20T12:00:00.000Z' }],
      tags: ['加班', '私信'], importance: 2, valence: -1, visibility: 'public',
    }, {
      id: 'ep_prev_04', ts: '2026-11-21T12:00:00.000Z', kind: 'chat',
      summary: '周末去看了海，风很大，拍了不少照片。',
      evidence: [{ source: 'dm', quote: '周末去看了海，风很大', at: '2026-11-21T12:00:00.000Z' }],
      tags: ['看海'], importance: 3, valence: 1, visibility: 'public',
    }, {
      id: 'ep_prev_05', ts: '2026-11-22T12:00:00.000Z', kind: 'chat',
      summary: '团子今天特别粘人，趴在键盘上不肯走。',
      evidence: [{ source: 'dm', quote: '团子今天趴键盘上不下来', at: '2026-11-22T12:00:00.000Z' }],
      tags: ['猫咪'], importance: 3, valence: 1, visibility: 'public',
    }, {
      id: 'ep_prev_06', ts: '2026-11-23T12:00:00.000Z', kind: 'chat',
      summary: '主人换了新工作，替他高兴，也有点担心他太累。',
      evidence: [{ source: 'dm', quote: '我换工作了', at: '2026-11-23T12:00:00.000Z' }],
      tags: ['工作'], importance: 4, valence: 1, visibility: 'public',
    }, {
      id: 'ep_prev_07', ts: '2026-11-24T12:00:00.000Z', kind: 'chat',
      summary: '主人说想学吉他，聊了半天买什么琴。',
      evidence: [{ source: 'dm', quote: '想学吉他但不知道买哪种', at: '2026-11-24T12:00:00.000Z' }],
      tags: ['吉他', '工作'], importance: 2, valence: 1, visibility: 'public',
    }, {
      id: 'ep_prev_08', ts: '2026-11-25T12:00:00.000Z', kind: 'chat',
      summary: '主人给我带了咖啡，说加班也要续命。',
      evidence: [{ source: 'dm', quote: '给你带了杯咖啡', at: '2026-11-25T12:00:00.000Z' }],
      tags: ['咖啡', '加班'], importance: 3, valence: 1, visibility: 'public',
    }],
    arcs: {
      version: 1,
      updatedAt: '2026-11-23T00:00:00.000Z',
      arcs: [{
        id: 'arc_prev_01', period: '2026-11-17 ~ 2026-11-23', title: '赶项目的一周',
        summary: '主人连续加班，周末才缓过来。',
        episode_ids: ['ep_prev_01', 'ep_prev_03'], visibility: 'public',
        createdAt: '2026-11-23T00:00:00.000Z',
      }],
    },
    meta: {
      version: 1, migratedAt: '2026-11-01T00:00:00.000Z',
      lastConsolidatedAt: '2026-11-20T00:00:00.000Z',
    },
  });
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
      { item_id: '7700999000000000001', title: '测试占位第七条：验证队列收起展开',
        kind: 'text', seen_at: '2026-10-25T07:00:00.000Z' },
      { item_id: '7700999000000000002', title: '测试占位第八条：展开后才能看到我',
        kind: 'text', seen_at: '2026-10-25T08:00:00.000Z' },
      { item_id: '7700999000000000003', title: '测试占位第九条：展开后才能看到我',
        kind: 'text', seen_at: '2026-10-25T09:00:00.000Z' },
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
<script src="/client.js?v=__DY2V__"><\/script>
</body></html>`;

const apiHandle = createWhaleApi({ log: (m) => console.log('[api]', m) });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      return send(res, 200, INDEX_HTML.replace('__DY2V__', String(Date.now())), MIME['.html']);
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
