/**
 * dsh-douyin-whale —— 浏览器半端（设置里的一页，中文名「大肥鱼刷抖音」）
 * ============================================================================
 * 结构对齐 dsh-douyin-scroll 的做法：
 *   · 整个面板包在 Boundary（error boundary）里 —— 任何子组件抛错只显示
 *     「这页出错了 + 重试」，不会再整块消失。
 *   · 数据一律来自 /api/douyin-whale/*，**只读运行时状态**；写操作仅限
 *     改配置和启停调度器。面板不提供绕过发送闸的发消息入口。
 *   · CSS 用宿主的设计令牌（--dsw-alias-*），深浅色自动跟随。
 *
 * ⭐ PANEL_BUILD：每次改完 client.js 就 +1，面板右上角 v1.5.1·b<N> 用来
 *   排「浏览器还在用缓存」的障。版本号必须和 package.json 一致 ——
 *   tools/release-audit.mjs 会机械核对，别让它漂。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-whale',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const API = '/api/douyin-whale';
    const PANEL_BUILD = 27;

    const asJson = async (res) => {
      if (res.ok) return res.json();
      const why =
        res.status === 401 ? '（未登录 / 没权限）' :
        res.status === 403 ? '（被宿主拦了）' :
        res.status === 404 ? '（宿主没有挂上 /api/douyin-whale 路由）' : '';
      throw new Error('HTTP ' + res.status + why);
    };
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }));
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }));
    const jdel = async (p) => asJson(await fetch(API + p, {
      method: 'DELETE', credentials: 'same-origin',
    }));

    const CSS = `
[data-dy2-page]{display:flex;flex-direction:column;gap:14px;padding:4px 2px 12px;max-width:680px;font-size:13px;}
[data-dy2-card]{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-dy2-title]{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;}
[data-dy2-sub]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy2-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-dy2-grow]{flex:1;min-width:0;}
[data-dy2-btn]{padding:7px 13px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-dy2-btn]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dy2-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dy2-btn][data-danger]{border-color:#ef4444;color:#ef4444;}
[data-dy2-btn][disabled]{opacity:.5;cursor:default;}
[data-dy2-input]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dy2-form]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 16px;}
[data-dy2-grouphead]{padding-top:2px;}
[data-dy2-grouplabel]{font-size:12px;font-weight:600;line-height:18px;
  color:var(--dsw-alias-label-secondary,#b9bfc7);border-left:2px solid #3b82f6;padding-left:8px;}
[data-dy2-field]{display:flex;flex-direction:column;gap:6px;min-width:0;}
[data-dy2-field][data-wide]{grid-column:1/-1;}
[data-dy2-label]{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary,#b9bfc7);}
[data-dy2-control]{display:flex;align-items:center;gap:8px;min-width:0;}
[data-dy2-control] [data-dy2-input]{flex:1;min-width:0;}
[data-dy2-unit]{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);white-space:nowrap;}
[data-dy2-hint]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy2-switch]{display:flex;align-items:flex-start;gap:10px;cursor:pointer;}
[data-dy2-switch] input{width:16px;height:16px;margin:1px 0 0;accent-color:#3b82f6;cursor:pointer;flex:none;}
[data-dy2-actions]{display:flex;justify-content:flex-end;gap:8px;}
@media (max-width:560px){[data-dy2-form]{grid-template-columns:1fr;}}
[data-dy2-kv]{display:flex;gap:6px;font-size:12px;line-height:20px;flex-wrap:wrap;}
[data-dy2-k]{color:var(--dsw-alias-label-secondary,#b9bfc7);min-width:72px;}
[data-dy2-stats]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 16px;}
[data-dy2-stat]{display:flex;flex-direction:column;gap:2px;min-width:0;}
[data-dy2-stat] [data-dy2-k]{min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy2-v]{font-size:14px;line-height:20px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-dy2-nav] > svg{display:none !important;}
[data-dy2-nav]::before{content:'🐳';width:16px;font-size:14px;line-height:16px;text-align:center;flex:none;}
@media (max-width:560px){[data-dy2-stats]{grid-template-columns:repeat(2,minmax(0,1fr));}}
[data-dy2-badge]{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));}
[data-dy2-badge]::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;}
[data-dy2-badge="data-ok"]{color:#4ade80;background:rgba(34,197,94,.13);border-color:rgba(34,197,94,.4);}
[data-dy2-badge="data-warn"]{color:#fbbf24;background:rgba(245,158,11,.13);border-color:rgba(245,158,11,.4);}
[data-dy2-badge="data-err"]{color:#f87171;background:rgba(239,68,68,.13);border-color:rgba(239,68,68,.4);}
[data-dy2-log]{max-height:240px;overflow:auto;font-family:ui-monospace,Consolas,monospace;
  font-size:11px;line-height:16px;padding:8px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.18));white-space:pre-wrap;word-break:break-all;}
[data-dy2-item]{display:flex;gap:8px;align-items:flex-start;padding:7px 9px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));}
[data-dy2-item="pending"]{border-left:3px solid #3b82f6;background:rgba(59,130,246,.07);}
[data-dy2-item="failed"]{border-left:3px solid #ef4444;background:rgba(239,68,68,.06);}
[data-dy2-item="done"]{opacity:.55;}
[data-dy2-alert]{padding:10px 12px;border-radius:8px;font-size:12px;line-height:18px;
  background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#fca5a5;}
[data-dy2-seg]{display:inline-flex;padding:3px;border-radius:8px;gap:2px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));}
[data-dy2-seg] button{border:none;background:transparent;padding:5px 12px;border-radius:6px;
  font-size:12px;color:var(--dsw-alias-label-secondary,#b9bfc7);cursor:pointer;font-family:inherit;}
[data-dy2-seg] button[aria-pressed="true"]{background:rgba(255,255,255,.14);color:inherit;font-weight:600;}
[data-dy2-empty]{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);padding:6px 2px;}
[data-dy2-moodbars]{display:flex;flex-direction:column;gap:7px;}
[data-dy2-moodrow]{display:flex;align-items:center;gap:10px;font-size:12px;}
[data-dy2-moodk]{width:36px;flex:none;color:var(--dsw-alias-label-secondary,#b9bfc7);}
[data-dy2-track]{flex:1;height:8px;border-radius:999px;overflow:hidden;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.18));}
[data-dy2-fill]{height:100%;border-radius:999px;transition:width .3s ease;}
[data-dy2-moodv]{width:30px;flex:none;text-align:right;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy2-textarea]{min-height:104px;resize:vertical;line-height:1.55;}
[data-dy2-search]{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
[data-dy2-search] [data-dy2-input]{flex:1;min-width:180px;}
[data-dy2-memlist]{display:flex;flex-direction:column;gap:6px;}
[data-dy2-item] [data-dy2-btn]{padding:4px 9px;font-size:11px;flex:none;}
[data-dy2-quote-block]{margin-top:6px;padding:6px 9px;border-left:2px solid var(--dsw-alias-border-strong,rgba(128,128,128,.45));
  border-radius:4px;background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.07));}
[data-dy2-quote]{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#b6bac0);margin:2px 0;}
[data-dy2-star]{position:relative;height:420px;border-radius:12px;overflow:hidden;
  background:radial-gradient(ellipse at 50% 45%,rgba(56,189,248,.10),rgba(2,6,23,.55) 58%,rgba(2,6,23,.9));
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));}
[data-dy2-star][data-full="1"]{position:fixed;inset:8px;height:auto;z-index:90;
  box-shadow:0 24px 80px rgba(0,0,0,.6);
  background:radial-gradient(ellipse at 50% 45%,rgba(56,189,248,.14),rgba(2,6,23,0) 62%),#020617;}
[data-dy2-star] canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab;}
[data-dy2-star] canvas:active{cursor:grabbing;}
[data-dy2-star-hud]{position:absolute;left:10px;top:8px;display:flex;gap:12px;align-items:center;
  flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  pointer-events:none;z-index:2;}
[data-dy2-star-legend]{display:inline-flex;align-items:center;gap:5px;}
[data-dy2-star-dot]{width:7px;height:7px;border-radius:50%;display:inline-block;}
[data-dy2-star-exit]{position:absolute;right:10px;top:8px;z-index:3;}
[data-dy2-star-detail]{position:absolute;left:10px;bottom:10px;right:10px;z-index:2;
  padding:9px 11px;border-radius:10px;max-height:46%;overflow:auto;
  background:rgba(2,6,23,.72);border:1px solid rgba(148,163,184,.28);backdrop-filter:blur(6px);}
[data-dy2-star-detail] [data-dy2-kv]{color:#e2e8f0;}
[data-dy2-star-detail] [data-dy2-sub]{color:#94a3b8;}
[data-dy2-star-hint]{position:absolute;right:10px;bottom:8px;z-index:1;font-size:10px;
  color:rgba(148,163,184,.55);pointer-events:none;}
`;

    /* ── 错误边界：面板任何一块抛错，都只塌这一页 ─────────────────────── */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) { return { err }; }
      render() {
        if (!this.state.err) return this.props.children;
        return h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '这页出错了'),
          h('div', { 'data-dy2-sub': '' },
            String(this.state.err?.message ?? this.state.err)),
          h('div', { 'data-dy2-row': '' },
            h('button', {
              'data-dy2-btn': '',
              onClick: () => this.setState({ err: null }),
            }, '重试')));
      }
    }

    const fmtAgo = (sec) => {
      if (sec === null || sec === undefined) return '—';
      if (sec < 60) return `${sec} 秒前`;
      if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
      return `${Math.floor(sec / 3600)} 小时前`;
    };
    const fmtWhen = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? String(iso) :
        `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    /* ── 记忆星图 ───────────────────────────────────────────────────────
       纯 canvas 3D：轨道相机 + 透视投影 + 光晕精灵，不引第三方库。
       数据由 /memory/graph 下发；这里只负责摆位、画、点选。 */
    const STAR_TYPE = {
      self: { label: '自我', color: '#f8fafc' },
      owner: { label: '主人', color: '#fda4af' },
      trait: { label: '性格', color: '#a78bfa' },
      fact: { label: '事实', color: '#fbbf24' },
      episode: { label: '情节', color: '#5eead4' },
      arc: { label: '叙事线', color: '#c084fc' },
      topic: { label: '主题', color: '#38bdf8' },
    };
    const STAR_EDGE = {
      core: '#f5d0a9', about: '#38bdf8', evidence: '#fbbf24',
      part_of: '#c084fc', related: '#64748b', supersedes: '#ef4444', co_recall: '#fb923c',
    };
    const starHash = (s) => {
      let x = 2166136261;
      for (let i = 0; i < String(s).length; i += 1) {
        x ^= String(s).charCodeAt(i);
        x = Math.imul(x, 16777619);
      }
      return x >>> 0;
    };
    const starRand = (seed) => {
      let s = seed >>> 0;
      return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
      };
    };
    const hexRgba = (hex, a) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
      if (!m) return `rgba(148,163,184,${a})`;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };
    const starSprites = new Map();
    const starSprite = (color) => {
      if (starSprites.has(color)) return starSprites.get(color);
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,.95)');
      grad.addColorStop(0.22, color);
      grad.addColorStop(0.55, hexRgba(color, 0.32));
      grad.addColorStop(1, hexRgba(color, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      starSprites.set(color, c);
      return c;
    };

    /** 轨道布局：按类型分层，情节按主标签聚成星座；时间布局把 x 换成时间轴。 */
    const starLayout = (nodes, mode) => {
      const pos = new Map();
      const rand = starRand(20261126);
      const put = (id, x, y, z) => pos.set(id, { x, y, z });
      const list = (type) => nodes.filter((n) => n.type === type);
      put('self', 0, 0, 0);
      put('owner', 0.16, 0.1, 0.08);
      const ring = (arr, r, tilt = 0.38) => arr.forEach((n, i) => {
        const a = (i / Math.max(1, arr.length)) * Math.PI * 2 + rand() * 0.12;
        put(n.id, r * Math.cos(a), Math.sin(a) * r * tilt, r * Math.sin(a));
      });

      if (mode === 'time') {
        const times = nodes
          .map((n) => Date.parse(n.ts || ''))
          .filter((t) => Number.isFinite(t));
        const min = times.length ? Math.min(...times) : 0;
        const max = times.length ? Math.max(...times) : min + 1;
        const span = Math.max(1, max - min);
        for (const n of nodes) {
          const t = Date.parse(n.ts || '');
          const x = Number.isFinite(t) ? ((t - min) / span) * 2.5 - 1.25 : -1.42;
          put(n.id,
            x,
            ((starHash(`${n.id}y`) % 1000) / 1000 - 0.5) * 0.9,
            ((starHash(`${n.id}z`) % 1000) / 1000 - 0.5) * 0.9);
        }
        return pos;
      }

      const tagCount = new Map();
      for (const n of list('episode')) {
        for (const t of n.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
      }
      const tagAngle = new Map(
        [...tagCount.keys()].sort().map((t, i) => [t, 0.6 + i * 2.39996]),
      );
      const angleOf = (tag) => {
        if (!tagAngle.has(tag)) tagAngle.set(tag, rand() * Math.PI * 2);
        return tagAngle.get(tag);
      };
      ring(list('trait'), 0.42, 0.5);
      ring(list('fact'), 0.78, 0.36);
      ring(list('arc'), 1.02, 0.3);
      ring(list('topic'), 1.24, 0.34);
      for (const n of list('episode')) {
        const tags = [...(n.tags || [])].sort((a, b) => (tagCount.get(b) || 0) - (tagCount.get(a) || 0));
        const base = tags.length ? angleOf(tags[0]) : rand() * Math.PI * 2;
        const a = base + (((starHash(n.id) % 1000) / 1000) - 0.5) * 0.55;
        const r = 1.45 + ((starHash(`${n.id}r`) % 1000) / 1000) * 0.55;
        const y = (((starHash(`${n.id}y`) % 1000) / 1000) - 0.5) * 0.72;
        put(n.id, r * Math.cos(a), y, r * Math.sin(a));
      }
      return pos;
    };

    function StarMap({ graph, layout, full, onToggleFull }) {
      const canvasRef = useRef(null);
      const wrapRef = useRef(null);
      const engineRef = useRef(null);
      const pickRef = useRef(null);
      const selectedRef = useRef(null);
      const [selected, setSelected] = useState(null);
      const [evidence, setEvidence] = useState(null);
      const [evBusy, setEvBusy] = useState(false);

      const pick = useCallback(async (node) => {
        setSelected(node);
        setEvidence(null);
        if (!node || node.type !== 'episode') return;
        setEvBusy(true);
        try {
          const j = await jget(`/memory/episode?id=${encodeURIComponent(node.id)}`
            + `&private=${node.private ? 1 : 0}`);
          if (j.ok) setEvidence(j.episode);
          else setEvidence({ error: j.error || '这条原话打不开' });
        } catch (e) {
          setEvidence({ error: String(e?.message ?? e) });
        } finally {
          setEvBusy(false);
        }
      }, []);
      pickRef.current = pick;
      selectedRef.current = selected?.id || null;

      useEffect(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (!canvas || !wrap || !graph?.nodes?.length) return undefined;
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;
        const nodes = graph.nodes;
        const edges = graph.edges || [];
        const pos = starLayout(nodes, layout);
        const cam = { yaw: 0.62, pitch: 0.3, zoom: 1 };
        const bg = Array.from({ length: 150 }, () => ({
          x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.4,
          p: Math.random() * Math.PI * 2,
        }));
        let W = 600; let H = 420; let dpr = 1;
        let raf = 0; let last = 0;
        let hovered = null;
        let selectedId = selectedRef.current;
        let dragging = false; let moved = 0; let lx = 0; let ly = 0;
        const screen = new Map();

        const fit = () => {
          const rect = wrap.getBoundingClientRect();
          W = Math.max(240, Math.round(rect.width));
          H = Math.max(220, Math.round(rect.height));
          dpr = Math.min(2, window.devicePixelRatio || 1);
          canvas.width = Math.round(W * dpr);
          canvas.height = Math.round(H * dpr);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };

        const project = (p) => {
          const cy = Math.cos(cam.yaw); const sy = Math.sin(cam.yaw);
          let x = p.x * cy - p.z * sy;
          let z = p.x * sy + p.z * cy;
          const cp = Math.cos(cam.pitch); const sp = Math.sin(cam.pitch);
          const y = p.y * cp - z * sp;
          z = p.y * sp + z * cp;
          const depth = z + 3.4;
          if (depth <= 0.25) return null;
          const scale = Math.min(W, H) * 0.52 * cam.zoom * (1.9 / depth);
          return { x: W / 2 + x * scale, y: H / 2 + y * scale, depth, scale };
        };

        const nearest = (mx, my) => {
          let best = null; let bestD = Infinity;
          for (const n of nodes) {
            const s = screen.get(n.id);
            if (!s) continue;
            const d = Math.hypot(s.x - mx, s.y - my);
            if (d < (s.hit || 10) && d < bestD) { best = n; bestD = d; }
          }
          return best;
        };

        const draw = (t) => {
          ctx.clearRect(0, 0, W, H);
          for (const s of bg) {
            const a = 0.12 + 0.16 * (0.5 + 0.5 * Math.sin(t / 1400 + s.p));
            ctx.fillStyle = `rgba(190,215,255,${a})`;
            ctx.fillRect(s.x * W, s.y * H, s.r, s.r);
          }
          const proj = new Map();
          for (const n of nodes) {
            const p = pos.get(n.id);
            const q = p ? project(p) : null;
            if (q) proj.set(n.id, q);
          }
          for (const e of edges) {
            const A = proj.get(e.a); const B = proj.get(e.b);
            if (!A || !B) continue;
            const linked = selectedId && (e.a === selectedId || e.b === selectedId);
            let alpha = (0.07 + 0.18 * (Number(e.w) || 0.5)) * Math.min(1, 2.6 / Math.max(0.6, (A.depth + B.depth) / 2));
            if (hovered && (e.a === hovered || e.b === hovered)) alpha += 0.22;
            if (selectedId) alpha = linked ? alpha + 0.32 : alpha * 0.3;
            ctx.strokeStyle = hexRgba(STAR_EDGE[e.kind] || '#94a3b8', Math.min(0.85, alpha));
            ctx.lineWidth = linked ? 1.7 : 0.7 + (Number(e.w) || 0.5) * 0.7;
            ctx.setLineDash(e.kind === 'related' ? [3, 5] : []);
            ctx.beginPath();
            ctx.moveTo(A.x, A.y);
            ctx.lineTo(B.x, B.y);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          screen.clear();
          const order = nodes.filter((n) => proj.has(n.id))
            .sort((a, b) => proj.get(b.id).depth - proj.get(a.id).depth);
          ctx.globalCompositeOperation = 'lighter';
          for (const n of order) {
            const q = proj.get(n.id);
            const meta = STAR_TYPE[n.type] || { color: '#94a3b8' };
            const strength = n.state === 'pinned' ? 1 : Math.max(0.12, Number(n.strength) || 0.7);
            let base = n.type === 'self' ? 9
              : n.type === 'owner' ? 7
                : n.type === 'arc' ? 6 + Math.min(5, n.episodeCount || 0)
                  : n.type === 'fact' ? 4.6 + (Number(n.confidence) || 0) * 2.4
                    : n.type === 'episode' ? 3.4 + (Number(n.importance) || 2) * 0.9
                      : n.type === 'trait' ? 3.6
                        : 3.8 + Math.min(8, Number(n.count) || 0) * 0.45;
            base *= Math.min(1.8, 2.7 / q.depth) * cam.zoom;
            const alpha = (0.3 + 0.7 * strength) * (n.private ? 0.55 : 1) * Math.min(1, 3.2 / q.depth);
            ctx.globalAlpha = Math.min(0.95, alpha);
            const sp = starSprite(meta.color);
            ctx.drawImage(sp, q.x - base * 2.2, q.y - base * 2.2, base * 4.4, base * 4.4);
            ctx.globalAlpha = Math.min(1, alpha + 0.28);
            ctx.fillStyle = meta.color;
            ctx.beginPath();
            ctx.arc(q.x, q.y, Math.max(1.1, base * 0.4), 0, Math.PI * 2);
            ctx.fill();
            if (n.state === 'pinned' || selectedId === n.id || hovered === n.id) {
              ctx.globalAlpha = selectedId === n.id ? 0.95 : 0.55;
              ctx.strokeStyle = meta.color;
              ctx.lineWidth = selectedId === n.id ? 1.6 : 1;
              ctx.beginPath();
              ctx.arc(q.x, q.y, base + 3, 0, Math.PI * 2);
              ctx.stroke();
            }
            screen.set(n.id, { ...q, hit: Math.max(11, base + 5) });
          }
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;

          const want = new Set(['self', 'owner']);
          if (selectedId) want.add(selectedId);
          if (hovered) want.add(hovered);
          for (const n of nodes) {
            if (n.type === 'arc' || n.type === 'topic') want.add(n.id);
            else if (cam.zoom > 1.2 && (Number(n.degree) || 0) >= 3) want.add(n.id);
          }
          const prio = (n) => (selectedId === n.id ? 0
            : hovered === n.id ? 1
              : n.type === 'self' ? 2
                : n.type === 'owner' ? 3
                  : n.type === 'arc' ? 4
                    : n.type === 'topic' ? 5 : 6);
          const labels = nodes.filter((n) => want.has(n.id) && proj.has(n.id))
            .sort((a, b) => prio(a) - prio(b) || String(a.id).localeCompare(String(b.id)));
          const placed = [];
          ctx.font = '11px ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
          ctx.textBaseline = 'middle';
          for (const n of labels) {
            const q = proj.get(n.id);
            const text = String(n.label || '');
            if (!text) continue;
            const w = ctx.measureText(text).width;
            const x = Math.min(W - w - 8, Math.max(6, q.x + 8));
            const y = Math.max(12, Math.min(H - 8, q.y - 10));
            const box = { x: x - 4, y: y - 9, w: w + 8, h: 18 };
            const hit = placed.some((b) => box.x < b.x + b.w + 4 && b.x < box.x + box.w + 4
              && box.y < b.y + b.h + 2 && b.y < box.y + box.h + 2);
            if (hit) continue;
            placed.push(box);
            ctx.fillStyle = 'rgba(2,6,23,.62)';
            ctx.fillRect(box.x, box.y, box.w, box.h);
            ctx.fillStyle = selectedId === n.id ? '#f8fafc' : 'rgba(226,232,240,.86)';
            ctx.fillText(text, x, y);
          }
        };

        let drawErrLogged = false;
        const tick = (t) => {
          try {
            if (t - last >= 32) { draw(t); last = t; }
          } catch (err) {
            if (!drawErrLogged) {
              drawErrLogged = true;
              console.error('[star] draw failed', err);
            }
          }
          raf = requestAnimationFrame(tick);
        };

        const onDown = (e) => {
          dragging = true; moved = 0;
          lx = e.clientX; ly = e.clientY;
          try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        };
        const onMove = (e) => {
          const rect = canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          if (dragging) {
            const dx = e.clientX - lx; const dy = e.clientY - ly;
            moved += Math.abs(dx) + Math.abs(dy);
            cam.yaw += dx * 0.006;
            cam.pitch = Math.max(-1.15, Math.min(1.15, cam.pitch + dy * 0.006));
            lx = e.clientX; ly = e.clientY;
            draw(performance.now());
          } else {
            const n = nearest(mx, my);
            hovered = n?.id || null;
            canvas.style.cursor = n ? 'pointer' : 'grab';
          }
        };
        const onUp = (e) => {
          dragging = false;
        };
        const onClick = (e) => {
          if (moved >= 5) return;
          const rect = canvas.getBoundingClientRect();
          const n = nearest(e.clientX - rect.left, e.clientY - rect.top);
          pickRef.current?.(n || null);
        };
        const onWheel = (e) => {
          e.preventDefault();
          cam.zoom = Math.max(0.45, Math.min(3.2, cam.zoom * Math.exp(-e.deltaY * 0.0012)));
          draw(performance.now());
        };
        const onDbl = () => { cam.yaw = 0.62; cam.pitch = 0.3; cam.zoom = 1; draw(performance.now()); };
        const onLeave = () => { hovered = null; };

        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('click', onClick);
        canvas.addEventListener('pointerleave', onLeave);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('dblclick', onDbl);
        const onResize = () => { fit(); draw(performance.now()); };
        const ro = new ResizeObserver(onResize);
        ro.observe(wrap);
        fit();
        draw(performance.now());
        raf = requestAnimationFrame(tick);
        engineRef.current = {
          setSelected: (id) => { selectedId = id || null; },
          reset: () => { cam.yaw = 0.62; cam.pitch = 0.3; cam.zoom = 1; },
        };
        return () => {
          cancelAnimationFrame(raf);
          ro.disconnect();
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('click', onClick);
          canvas.removeEventListener('pointerleave', onLeave);
          canvas.removeEventListener('wheel', onWheel);
          canvas.removeEventListener('dblclick', onDbl);
          engineRef.current = null;
        };
      }, [graph, layout]);

      useEffect(() => {
        engineRef.current?.setSelected(selected?.id || null);
      }, [selected]);

      useEffect(() => {
        setSelected(null);
        setEvidence(null);
      }, [graph]);

      useEffect(() => {
        if (!full) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') onToggleFull(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [full, onToggleFull]);

      const sel = selected;
      const meta = sel ? (STAR_TYPE[sel.type] || { label: '记忆', color: '#94a3b8' }) : null;
      const quotes = evidence?.evidence || [];
      return h('div', {
        'data-dy2-star': '', 'data-full': full ? '1' : '0', ref: wrapRef,
      },
      h('canvas', { ref: canvasRef }),
      h('div', { 'data-dy2-star-hud': '' },
        Object.entries(STAR_TYPE)
          .filter(([type]) => graph?.stats?.nodes?.[type])
          .map(([type, m]) => h('span', { 'data-dy2-star-legend': '', key: `lg:${type}` },
            h('span', { 'data-dy2-star-dot': '', style: { background: m.color } }), m.label)),
        h('span', {}, `${graph?.nodes?.length ?? 0} 星 · ${graph?.edges?.length ?? 0} 连线`),
        layout === 'time' ? h('span', {}, '时间：左早 → 右近') : null),
      full
        ? h('button', {
          'data-dy2-btn': '', 'data-dy2-star-exit': '', onClick: onToggleFull,
        }, '退出全屏')
        : null,
      sel
        ? h('div', { 'data-dy2-star-detail': '' },
          h('div', { 'data-dy2-row': '' },
            h('span', {
              'data-dy2-badge': '',
              style: { color: meta.color, borderColor: hexRgba(meta.color, 0.45) },
            }, meta.label),
            h('div', { 'data-dy2-grow': '' },
              h('div', { 'data-dy2-kv': '' }, sel.detail || sel.label),
              h('div', { 'data-dy2-sub': '' },
                (sel.sub || '')
                + (sel.strength != null && sel.state !== 'pinned'
                  ? ` · 强度 ${Math.round(sel.strength * 100)}%` : '')))),
          h('div', { 'data-dy2-row': '', style: { marginTop: '6px' } },
            h('button', {
              'data-dy2-btn': '', onClick: () => { setSelected(null); setEvidence(null); },
            }, '关闭')),
          evBusy ? h('div', { 'data-dy2-sub': '' }, '读原话…') : null,
          evidence?.error ? h('div', { 'data-dy2-sub': '' }, evidence.error) : null,
          quotes.length
            ? h('div', { 'data-dy2-quote-block': '' },
              quotes.slice(0, 6).map((ev, i) => h('div', { 'data-dy2-quote': '', key: `sq:${i}` },
                `「${ev.quote}」`,
                h('span', { 'data-dy2-sub': '' },
                  ` · ${ev.source === 'diary' ? '日记' : ev.source === 'dm' ? '私信' : (ev.source || '来源')}`
                  + (ev.at ? ` · ${fmtWhen(ev.at)}` : '')))))
            : (evidence && !evidence.error
              ? h('div', { 'data-dy2-sub': '' }, '这条没有引文') : null))
        : h('div', { 'data-dy2-star-hint': '' }, '拖动旋转 · 滚轮缩放 · 点击星星看详情'),
      );
    }

    /* ── 主面板 ─────────────────────────────────────────────────────── */
    function Panel() {
      const [data, setData] = useState(null);
      const [logLines, setLogLines] = useState(null);
      const [logSource, setLogSource] = useState('plugin');
      const [login, setLogin] = useState(null);
      const [busy, setBusy] = useState('');
      const [msg, setMsg] = useState('');
      const [nick, setNick] = useState('');
      const [interval, setIntervalMin] = useState(10);
      const [dailyMax, setDailyMax] = useState(60);
      const [enabled, setEnabled] = useState(true);
      const [winStart, setWinStart] = useState('00:00');
      const [winEnd, setWinEnd] = useState('24:00');
      const [memePct, setMemePct] = useState(30);
      const [memeMax, setMemeMax] = useState(6);
      const [shareEnabled, setShareEnabled] = useState(true);
      const [sharePct, setSharePct] = useState(8);
      const [shareMax, setShareMax] = useState(3);
      const [shareMin, setShareMin] = useState(120);
      const [shareLinkFallback, setShareLinkFallback] = useState(false);
      const [personaText, setPersonaText] = useState('');
      const [moodEnabled, setMoodEnabled] = useState(true);
      const [sleepStart, setSleepStart] = useState('23:30');
      const [sleepEnd, setSleepEnd] = useState('07:30');
      const [petEnabled, setPetEnabled] = useState(true);
      const [petSleep, setPetSleep] = useState(true);
      const [petMin, setPetMin] = useState(15);
      const [dutyVisible, setDutyVisible] = useState(false);
      const [mem, setMem] = useState(null);
      const [memQ, setMemQ] = useState('');
      const [memPrivate, setMemPrivate] = useState(false);
      const [memResults, setMemResults] = useState(null);
      const [memBusy, setMemBusy] = useState('');
      const [memDetail, setMemDetail] = useState(null);   // { id, episode } 展开的原话
      const [memSel, setMemSel] = useState([]);           // 待确认批量选择
      const [health, setHealth] = useState(null);         // 记忆体检
      const [starGraph, setStarGraph] = useState(null);   // 记忆星图
      const [starPrivate, setStarPrivate] = useState(false);
      const [starLayout, setStarLayout] = useState('force'); // force | time
      const [starFull, setStarFull] = useState(false);
      const [starBusy, setStarBusy] = useState('');
      // 内容队列默认只展开最近几条；「展开全部」按钮切完整列表
      const [queueOpen, setQueueOpen] = useState(false);

      const load = useCallback(async () => {
        setBusy('load');
        try {
          const [s, q, c, l, m, hl, sg] = await Promise.all([
            jget('/status'), jget('/queue'), jget('/config'), jget('/login/status'),
            jget('/memory/overview').catch(() => null),
            jget('/memory/health').catch(() => null),
            jget('/memory/graph').catch(() => null),
          ]);
          setData(s);
          setLogin(l);
          setMem(m);
          setHealth(hl);
          setStarGraph(sg);
          setNick(s.owner || '');
          setIntervalMin(s.watch?.intervalMinutes ?? 10);
          setDailyMax(s.watch?.dailyMax ?? 60);
          setEnabled(s.watch?.enabled !== false);
          const w = (s.watch?.windows ?? [])[0] ?? {};
          setWinStart(w.start ?? '00:00');
          setWinEnd(w.end ?? '24:00');
          setMemePct(Math.round((s.meme?.probability ?? 0.3) * 100));
          setMemeMax(s.meme?.maxPerDay ?? 6);
          setShareEnabled(s.proactiveShare?.enabled !== false);
          setSharePct(Math.round((s.proactiveShare?.probability ?? 0.08) * 100));
          setShareMax(s.proactiveShare?.maxPerDay ?? 3);
          setShareMin(s.proactiveShare?.minIntervalMinutes ?? 120);
          setShareLinkFallback(s.proactiveShare?.linkFallback === true);
          const cc = c.config || {};
          setPersonaText(cc.persona?.text ?? '');
          setMoodEnabled(cc.mood?.enabled !== false);
          const mw = (cc.mood?.sleepWindows ?? [])[0] ?? {};
          setSleepStart(mw.start ?? '23:30');
          setSleepEnd(mw.end ?? '07:30');
          setPetEnabled(cc.pet?.enabled !== false);
          setPetSleep(cc.pet?.sleepEnabled !== false);
          setPetMin(cc.pet?.minIntervalMinutes ?? 15);
          setDutyVisible(cc.duty?.sessionVisible === true);
          setMsg('');
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const loadLogin = useCallback(async () => {
        try {
          setLogin(await jget('/login/status'));
        } catch (e) {
          setMsg(String(e?.message ?? e));
        }
      }, []);

      const loginAct = useCallback(async (action) => {
        setBusy('login');
        try {
          await jpost(`/login/${action}`);
          setLogin(await jget('/login/status'));
          setMsg('已发起扫码 —— 打开上面的 PNG 图片用手机扫；出现滑块只能人工处理');
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      }, []);

      const loadLog = useCallback(async (source) => {
        const src = source || logSource;
        setBusy('log');
        try {
          const j = await jget(`/log?n=80&source=${src}`);
          setLogLines(j.lines ?? []);
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      }, [logSource]);

      const saveConfig = useCallback(async () => {
        setBusy('save');
        try {
          const j = await jpost('/config', {
            owner: { nickname: nick },
            watch: {
              enabled,
              intervalMinutes: interval,
              dailyMax,
              windows: [{ start: winStart, end: winEnd }],
            },
            meme: { probability: memePct / 100, maxPerDay: memeMax },
            proactiveShare: {
              enabled: shareEnabled,
              probability: sharePct / 100,
              maxPerDay: shareMax,
              minIntervalMinutes: shareMin,
              linkFallback: shareLinkFallback,
            },
            persona: { text: personaText },
            mood: {
              enabled: moodEnabled,
              sleepWindows: [{ start: sleepStart, end: sleepEnd }],
            },
            pet: {
              enabled: petEnabled,
              sleepEnabled: petSleep,
              minIntervalMinutes: petMin,
            },
            duty: { sessionVisible: dutyVisible },
          });
          if (j.ok) setMsg('配置已保存（下个 tick 生效）');
          else setMsg(j.error || '保存失败');
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      }, [nick, enabled, interval, dailyMax, winStart, winEnd, memePct, memeMax,
        shareEnabled, sharePct, shareMax, shareMin, shareLinkFallback, personaText,
        moodEnabled, sleepStart, sleepEnd, petEnabled, petSleep, petMin, dutyVisible]);

      const schedulerAct = useCallback(async (action) => {
        setBusy(action);
        try {
          const j = await jpost(`/scheduler/${action}`);
          setMsg(j.note || j.output || (j.ok ? '已执行' : (j.error || '失败')));
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setBusy('');
          setTimeout(() => { load(); }, 3000);
        }
      }, [load]);

      const dutyTest = useCallback(async () => {
        setBusy('duty');
        try {
          const j = await jpost('/duty/selftest');
          setMsg(j.ok ? '值班会话已就绪（get/resume/create 通过）' : (j.error || '值班会话自检失败'));
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      }, []);

      const poke = useCallback(async () => {
        setBusy('poke');
        try {
          const j = await jpost('/mood/poke');
          if (j.ok) {
            setData((d) => (d ? { ...d, mood: j.mood } : d));
            setMsg('摸了一下');
          } else setMsg(j.error || '摸摸头失败');
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      }, []);

      const refreshMood = useCallback(async () => {
        try {
          setData(await jget('/status'));
        } catch (e) {
          setMsg(String(e?.message ?? e));
        }
      }, []);

      const loadHealth = useCallback(async () => {
        try { setHealth(await jget('/memory/health')); } catch { /* 体检失败不挡面板 */ }
      }, []);

      const loadMemory = useCallback(async () => {
        try {
          setMem(await jget('/memory/overview'));
          await loadHealth();
        } catch (e) {
          setMsg(String(e?.message ?? e));
        }
      }, [loadHealth]);

      const loadStar = useCallback(async (priv = false) => {
        setStarBusy('load');
        try {
          setStarGraph(await jget(`/memory/graph?private=${priv ? 1 : 0}`));
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setStarBusy('');
        }
      }, []);

      const toggleStarPrivate = useCallback(() => {
        const next = !starPrivate;
        setStarPrivate(next);
        loadStar(next);
      }, [starPrivate, loadStar]);

      const reindexMemory = useCallback(async () => {
        setMemBusy('reindex');
        try {
          const j = await jpost('/memory/reindex', {});
          if (!j.ok) setMsg(j.error || '重建失败');
          else setMsg(`索引已重建（${j.episodes} 条情节 / ${j.terms} 词）`);
          await loadHealth();
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setMemBusy('');
        }
      }, [loadHealth]);

      const searchMem = useCallback(async () => {
        setMemBusy('search');
        try {
          const j = await jget(`/memory/search?q=${encodeURIComponent(memQ)}&private=${memPrivate ? 1 : 0}`);
          setMemResults(j);
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setMemBusy('');
        }
      }, [memQ, memPrivate]);

      const refreshMemory = useCallback(async () => {
        await loadMemory();
        if (memResults) await searchMem();
        await loadStar(starPrivate);
      }, [loadMemory, searchMem, memResults, loadStar, starPrivate]);

      const pinFact = useCallback(async (id, pinned) => {
        setMemBusy('pin');
        try {
          const j = await jpost('/memory/pin', { id, pinned });
          if (!j.ok) setMsg(j.error || '置顶失败');
          await refreshMemory();
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setMemBusy('');
        }
      }, [refreshMemory]);

      const deleteMem = useCallback(async (id) => {
        const okDel = typeof window === 'undefined'
          || window.confirm('只删除这条记忆摘要，原始私信/日记不会动。确定？');
        if (!okDel) return;
        setMemBusy('del');
        try {
          const j = await jdel(`/memory/item?id=${encodeURIComponent(id)}`);
          if (!j.ok) setMsg(j.error || '删除失败');
          await refreshMemory();
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setMemBusy('');
        }
      }, [refreshMemory]);

      const pendingAct = useCallback(async (id, action) => {
        setMemBusy('pending');
        try {
          const j = await jpost('/memory/pending', { id, action });
          if (!j.ok) setMsg(j.error || '操作失败');
          await refreshMemory();
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setMemBusy('');
        }
      }, [refreshMemory]);

      const pendingBatch = useCallback(async (action) => {
        const ids = memSel;
        if (!ids.length) return;
        if (action === 'dismiss' && typeof window !== 'undefined'
          && !window.confirm(`忽略 ${ids.length} 条待确认事实？`)) return;
        setMemBusy('pending');
        try {
          const j = await jpost('/memory/pending/batch', { ids, action });
          if (!j.ok) setMsg(j.error || '批量操作失败');
          else if ((j.missing ?? []).length) {
            setMsg(`${(j.resolved ?? []).length} 条已处理，${j.missing.length} 条已不存在`);
          }
          setMemSel([]);
          await refreshMemory();
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setMemBusy('');
        }
      }, [memSel, refreshMemory]);

      const toggleMemSel = (id) => setMemSel((cur) => (cur.includes(id)
        ? cur.filter((x) => x !== id) : [...cur, id]));

      const toggleAllMemSel = (ids) => setMemSel((cur) => (ids.every((id) => cur.includes(id))
        ? cur.filter((id) => !ids.includes(id))
        : [...new Set([...cur, ...ids])]));

      /** 情节「看原话」：再点一次收起；私人情节要勾选「含私人日记」才给 */
      const toggleEpisodeDetail = useCallback(async (id) => {
        if (memDetail?.id === id) { setMemDetail(null); return; }
        setMemBusy('detail');
        try {
          const j = await jget(`/memory/episode?id=${encodeURIComponent(id)}&private=${memPrivate ? 1 : 0}`);
          if (!j.ok) {
            setMsg(j.private ? '私人情节：先勾选「含私人日记」再看原话' : (j.error || '读取原话失败'));
            setMemDetail(null);
            return;
          }
          setMemDetail({ id, episode: j.episode });
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setMemBusy('');
        }
      }, [memDetail, memPrivate]);

      const running = data?.daemon?.running === true;
      const gate = data?.gate ?? {};
      const queue = data?.queue ?? {};
      // 内容队列收起时只展示最近 5 条；按钮切完整列表（queueOpen）
      const queueItems = queue.items ?? [];
      const queueShown = (queueOpen ? queueItems : queueItems.slice(-5))
        .slice().reverse();                    // 旧→新 存，渲染成 新→旧
      const mood = data?.mood ?? null;
      const moodBar = (label, value, color) => h('div', { 'data-dy2-moodrow': '' },
        h('span', { 'data-dy2-moodk': '' }, label),
        h('div', { 'data-dy2-track': '' },
          h('div', {
            'data-dy2-fill': '',
            style: {
              width: `${Math.max(0, Math.min(100, Number(value) || 0))}%`,
              background: color,
            },
          })),
        h('span', { 'data-dy2-moodv': '' }, Math.round(Number(value) || 0)));

      const memLocked = Boolean(busy) || Boolean(memBusy);
      const factRow = (f) => h('div', { 'data-dy2-item': '', key: `f:${f.id}` },
        h('span', { 'data-dy2-badge': f.private ? 'data-warn' : 'data-ok' },
          f.private ? '私人' : '事实'),
        h('div', { 'data-dy2-grow': '' },
          h('div', { 'data-dy2-kv': '' }, f.text),
          h('div', { 'data-dy2-sub': '' },
            `${f.category || 'fact'} · 置信 ${Math.round((Number(f.confidence) || 0) * 100)}%`
            + (f.pinned ? ' · 已置顶' : '')
            + (f.source === 'config' ? ' · 来自配置' : ''))),
        h('button', {
          'data-dy2-btn': '', disabled: memLocked,
          onClick: () => pinFact(f.id, !f.pinned),
        }, f.pinned ? '取消置顶' : '置顶'),
        h('button', {
          'data-dy2-btn': '', 'data-danger': '', disabled: memLocked,
          onClick: () => deleteMem(f.id),
        }, '删除'));

      const episodeRow = (e) => {
        const open = memDetail?.id === e.id;
        const evidence = memDetail?.episode?.evidence ?? [];
        return h('div', { 'data-dy2-item': '', key: `e:${e.id}` },
          h('span', { 'data-dy2-badge': e.private ? 'data-warn' : 'data-ok' },
            e.private ? '私人' : '情节'),
          h('div', { 'data-dy2-grow': '' },
            h('div', { 'data-dy2-kv': '' }, e.summary),
            h('div', { 'data-dy2-sub': '' },
              `${fmtWhen(e.ts)} · 重要度 ${e.importance}`
              + ((e.tags ?? []).length ? ` · ${e.tags.join('/')}` : '')),
            open
              ? h('div', { 'data-dy2-quote-block': '' },
                evidence.length
                  ? evidence.map((ev, i) => h('div', { 'data-dy2-quote': '', key: `q:${e.id}:${i}` },
                    `「${ev.quote}」`,
                    h('span', { 'data-dy2-sub': '' },
                      ` · ${ev.source === 'diary' ? '日记' : ev.source === 'dm' ? '私信' : (ev.source || '来源')}`
                      + (ev.at ? ` · ${fmtWhen(ev.at)}` : ''))))
                  : h('div', { 'data-dy2-sub': '' }, '这条没有引文（固化生成的情节可能只有摘要）'))
              : null),
          h('button', {
            'data-dy2-btn': '', disabled: memLocked && !open,
            onClick: () => toggleEpisodeDetail(e.id),
          }, open ? '收起原话' : '看原话'),
          h('button', {
            'data-dy2-btn': '', 'data-danger': '', disabled: memLocked,
            onClick: () => deleteMem(e.id),
          }, '删除'));
      };

      const pendingRow = (p) => h('div', { 'data-dy2-item': 'pending', key: `p:${p.id}` },
        h('input', {
          type: 'checkbox',
          checked: memSel.includes(p.id),
          disabled: memLocked,
          title: '选中后可批量采纳/忽略',
          onChange: () => toggleMemSel(p.id),
        }),
        h('span', { 'data-dy2-badge': 'data-warn' }, '待确认'),
        h('div', { 'data-dy2-grow': '' },
          h('div', { 'data-dy2-kv': '' }, p.text),
          h('div', { 'data-dy2-sub': '' },
            `置信 ${Math.round((Number(p.confidence) || 0) * 100)}% · 采纳后进主人档案`)),
        h('button', {
          'data-dy2-btn': '', disabled: memLocked,
          onClick: () => pendingAct(p.id, 'accept'),
        }, '采纳'),
        h('button', {
          'data-dy2-btn': '', disabled: memLocked,
          onClick: () => pendingAct(p.id, 'dismiss'),
        }, '忽略'));

      const arcRow = (a) => h('div', { 'data-dy2-item': '', key: `a:${a.id}` },
        h('span', { 'data-dy2-badge': a.private ? 'data-warn' : 'data-ok' },
          a.private ? '私人叙事' : '叙事'),
        h('div', { 'data-dy2-grow': '' },
          h('div', { 'data-dy2-kv': '' }, a.title),
          h('div', { 'data-dy2-sub': '' },
            `${a.period} · ${a.summary}`
            + (a.episodeCount ? ` · 引用 ${a.episodeCount} 条` : ''))));

      const clip = (t, n) => {
        const s = String(t ?? '').replace(/\s+/g, ' ').trim();
        return s.length > n ? `${s.slice(0, n)}…` : s;
      };
      const healthRow = (it) => {
        const n = Number(it.count) || 0;
        const sample = Array.isArray(it.sample) ? it.sample : [];
        let more = '';
        if (it.key === 'staleFacts') {
          more = sample.map((x) => `${clip(x.text, 40)}（${x.days} 天）`).join('；');
        } else if (it.key === 'duplicateFacts') {
          more = sample.map((x) => `${clip(x.a?.text, 24)} ≈ ${clip(x.b?.text, 24)}`).join('；');
        } else if (it.key === 'episodesNoEvidence') {
          more = sample.map((x) => clip(x.summary, 40)).join('；');
        } else if (it.key === 'arcBrokenRefs') {
          more = sample.map((x) => `${clip(x.title, 20)}（缺 ${x.missing}）`).join('；');
        } else {
          more = it.detail || (it.key === 'indexStale' && n ? '索引与情节数/时间对不上，点下面重建' : '');
        }
        return h('div', { 'data-dy2-item': n > 0 ? 'failed' : 'done', key: `h:${it.key}` },
          h('span', { 'data-dy2-badge': n > 0 ? 'data-warn' : 'data-ok' },
            n > 0 ? `${n} 处` : '✓'),
          h('div', { 'data-dy2-grow': '' },
            h('div', { 'data-dy2-kv': '' }, it.label),
            more ? h('div', { 'data-dy2-sub': '' }, more) : null));
      };

      const memRows = () => {
        const r = memResults || mem;
        if (!r) return h('div', { 'data-dy2-empty': '' }, '还没有记忆数据');
        const facts = r.facts ?? [];
        const eps = r.episodes ?? [];
        if (!facts.length && !eps.length) {
          return h('div', { 'data-dy2-empty': '' },
            memResults ? '没有匹配的记忆' : '还没有记忆 —— 聊几天之后固化流程会开始积累');
        }
        return h('div', { 'data-dy2-memlist': '' },
          ...facts.map(factRow), ...eps.map(episodeRow));
      };

      return h('div', { 'data-dy2-page': '' },

        /* ── 状态 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' },
            '运行状态',
            h('span', { 'data-dy2-badge': running ? 'data-ok' : 'data-warn' },
              running ? `运行中 · PID ${data?.daemon?.pid}` : '未运行'),
            h('span', { 'data-dy2-sub': '' }, `v1.17.0·b${PANEL_BUILD}`)),
          data
            ? h('div', { 'data-dy2-stats': '' },
                h('div', { 'data-dy2-stat': '' },
                  h('span', { 'data-dy2-k': '' }, '主人'),
                  h('span', { 'data-dy2-v': '' }, data.owner || '（未配置）')),
                h('div', { 'data-dy2-stat': '' },
                  h('span', { 'data-dy2-k': '' }, '今天'),
                  h('span', { 'data-dy2-v': '' }, `已回复 ${data.today?.watches ?? 0} 条 · 表情 ${data.today?.memes ?? 0}`)),
                h('div', { 'data-dy2-stat': '' },
                  h('span', { 'data-dy2-k': '' }, '队列'),
                  h('span', { 'data-dy2-v': '' }, `共 ${queue.total ?? 0} 条 · 待回复 ${queue.pending ?? 0}`)),
                h('div', { 'data-dy2-stat': '' },
                  h('span', { 'data-dy2-k': '' }, '发送闸'),
                  h('span', { 'data-dy2-v': '' }, gate.cooldown_remaining_s > 0
                    ? `冷却中 · ${gate.cooldown_remaining_s}s`
                    : `正常 · ≥${gate.min_interval_s ?? 30}s`)),
                h('div', { 'data-dy2-stat': '' },
                  h('span', { 'data-dy2-k': '' }, '值班大脑'),
                  h('span', { 'data-dy2-v': '' }, !data.duty_enabled ? '未启用'
                    : data.duty?.sessionId
                      ? `e${data.duty.epoch ?? 1} · ${data.duty.contextWindow
                        ? `${Math.round((Number(data.duty.ratio) || 0) * 100)}%`
                        : '就绪'}`
                      : '已启用')),
                h('div', { 'data-dy2-stat': '' },
                  h('span', { 'data-dy2-k': '' }, '记忆'),
                  h('span', { 'data-dy2-v': '' },
                    data.memory?.layers?.episodes
                      ? `${data.memory.layers.episodes} 情节 · ${data.memory.layers.profile} 事实`
                      : data.memory?.files
                        ? `${data.memory.files} 份 · ${Math.round(data.memory.bytes / 1024)} KB`
                        : '还没有')))
            : h('div', { 'data-dy2-empty': '' }, busy === 'load' ? '加载中…' : '没有数据'),
          gate.cooldown_remaining_s > 0 || (data?.today?.loginFails ?? 0) > 0
            ? h('div', { 'data-dy2-row': '' },
                gate.cooldown_remaining_s > 0
                  ? h('span', { 'data-dy2-badge': 'data-err' }, gate.blocked_reason || '风控冷却')
                  : null,
                (data?.today?.loginFails ?? 0) > 0
                  ? h('span', { 'data-dy2-badge': 'data-err' }, `登录失效 ×${data.today.loginFails}`)
                  : null)
            : null,
          h('div', { 'data-dy2-row': '' },
            h('button', { 'data-dy2-btn': '', disabled: Boolean(busy), onClick: load }, '刷新'),
            h('button', { 'data-dy2-btn': '', disabled: Boolean(busy), onClick: dutyTest }, '测试值班会话'),
            running
              ? h('button', {
                'data-dy2-btn': '', 'data-danger': '', disabled: Boolean(busy),
                onClick: () => schedulerAct('stop'),
              }, '停止调度器')
              : h('button', {
                'data-dy2-btn': '', 'data-primary': '',
                disabled: Boolean(busy) || data?.zcode_available === false
                  || data?.duty_enabled === true,
                onClick: () => schedulerAct('start'),
              }, '启动本地调度器')),
          data?.duty_enabled === true
            ? h('div', { 'data-dy2-sub': '' },
              '值班大脑已启用：独立调度器与它共用状态文件，二选一，别同时开。')
            : data?.zcode_available === false
              ? h('div', { 'data-dy2-sub': '' },
                '没找到 ZCode CLI：独立调度器需要本地 ZCode；当前 DSH 插件模式由值班大脑接管，不需要它。')
              : null),

        /* ── 现在 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' },
            '现在',
            mood?.enabled === false
              ? h('span', { 'data-dy2-badge': 'data-warn' }, '心情关闭')
              : h('span', {
                'data-dy2-badge': mood?.sleeping ? 'data-warn' : 'data-ok',
              }, mood?.label || '—'),
            h('span', { 'data-dy2-sub': '' }, data?.pet?.online ? '桌宠在线' : '桌宠离线')),
          mood
            ? h('div', { 'data-dy2-moodbars': '' },
              moodBar('精力', mood.energy, '#22c55e'),
              moodBar('想念', mood.social, '#ec4899'),
              moodBar('无聊', mood.boredom, '#f59e0b'))
            : h('div', { 'data-dy2-empty': '' }, '还没有状态数据'),
          h('div', { 'data-dy2-row': '' },
            h('button', {
              'data-dy2-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: poke,
            }, '摸摸头'),
            h('button', {
              'data-dy2-btn': '', disabled: Boolean(busy), onClick: refreshMood,
            }, '刷新')),
          h('div', { 'data-dy2-sub': '' },
            `上次互动 ${fmtWhen(mood?.lastInteractionAt)} · 状态更新 ${mood?.updatedAt ? fmtWhen(mood.updatedAt) : '—'}`)),

        /* ── 运行参数 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '运行参数',
            h('span', { 'data-dy2-sub': '' }, '控制什么时候看私信、看多少')),
          h('div', { 'data-dy2-form': '' },
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('div', { 'data-dy2-label': '' }, '主人昵称'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', value: nick,
                  onChange: (e) => setNick(e.target.value),
                  placeholder: '例如：漱月鸣筝',
                })),
              h('div', { 'data-dy2-hint': '' }, '必须和抖音上的昵称完全一致；回复会发给这个人。')),
            h('div', { 'data-dy2-field': '', 'data-wide': '', 'data-grouphead': '' },
              h('div', { 'data-dy2-grouplabel': '' }, '互动频率 —— 回复主人多勤快')),
            h('div', { 'data-dy2-field': '' },
              h('div', { 'data-dy2-label': '' }, '检查间隔'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', type: 'number', min: 1, max: 240,
                  value: interval, onChange: (e) => setIntervalMin(Number(e.target.value) || 10),
                }),
                h('span', { 'data-dy2-unit': '' }, '分钟')),
              h('div', { 'data-dy2-hint': '' }, '1–240；每隔这么久检查一次私信。')),
            h('div', { 'data-dy2-field': '' },
              h('div', { 'data-dy2-label': '' }, '每日上限'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', type: 'number', min: 1, max: 200,
                  value: dailyMax, onChange: (e) => setDailyMax(Number(e.target.value) || 60),
                }),
                h('span', { 'data-dy2-unit': '' }, '条 / 天')),
              h('div', { 'data-dy2-hint': '' }, '1–200；超过后当天不再回复。')),
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('div', { 'data-dy2-label': '' }, '观看时段'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', value: winStart,
                  onChange: (e) => setWinStart(e.target.value),
                }),
                h('span', { 'data-dy2-unit': '' }, '—'),
                h('input', {
                  'data-dy2-input': '', value: winEnd,
                  onChange: (e) => setWinEnd(e.target.value),
                })),
              h('div', { 'data-dy2-hint': '' }, 'HH:MM；只在此时段内检查，结束填 24:00 表示全天。')),
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('label', { 'data-dy2-switch': '' },
                h('input', {
                  type: 'checkbox', checked: enabled,
                  onChange: (e) => setEnabled(e.target.checked),
                }),
                h('div', null,
                  h('div', { 'data-dy2-label': '' }, '自动观看'),
                  h('div', { 'data-dy2-hint': '' },
                    '关闭后不检查私信、不消耗 token，只保留面板和工具。')))),
            h('div', { 'data-dy2-field': '', 'data-wide': '', 'data-grouphead': '' },
              h('div', { 'data-dy2-grouplabel': '' }, '表情包回复 —— 回敬贴图的强度')),
            h('div', { 'data-dy2-field': '' },
              h('div', { 'data-dy2-label': '' }, '表情包概率'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', type: 'number', min: 0, max: 100,
                  value: memePct, onChange: (e) => setMemePct(Number(e.target.value) || 0),
                }),
                h('span', { 'data-dy2-unit': '' }, '%')),
              h('div', { 'data-dy2-hint': '' }, '0–100；回复时允许带图的比例，0 = 不配图。')),
            h('div', { 'data-dy2-field': '' },
              h('div', { 'data-dy2-label': '' }, '表情每日上限'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', type: 'number', min: 0, max: 30,
                  value: memeMax, onChange: (e) => setMemeMax(Number(e.target.value) || 0),
                }),
                h('span', { 'data-dy2-unit': '' }, '张 / 天')),
              h('div', { 'data-dy2-hint': '' }, '0–30；防刷屏，收表情包回敬不受此限。')),
            h('div', { 'data-dy2-field': '', 'data-wide': '', 'data-grouphead': '' },
              h('div', { 'data-dy2-grouplabel': '' }, '主动分享 —— 没有私信时刷视频给主人的强度')),
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('label', { 'data-dy2-switch': '' },
                h('input', {
                  type: 'checkbox', checked: shareEnabled,
                  onChange: (e) => setShareEnabled(e.target.checked),
                }),
                h('div', null,
                  h('div', { 'data-dy2-label': '' }, '开启主动分享'),
                  h('div', { 'data-dy2-hint': '' },
                    '关闭后只在主人发内容时回复，不主动刷视频、不消耗 token。')))),
            h('div', { 'data-dy2-field': '' },
              h('div', { 'data-dy2-label': '' }, '分享概率'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', type: 'number', min: 0, max: 100,
                  value: sharePct, onChange: (e) => setSharePct(Number(e.target.value) || 0),
                }),
                h('span', { 'data-dy2-unit': '' }, '%')),
              h('div', { 'data-dy2-hint': '' }, '0–100；每次空闲按此概率刷一条，0 = 不刷。')),
            h('div', { 'data-dy2-field': '' },
              h('div', { 'data-dy2-label': '' }, '分享每日上限'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', type: 'number', min: 0, max: 20,
                  value: shareMax, onChange: (e) => setShareMax(Number(e.target.value) || 0),
                }),
                h('span', { 'data-dy2-unit': '' }, '条 / 天')),
              h('div', { 'data-dy2-hint': '' }, '0–20；防刷屏，一张原生卡片算一条。')),
            h('div', { 'data-dy2-field': '' },
              h('div', { 'data-dy2-label': '' }, '分享最小间隔'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', type: 'number', min: 5, max: 1440,
                  value: shareMin, onChange: (e) => setShareMin(Number(e.target.value) || 120),
                }),
                h('span', { 'data-dy2-unit': '' }, '分钟')),
              h('div', { 'data-dy2-hint': '' }, '5–1440；两次尝试至少隔这么久，压住 token 消耗。')),
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('label', { 'data-dy2-switch': '' },
                h('input', {
                  type: 'checkbox', checked: shareLinkFallback,
                  onChange: (e) => setShareLinkFallback(e.target.checked),
                }),
                h('div', null,
                  h('div', { 'data-dy2-label': '' }, '分享面板没目标时发链接'),
                  h('div', { 'data-dy2-hint': '' },
                    '抖音分享面板只列最近分享过的人；开启后目标不在面板时会退化成'
                    + '一条带视频链接的文字私信。默认关（宁可不发）。')))),
            h('div', { 'data-dy2-field': '', 'data-wide': '', 'data-grouphead': '' },
              h('div', { 'data-dy2-grouplabel': '' }, '值班会话 —— 侧栏显隐')),
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('label', { 'data-dy2-switch': '' },
                h('input', {
                  type: 'checkbox', checked: dutyVisible,
                  onChange: (e) => setDutyVisible(e.target.checked),
                }),
                h('div', null,
                  h('div', { 'data-dy2-label': '' }, '值班会话在侧栏可见'),
                  h('div', { 'data-dy2-hint': '' },
                    '默认关闭：值班会话不占侧栏对话框，每次轮换也不会多出新框。'
                    + '改完保存，下次轮换/重启拉起的新会话按新设置走，当前会话不变。')))),
            h('div', { 'data-dy2-field': '', 'data-wide': '', 'data-grouphead': '' },
              h('div', { 'data-dy2-grouplabel': '' }, '状态与桌宠 —— 心情、作息、桌面反馈')),
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('label', { 'data-dy2-switch': '' },
                h('input', {
                  type: 'checkbox', checked: moodEnabled,
                  onChange: (e) => setMoodEnabled(e.target.checked),
                }),
                h('div', null,
                  h('div', { 'data-dy2-label': '' }, '心情系统'),
                  h('div', { 'data-dy2-hint': '' },
                    '开启后语气、主动分享节奏和作息都跟着状态走；关闭只停行为，不改历史值。')))),
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('div', { 'data-dy2-label': '' }, '睡觉时段'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', value: sleepStart,
                  onChange: (e) => setSleepStart(e.target.value),
                }),
                h('span', { 'data-dy2-unit': '' }, '—'),
                h('input', {
                  'data-dy2-input': '', value: sleepEnd,
                  onChange: (e) => setSleepEnd(e.target.value),
                })),
              h('div', { 'data-dy2-hint': '' },
                'HH:MM；跨午夜就填 23:30 — 07:30。这期间精力恢复、不主动分享，主人来消息照回。')),
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('label', { 'data-dy2-switch': '' },
                h('input', {
                  type: 'checkbox', checked: petEnabled,
                  onChange: (e) => setPetEnabled(e.target.checked),
                }),
                h('div', null,
                  h('div', { 'data-dy2-label': '' }, '桌宠播报'),
                  h('div', { 'data-dy2-hint': '' },
                    '回完私信/分享视频时在桌面上冒个短气泡；桌宠没开就自动跳过。')))),
            h('div', { 'data-dy2-field': '', 'data-wide': '' },
              h('label', { 'data-dy2-switch': '' },
                h('input', {
                  type: 'checkbox', checked: petSleep,
                  onChange: (e) => setPetSleep(e.target.checked),
                }),
                h('div', null,
                  h('div', { 'data-dy2-label': '' }, '自动睡觉'),
                  h('div', { 'data-dy2-hint': '' },
                    '到睡觉时段让桌宠睡、早上叫醒；关闭只是不联动桌宠。')))),
            h('div', { 'data-dy2-field': '' },
              h('div', { 'data-dy2-label': '' }, '播报最小间隔'),
              h('div', { 'data-dy2-control': '' },
                h('input', {
                  'data-dy2-input': '', type: 'number', min: 5, max: 1440,
                  value: petMin, onChange: (e) => setPetMin(Number(e.target.value) || 15),
                }),
                h('span', { 'data-dy2-unit': '' }, '分钟')),
              h('div', { 'data-dy2-hint': '' }, '5–1440；普通气泡至少隔这么久，摸摸头不受限。'))),
          h('div', { 'data-dy2-actions': '' },
            h('button', {
              'data-dy2-btn': '', 'data-primary': '', disabled: Boolean(busy),
              onClick: saveConfig,
            }, '保存设置'))),

        /* ── 人设 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '人设',
            h('span', { 'data-dy2-sub': '' }, '拼进每轮任务提示词，改完下一轮生效')),
          h('textarea', {
            'data-dy2-input': '', 'data-dy2-textarea': '',
            maxLength: 800,
            value: personaText,
            onChange: (e) => setPersonaText(e.target.value),
            placeholder: '性格、喜欢/不喜欢、说话习惯……',
          }),
          h('div', { 'data-dy2-hint': '' },
            `${personaText.length}/800 字；留空就只用内置提示词。`),
          h('div', { 'data-dy2-actions': '' },
            h('button', {
              'data-dy2-btn': '', 'data-primary': '', disabled: Boolean(busy),
              onClick: saveConfig,
            }, '保存人设'))),

        /* ── 记忆 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '记忆',
            mem
              ? h('span', {
                'data-dy2-badge': mem.stats?.episodes ? 'data-ok' : 'data-warn',
              }, `${mem.stats?.episodes ?? 0} 情节 · ${mem.stats?.profile ?? 0} 事实`)
              : null,
            (mem?.pending ?? []).length
              ? h('span', { 'data-dy2-badge': 'data-warn' }, `待确认 ${mem.pending.length}`)
              : null,
            h('span', { 'data-dy2-sub': '' }, '本地四层记忆；私人条目默认不进提示词')),
          mem
            ? h('div', { 'data-dy2-sub': '' },
              `索引 ${mem.stats?.terms ?? 0} 词 · 最后固化 ${fmtWhen(mem.stats?.lastConsolidatedAt)}`
              + ` · 叙事 ${mem.stats?.arcs ?? 0} 条`
              + ` · ${Math.round((mem.stats?.bytes ?? 0) / 1024)} KB`)
            : h('div', { 'data-dy2-empty': '' }, '还没有记忆数据'),
          h('div', { 'data-dy2-search': '' },
            h('input', {
              'data-dy2-input': '', value: memQ,
              placeholder: '搜一条回忆，例如：加班 / 火锅 / 团子',
              onChange: (e) => setMemQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') searchMem(); },
            }),
            h('label', { 'data-dy2-switch': '' },
              h('input', {
                type: 'checkbox', checked: memPrivate,
                onChange: (e) => setMemPrivate(e.target.checked),
              }),
              h('span', { 'data-dy2-sub': '' }, '含私人日记')),
            h('button', {
              'data-dy2-btn': '', disabled: memLocked, onClick: searchMem,
            }, '搜索'),
            memResults
              ? h('button', {
                'data-dy2-btn': '', disabled: memLocked,
                onClick: () => { setMemResults(null); setMemDetail(null); },
              }, '清空')
              : null),
          !memResults && (mem?.pending ?? []).length
            ? h('div', null,
              h('div', { 'data-dy2-label': '' }, `待确认（${mem.pending.length}）`),
              h('div', { 'data-dy2-row': '', style: { marginBottom: '6px' } },
                h('button', {
                  'data-dy2-btn': '', disabled: memLocked,
                  onClick: () => toggleAllMemSel(mem.pending.map((p) => p.id)),
                }, memSel.length && mem.pending.every((p) => memSel.includes(p.id))
                  ? '取消全选' : '全选'),
                h('button', {
                  'data-dy2-btn': '', 'data-primary': '', disabled: memLocked || !memSel.length,
                  onClick: () => pendingBatch('accept'),
                }, `采纳所选${memSel.length ? `(${memSel.length})` : ''}`),
                h('button', {
                  'data-dy2-btn': '', 'data-danger': '', disabled: memLocked || !memSel.length,
                  onClick: () => pendingBatch('dismiss'),
                }, `忽略所选${memSel.length ? `(${memSel.length})` : ''}`)),
              h('div', { 'data-dy2-memlist': '' }, ...mem.pending.map(pendingRow)))
            : null,
          memRows(),
          !memResults && (mem?.arcs ?? []).length
            ? h('div', null,
              h('div', { 'data-dy2-label': '' }, '最近这几周'),
              h('div', { 'data-dy2-memlist': '' }, ...mem.arcs.map(arcRow)))
            : null,
          memResults
            ? h('div', { 'data-dy2-sub': '' },
              `搜索「${memResults.query || '（空）'}」：事实 ${memResults.facts?.length ?? 0} 条 · `
              + `情节 ${memResults.episodes?.length ?? 0} 条`)
            : null),

        /* ── 记忆星图 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '记忆星图',
            starGraph?.nodes?.length
              ? h('span', { 'data-dy2-badge': 'data-ok' },
                `${starGraph.nodes.length} 星 · ${starGraph.edges.length} 连线`)
              : null,
            h('span', { 'data-dy2-sub': '' }, '性格、事实、情节、叙事线绕成一个星系；只读')),
          h('div', { 'data-dy2-row': '' },
            h('div', { 'data-dy2-seg': '' },
              h('button', {
                'aria-pressed': starLayout === 'force',
                onClick: () => setStarLayout('force'),
              }, '星图'),
              h('button', {
                'aria-pressed': starLayout === 'time',
                onClick: () => setStarLayout('time'),
              }, '时间')),
            h('label', { 'data-dy2-switch': '' },
              h('input', {
                type: 'checkbox', checked: starPrivate,
                disabled: starBusy,
                onChange: toggleStarPrivate,
              }),
              h('span', { 'data-dy2-sub': '' }, '含私人')),
            h('button', {
              'data-dy2-btn': '', disabled: Boolean(starBusy),
              onClick: () => loadStar(starPrivate),
            }, starBusy ? '刷新中…' : '刷新'),
            h('button', {
              'data-dy2-btn': '', onClick: () => setStarFull(!starFull),
            }, starFull ? '退出全屏' : '展开星图')),
          starGraph?.nodes?.length
            ? h(StarMap, {
              graph: starGraph,
              layout: starLayout,
              full: starFull,
              onToggleFull: () => setStarFull(!starFull),
            })
            : h('div', { 'data-dy2-empty': '' },
              starBusy ? '加载星图…' : '还没有记忆 —— 聊几天之后这里会亮起来'),
          starGraph?.stats?.truncated?.episodes
            ? h('div', { 'data-dy2-sub': '' },
              `只显示最近 ${starGraph.nodes.filter((n) => n.type === 'episode').length}`
              + ` 条情节（共 ${starGraph.stats.available.episodes} 条）；旧星留作背景`)
            : null),

        /* ── 记忆体检 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '记忆体检',
            health
              ? h('span', {
                'data-dy2-badge': health.issues?.some((i) => i.count > 0) ? 'data-warn' : 'data-ok',
              }, health.issues?.some((i) => i.count > 0) ? '有可处理项' : '一切正常')
              : null,
            h('span', { 'data-dy2-sub': '' }, '只做诊断，不自动改记忆')),
          health
            ? h('div', { 'data-dy2-sub': '' },
              `事实 ${health.totals?.facts ?? 0} · 待确认 ${health.totals?.pending ?? 0}`
              + ` · 情节 ${health.totals?.episodes ?? 0} · 叙事 ${health.totals?.arcs ?? 0}`
              + `；过期阈值 ${health.staleDays ?? 90} 天`)
            : null,
          health?.issues?.length
            ? h('div', { 'data-dy2-memlist': '' }, ...health.issues.map(healthRow))
            : h('div', { 'data-dy2-empty': '' }, '还没体检 —— 点「重新体检」'),
          h('div', { 'data-dy2-actions': '' },
            h('button', {
              'data-dy2-btn': '', disabled: memLocked, onClick: loadHealth,
            }, '重新体检'),
            h('button', {
              'data-dy2-btn': '', 'data-primary': '', disabled: memLocked,
              onClick: reindexMemory,
            }, memBusy === 'reindex' ? '重建中…' : '重建索引'))),

        /* ── 队列 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '内容队列',
            h('span', { 'data-dy2-sub': '' },
              (queueOpen ? '' : queueItems.length > 5 ? '最近 5 条 · ' : '')
              + '旧 → 新；已回复的不再处理'),
            queueItems.length > 5
              ? h('button', { 'data-dy2-btn': '',
                onClick: () => setQueueOpen(!queueOpen),
              }, queueOpen ? '收起' : `展开全部 ${queueItems.length} 条`)
              : null),
          !queueItems.length
            ? h('div', { 'data-dy2-empty': '' }, '队列为空 —— 主人发视频或文字之后这里会出现')
            : h('div', { 'data-dy2-inner': '' },
              ...queueShown.map((it) => h('div', {
                'data-dy2-item': it.status === 'replied' ? 'done'
                  : it.status === 'failed' ? 'failed' : 'pending',
                key: it.id || it.item_id },
                h('span', {
                  'data-dy2-badge': it.status === 'replied' ? 'data-ok'
                    : it.status === 'failed' ? 'data-err' : 'data-warn',
                }, it.status === 'replied' ? '已回复'
                  : it.status === 'failed' ? `失败 ×${it.attempts}` : '待回复'),
                h('div', { 'data-dy2-grow': '' },
                  h('div', { 'data-dy2-kv': '' }, (it.title || it.text || '(无标题)').slice(0, 70)),
                  h('div', { 'data-dy2-sub': '' },
                    `${it.kind === 'note' ? '图文' : it.kind === 'text' ? '文字' : it.kind === 'sticker' ? '表情' : '视频'}`
                    + `${it.item_id ? ` · ${it.item_id}` : ''} · 见于 ${fmtWhen(it.seen_at)}`)))))),

        /* ── 登录 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '登录',
            login
              ? h('span', {
                'data-dy2-badge': login.logged_in ? 'data-ok'
                  : login.phase === 'failed' ? 'data-err' : 'data-warn',
              }, login.logged_in ? '已登录'
                : login.phase === 'failed' ? '上次失败'
                  : login.phase === 'qr' ? '等待扫码'
                    : login.phase === 'starting' ? '启动中…' : '未登录')
              : null),
          h('div', { 'data-dy2-sub': '' },
            login?.captcha
              ? '无头扫码被抖音风控挡住；请按下面提示在有头窗口人工验证后点「刷新状态」。'
              : '掉登录是正常的（抖音会在服务端作废旧会话）。点「出二维码」，然后打开'
                + '下面给出的 PNG 图片用手机抖音扫；如果出现滑块/短信验证，只能人工完成。'),
          h('div', { 'data-dy2-row': '' },
            h('button', {
              'data-dy2-btn': '', 'data-primary': '', disabled: Boolean(busy),
              onClick: () => loginAct('qr'),
            }, login?.phase === 'qr' || login?.running ? '重新出二维码' : '出二维码'),
            h('button', {
              'data-dy2-btn': '', disabled: Boolean(busy),
              onClick: () => loadLogin(),
            }, '刷新状态')),
          login?.qr
            ? h('div', { 'data-dy2-kv': '' },
              '二维码：',
              h('img', {
                src: `${API}/login/qr.png`,
                alt: '抖音登录二维码',
                style: {
                  display: 'block', width: 180, height: 180, marginTop: 8,
                  borderRadius: 8, background: '#fff',
                },
              }),
              h('div', { 'data-dy2-sub': '' },
                '用手机抖音「扫一扫」扫这张图；原图：' + login.qr))
            : null,
          login?.captcha
            ? h('div', { 'data-dy2-alert': '' },
              '抖音要求滑块/拼图验证 —— 无头模式无法完成。请在有头窗口运行 '
              + 'python tools/export_login_state.py，人工通过后点「刷新状态」')
            : null,
          login?.hint && !login?.captcha
            ? h('div', { 'data-dy2-sub': '' }, login.hint)
            : null),

        /* ── 日志 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '运行日志',
            h('span', { 'data-dy2-sub': '' },
              logSource === 'plugin'
                ? '插件值班日志（data/logs）'
                : '~/.dsh/douyin-whale-scheduler.log')),
          h('div', { 'data-dy2-row': '' },
            h('div', { 'data-dy2-seg': '' },
              h('button', {
                'aria-pressed': logSource === 'plugin' ? 'true' : 'false',
                disabled: Boolean(busy),
                onClick: () => { setLogSource('plugin'); loadLog('plugin'); },
              }, '值班日志'),
              h('button', {
                'aria-pressed': logSource === 'scheduler' ? 'true' : 'false',
                disabled: Boolean(busy),
                onClick: () => { setLogSource('scheduler'); loadLog('scheduler'); },
              }, '调度器日志')),
            h('button', {
              'data-dy2-btn': '', disabled: Boolean(busy),
              onClick: () => loadLog(),
            }, logLines === null ? '读取' : '刷新')),
          logLines !== null
            ? h('div', { 'data-dy2-log': '' },
              logLines.length ? logLines.join('\n') : '（日志是空的）')
            : h('div', { 'data-dy2-empty': '' }, '点「读取」加载最近的运行日志；日志只在本机，不进仓库。')),

        msg
          ? h('div', { 'data-dy2-sub': '', 'data-dy2-row': '' }, msg)
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style');
        style.setAttribute('data-plugin-css', 'dsh-douyin-whale');
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'dsh-douyin-whale: 设置页样式');

        // 设置导航插槽只暴露 label/id，没有图标字段；给本插件按钮打标记，
        // 再用 CSS 把默认齿轮 SVG 换成小鲸鱼。
        const markNav = () => {
          try {
            for (const b of document.querySelectorAll('button')) {
              if ((b.textContent || '').includes('大肥鱼刷抖音')) b.setAttribute('data-dy2-nav', '');
            }
          } catch { /* DOM 不可用就算了 */ }
        };
        if (typeof MutationObserver === 'function' && document.body) {
          const navObserver = new MutationObserver(markNav);
          navObserver.observe(document.body, { childList: true, subtree: true });
          ctx.effect(() => () => navObserver.disconnect(), 'dsh-douyin-whale: 导航图标');
        }
        markNav();

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return; // 宿主没有 slots 能力就不显示面板（工具不受影响）
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-whale', order: 32, label: '大肥鱼刷抖音' },
          () => h(Boundary, null, h(Panel)),
        ));
      },
    };
  },
});
