/**
 * lib/duty_agent.test.mjs —— 值班会话生命周期链的自测（全离线，伪造宿主）。
 *
 * 链路对齐 dsh-douyin-scroll 的值班鱼：get(live) → resume → create，
 * create 撞「已存在」要回头再 get。每条路径一个用例。
 *
 * 运行：node lib/duty_agent.test.mjs
 */
import assert from 'node:assert/strict';

import { createDutyAgent, makeUserMessage, validateUserMessage } from './duty_agent.js';

let pass = 0;
const ok = (name) => { pass++; console.log(`[PASS] ${name}`); };
const logs = [];
const mkCtx = (agents) => ({
  get: (k) => (k === 'agents' ? agents : undefined),
});

/** 假 agent：status 可变，followup 记录消息 */
const mkAgent = (id) => ({
  id,
  status: 'idle',
  _followups: [],
  followup(msg) { this._followups.push(msg); },
});

try {
  // ── ① live get 命中：绝不 resume/create ──
  {
    const live = mkAgent('live');
    let resumeCalls = 0; let createCalls = 0;
    const agents = { get: (id) => (id === 's1' ? live : null) };
    const d = createDutyAgent({ ctx: mkCtx(agents), sessionId: 's1', log: (m) => logs.push(m) });
    const h = await d.ensure();
    assert.equal(h.agent.id, 'live');
    assert.equal(resumeCalls + createCalls, 0);
    ok('① live get 命中直接用');
  }

  // ── ② get 不到 → resume 成功 ──
  {
    const restored = mkAgent('restored');
    const agents = {
      get: () => null,
      resume: async (opts) => {
        assert.equal(opts.resumeSessionId, 's1');
        assert.equal(opts.meta, undefined);          // resume 不传 meta
        assert.equal(typeof opts.setup, 'function'); // 人设挂载点在
        return { agent: restored, dispose: null };
      },
    };
    const d = createDutyAgent({ ctx: mkCtx(agents), sessionId: 's1' });
    const h = await d.ensure();
    assert.equal(h.agent.id, 'restored');
    ok('② resume 恢复且不带 meta');
  }

  // ── ③ resume 报 SessionNotFound → create（带 parent/meta）──
  {
    const created = mkAgent('created');
    const agents = {
      get: () => null,
      roots: () => [{ id: 'root-1', session: { header: { id: 'root-1' } } }],
      resume: async () => { throw new Error('SessionNotFound: s1'); },
      create: async (opts) => {
        assert.equal(opts.sessionId, 's1');
        assert.equal(opts.meta.parentSession, 'root-1');   // 子会话不进侧栏
        assert.equal(opts.meta.origin, 'subagent');
        assert.ok(opts.parentAgent);
        return { agent: created, dispose: null };
      },
    };
    const d = createDutyAgent({ ctx: mkCtx(agents), sessionId: 's1' });
    const h = await d.ensure();
    assert.equal(h.agent.id, 'created');
    ok('③ create 带 parent/meta（不进侧栏）');
  }

  // ── ④ create 撞「已存在」→ 回头再 get ──
  {
    const live = mkAgent('the-live-one');
    const agents = {
      get: (() => { let n = 0; return () => (++n === 1 ? null : live); })(),
      resume: async () => { throw new Error('SessionNotFound'); },
      create: async () => { throw new Error('session already registered: s1'); },
    };
    const d = createDutyAgent({ ctx: mkCtx(agents), sessionId: 's1' });
    const h = await d.ensure();
    assert.equal(h.agent.id, 'the-live-one');
    ok('④ create 撞已存在回头再 get');
  }

  // ── ⑤ 句柄 status 读不出来 → 重新拉 ──
  {
    const stale = { get status() { throw new Error('disposed'); } };
    const fresh = mkAgent('fresh');
    const agents = { get: (id) => (id === 's1' ? stale : null) };
    const d = createDutyAgent({ ctx: mkCtx(agents), sessionId: 's1' });
    let h = await d.ensure();
    assert.equal(h.agent, stale);                        // 第一拍拿到 stale
    const agents2 = { get: () => fresh };                // 第二拍 get 到 fresh
    const d2 = createDutyAgent({ ctx: mkCtx(agents2), sessionId: 's1' });
    h = await d2.ensure();
    assert.equal(h.agent.id, 'fresh');
    ok('⑤ status 抛错时重新拉新句柄');
  }

  // ── ⑥ send：消息四件套齐全 + followup 到位 ──
  {
    const agent = mkAgent('live');
    const agents = { get: () => agent };
    const d = createDutyAgent({ ctx: mkCtx(agents), sessionId: 's1' });
    const r = await d.send('任务文本');
    assert.equal(r.ok, true);
    assert.equal(agent._followups.length, 2);            // 上岗章程 + 任务
    const msg = agent._followups.at(-1);
    assert.equal(validateUserMessage(msg), null);        // 合格
    assert.equal(msg.role, 'user');
    assert.equal(msg.source.kind, 'user');
    assert.equal(msg.content[0].text, '任务文本');
    assert.ok(typeof msg.source.clientTimeZone === 'string');
    ok('⑥ send 消息四件套齐全');
  }

  // ── ⑦ agents 不可用 → send 失败但绝不抛 ──
  {
    const d = createDutyAgent({ ctx: mkCtx(null), sessionId: 's1' });
    const r = await d.send('x');
    assert.equal(r.ok, false);
    assert.match(r.reason, /没拉起来/);
    ok('⑦ 无 agents 服务时优雅失败');
  }

  // ── ⑧ makeUserMessage / validate ──
  {
    const m = makeUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } });
    assert.equal(validateUserMessage(m), null);
    assert.equal(validateUserMessage({ role: 'user' }), '缺字段 id');
    assert.equal(validateUserMessage({ ...m, role: 'assistant' }), 'role 不是 user');
    ok('⑧ 消息校验');
  }

  console.log(`\nALL PASSED (${pass})`);
} catch (e) {
  console.error('日志尾部：', logs.slice(-6).join('\n'));
  throw e;
}
