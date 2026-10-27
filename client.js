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
 * ⭐ PANEL_BUILD：每次改完 client.js 就 +1，面板右上角 v1.4.1·b<N> 用来
 *   排「浏览器还在用缓存」的障。版本号必须和 package.json 一致 ——
 *   tools/release-audit.mjs 会机械核对，别让它漂。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-whale',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const API = '/api/douyin-whale';
    const PANEL_BUILD = 4;

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
[data-dy2-form]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;}
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
[data-dy2-v]{font-size:12px;line-height:18px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-dy2-nav] > svg{display:none !important;}
[data-dy2-nav]::before{content:'🐳';width:16px;font-size:14px;line-height:16px;text-align:center;flex:none;}
@media (max-width:560px){[data-dy2-stats]{grid-template-columns:repeat(2,minmax(0,1fr));}}
[data-dy2-badge]{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));}
[data-dy2-badge][data-ok]{color:#22c55e;border-color:rgba(34,197,94,.5);}
[data-dy2-badge][data-warn]{color:#f59e0b;border-color:rgba(245,158,11,.5);}
[data-dy2-badge][data-err]{color:#ef4444;border-color:rgba(239,68,68,.5);}
[data-dy2-log]{max-height:240px;overflow:auto;font-family:ui-monospace,Consolas,monospace;
  font-size:11px;line-height:16px;padding:8px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.18));white-space:pre-wrap;word-break:break-all;}
[data-dy2-item]{display:flex;gap:8px;align-items:flex-start;padding:7px 9px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));}
[data-dy2-empty]{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);padding:6px 2px;}
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

      const load = useCallback(async () => {
        setBusy('load');
        try {
          const [s, q, c, l] = await Promise.all([
            jget('/status'), jget('/queue'), jget('/config'), jget('/login/status'),
          ]);
          setData(s);
          setLogin(l);
          setNick(s.owner || '');
          setIntervalMin(s.watch?.intervalMinutes ?? 10);
          setDailyMax(s.watch?.dailyMax ?? 60);
          setEnabled(s.watch?.enabled !== false);
          const w = (s.watch?.windows ?? [])[0] ?? {};
          setWinStart(w.start ?? '00:00');
          setWinEnd(w.end ?? '24:00');
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
          });
          if (j.ok) setMsg('配置已保存（下个 tick 生效）');
          else setMsg(j.error || '保存失败');
        } catch (e) {
          setMsg(String(e?.message ?? e));
        } finally {
          setBusy('');
        }
      }, [nick, enabled, interval, dailyMax, winStart, winEnd]);

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

      const running = data?.daemon?.running === true;
      const gate = data?.gate ?? {};
      const queue = data?.queue ?? {};

      return h('div', { 'data-dy2-page': '' },

        /* ── 状态 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' },
            '运行状态',
            h('span', { 'data-dy2-badge': running ? 'data-ok' : 'data-warn' },
              running ? `运行中 · PID ${data?.daemon?.pid}` : '未运行'),
            h('span', { 'data-dy2-sub': '' }, `v1.4.1·b${PANEL_BUILD}`)),
          data
            ? h('div', { 'data-dy2-stats': '' },
                h('div', { 'data-dy2-stat': '' },
                  h('span', { 'data-dy2-k': '' }, '主人'),
                  h('span', { 'data-dy2-v': '' }, data.owner || '（未配置）')),
                h('div', { 'data-dy2-stat': '' },
                  h('span', { 'data-dy2-k': '' }, '今天'),
                  h('span', { 'data-dy2-v': '' }, `已回复 ${data.today?.watches ?? 0} 条`)),
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
                  h('span', { 'data-dy2-v': '' }, data.duty_enabled ? '已启用' : '未启用')),
                h('div', { 'data-dy2-stat': '' },
                  h('span', { 'data-dy2-k': '' }, '记忆'),
                  h('span', { 'data-dy2-v': '' }, data.memory?.files
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
                    '关闭后不检查私信、不消耗 token，只保留面板和工具。'))))),
          h('div', { 'data-dy2-actions': '' },
            h('button', {
              'data-dy2-btn': '', 'data-primary': '', disabled: Boolean(busy),
              onClick: saveConfig,
            }, '保存设置'))),

        /* ── 队列 ── */
        h('div', { 'data-dy2-card': '' },
          h('div', { 'data-dy2-title': '' }, '内容队列',
            h('span', { 'data-dy2-sub': '' }, '旧 → 新；已回复的不再处理')),
          !(queue.items ?? []).length
            ? h('div', { 'data-dy2-empty': '' }, '队列为空 —— 主人发视频之后这里会出现')
            : h('div', { 'data-dy2-inner': '' },
              ...queue.items.slice().reverse().map((it) => h('div', { 'data-dy2-item': '', key: it.item_id },
                h('span', {
                  'data-dy2-badge': it.status === 'replied' ? 'data-ok' : 'data-warn',
                }, it.status === 'replied' ? '已回复' : '待回复'),
                h('div', { 'data-dy2-grow': '' },
                  h('div', { 'data-dy2-kv': '' }, (it.title || '(无标题)').slice(0, 70)),
                  h('div', { 'data-dy2-sub': '' },
                    `${it.kind === 'note' ? '图文' : '视频'} · ${it.item_id} · 见于 ${fmtWhen(it.seen_at)}`)))))),

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
            ? h('div', { 'data-dy2-badge': 'data-err' },
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
            h('button', {
              'data-dy2-btn': '',
              ...(logSource === 'plugin' ? { 'data-primary': '' } : {}),
              disabled: Boolean(busy),
              onClick: () => { setLogSource('plugin'); loadLog('plugin'); },
            }, '值班日志'),
            h('button', {
              'data-dy2-btn': '',
              ...(logSource === 'scheduler' ? { 'data-primary': '' } : {}),
              disabled: Boolean(busy),
              onClick: () => { setLogSource('scheduler'); loadLog('scheduler'); },
            }, '调度器日志'),
            h('button', {
              'data-dy2-btn': '', disabled: Boolean(busy),
              onClick: () => loadLog(),
            }, logLines === null ? '读取' : '刷新')),
          logLines !== null
            ? h('div', { 'data-dy2-log': '' },
              logLines.length ? logLines.join('\n') : '（日志是空的）')
            : null),

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
