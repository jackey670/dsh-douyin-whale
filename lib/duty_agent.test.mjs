/**
 * lib/duty_agent.test.mjs —— 值班会话生命周期链的自测（全离线，伪造宿主）。
 *
 * 链路对齐 dsh-douyin-scroll 的值班鱼：get(live) → resume → create，
 * create 撞「已存在」要回头再 get。每条路径一个用例。
 *
 * 运行：node lib/duty_agent.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDutyAgent, makeUserMessage, validateUserMessage } from './duty_agent.js';
import { readSessionState } from './session_rotate.js';

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

  // ── ③b 无 parent 可借：origin=subagent 也要写（桌面版常态）──
  {
    const created = mkAgent('created');
    const agents = {
      get: () => null,
      roots: () => [],                       // 桌面版平时没有 root 会话
      resume: async () => { throw new Error('SessionNotFound: s1'); },
      create: async (opts) => {
        assert.equal(opts.meta.origin, 'subagent');       // 侧栏隐藏开关必须在
        assert.equal(opts.meta.delegationDepth, 1);
        assert.equal(opts.meta.parentSession, undefined); // 没借到就不乱指
        assert.equal(opts.parentAgent, undefined);
        return { agent: created, dispose: null };
      },
    };
    const d = createDutyAgent({ ctx: mkCtx(agents), sessionId: 's1', log: (m) => logs.push(m) });
    const h = await d.ensure();
    assert.equal(h.agent.id, 'created');
    assert.ok(logs.some((m) => m.includes('origin=subagent 已隐藏')), '应记自隐藏日志');
    ok('③b 无 parent 也写 origin=subagent（不进侧栏）');
  }

  // ── ③c 用户开了「侧栏可见」：不写 origin/delegationDepth（布尔与函数两种形态）──
  for (const [label, flag] of [
    ['布尔', true],
    ['函数', () => true],   // 面板传 getter：每次 create 现读配置
  ]) {
    const created = mkAgent('created');
    const agents = {
      get: () => null,
      roots: () => [],
      resume: async () => { throw new Error('SessionNotFound: s1'); },
      create: async (opts) => {
        assert.equal(opts.meta.origin, undefined, `${label}：可见时不能带 origin`);
        assert.equal(opts.meta.delegationDepth, undefined, `${label}：与 origin 成对消失`);
        return { agent: created, dispose: null };
      },
    };
    const d = createDutyAgent({ ctx: mkCtx(agents), sessionId: 's1', sidebarVisible: flag });
    const h = await d.ensure();
    assert.equal(h.agent.id, 'created');
    ok(`③c sidebarVisible=true（${label}）不写 origin（进侧栏）`);
  }
  // 函数返回 false / 抛错 → 仍隐藏（兜底安全：读不到配置就藏）
  {
    const agents = {
      get: () => null,
      resume: async () => { throw new Error('SessionNotFound: s1'); },
      create: async (opts) => {
        assert.equal(opts.meta.origin, 'subagent', 'getter 抛错也要默认隐藏');
        return { agent: mkAgent('created'), dispose: null };
      },
    };
    const d = createDutyAgent({
      ctx: mkCtx(agents), sessionId: 's1',
      sidebarVisible: () => { throw new Error('boom'); },
    });
    await d.ensure();
    ok('③c getter 抛错时兜底隐藏');
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

  // ── ⑨ contextInfo：usage 优先，窗口/轮数 ──
  {
    const agent = mkAgent('live');
    agent.session = {
      requestContext: () => ({ contextWindow: 1000 }),
      snapshotEvents: () => [
        { type: 'turn/start', data: {} },
        { type: 'assistant/message', data: { usage: { inputTokens: 600, outputTokens: 50 } } },
      ],
      deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
    };
    const d = createDutyAgent({ ctx: mkCtx({ get: () => agent }), sessionId: 's1' });
    await d.ensure();
    const info = d.contextInfo();
    assert.equal(info.ready, true);
    assert.equal(info.usedTokens, 600);
    assert.equal(info.contextWindow, 1000);
    assert.equal(info.ratio, 0.6);
    assert.equal(info.turns, 1);
    assert.equal(info.source, 'usage');
    ok('⑨ contextInfo 读 usage/窗口/轮数');
  }

  // ── ⑩ rotate：新会话 + 简报排进 next-turn + 状态文件切 epoch ──
  {
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whale-duty-')), 'epochs.json');
    const oldAgent = mkAgent('old');
    oldAgent.session = {
      requestContext: () => ({ contextWindow: 1000 }),
      snapshotEvents: () => [],
      deriveMessages: () => [],
    };
    let createdId = '';
    const newAgent = mkAgent('new');
    newAgent._sent = [];
    newAgent.send = function send(msg, target, wakeup) { this._sent.push({ msg, target, wakeup }); };
    const agents = {
      get: () => oldAgent,
      create: async (opts) => {
        createdId = opts.sessionId;
        return { agent: newAgent, dispose: null };
      },
    };
    const d = createDutyAgent({ ctx: mkCtx(agents), sessionId: 's1', sessionStateFile: stateFile });
    const r = await d.rotate({ briefing: '交接内容', reason: 'usage' });
    assert.equal(r.ok, true);
    assert.equal(createdId, 'douyin-whale-duty-e2');
    assert.equal(d.sessionId, 'douyin-whale-duty-e2');
    assert.equal(d.epoch, 2);
    assert.equal(newAgent._sent.length, 1);
    assert.equal(newAgent._sent[0].target, 'next-turn');
    assert.equal(newAgent._sent[0].wakeup, false);
    assert.equal(newAgent._sent[0].msg.content[0].text, '交接内容');
    const st = readSessionState(stateFile);
    assert.equal(st.current.sessionId, 'douyin-whale-duty-e2');
    assert.equal(st.current.epoch, 2);
    ok('⑩ rotate 新会话/简报/状态文件');
  }

  // ── ⑪ 状态文件恢复：插件重载后继续用 e5 ──
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-duty-'));
    const stateFile = path.join(dir, 'epochs.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      current: { epoch: 5, sessionId: 'douyin-whale-duty-e5', startedAt: new Date().toISOString() },
      history: [],
    }));
    const agent = mkAgent('e5');
    let askedId = '';
    const d = createDutyAgent({
      ctx: mkCtx({ get: (id) => { askedId = id; return agent; } }),
      sessionId: 's1', sessionStateFile: stateFile,
    });
    await d.ensure();
    assert.equal(askedId, 'douyin-whale-duty-e5');
    assert.equal(d.sessionId, 'douyin-whale-duty-e5');
    assert.equal(d.epoch, 5);
    fs.rmSync(dir, { recursive: true, force: true });
    ok('⑪ 状态文件恢复轮换后的 sessionId');
  }

  // ── ⑫ awaitIdle：消息数基线 / queued / earlyExit ──
  {
    /** 可编程假 agent：deriveMessages 可增长，status 手切（模拟模型跑完）。
     *  注意跳过「值班上岗」问候：真宿主里它也会唤醒一轮，但会让 send 的
     *  runningNow 捕获变成 true，测试意图是「本轮自己投递」。 */
    const mkRich = (id) => {
      const msgs = [];
      return {
        id,
        status: 'idle',
        msgs,
        followup(msg) {
          const t = String(msg?.content?.[0]?.text || '');
          if (t.includes('值班上岗')) return;
          this.status = 'running';
        },
        session: { deriveMessages: () => msgs.slice() },
      };
    };

    // ⑫a 回归 v1.14.9 的 bug：send 必须写回基线，消息增长后按 messages 收轮
    {
      const ag = mkRich('r1');
      const d = createDutyAgent({ ctx: mkCtx({ get: () => ag }), sessionId: 's1' });
      const sent = await d.send('干活');
      assert.equal(sent.ok, true);
      setTimeout(() => { ag.msgs.push({ role: 'assistant', content: [] }); ag.status = 'idle'; }, 30);
      const idle = await d.awaitIdle({ idleMs: 500, pollMs: 5 });
      assert.equal(idle.via, 'messages');
      assert.ok(!idle.timedOut, '有基线后不该等到超时');
    }

    // ⑫b queued：send 时已在跑 → 先等旧轮结束、刷新基线，再按本轮消息增长收轮
    {
      const ag = mkRich('r2');
      ag.status = 'running';
      const d = createDutyAgent({ ctx: mkCtx({ get: () => ag }), sessionId: 's1' });
      const sent = await d.send('排队活');
      assert.equal(sent.runningNow, true);
      setTimeout(() => { ag.msgs.push({ role: 'assistant', content: [] }); ag.status = 'idle'; }, 20);
      setTimeout(() => { ag.status = 'running'; }, 40);
      setTimeout(() => { ag.msgs.push({ role: 'assistant', content: [] }); ag.status = 'idle'; }, 60);
      const idle = await d.awaitIdle({ idleMs: 800, pollMs: 5 });
      assert.equal(idle.via, 'messages');
      assert.ok(!idle.timedOut);
    }

    // ⑫c earlyExit 命中：不等 running→idle，直接按标记收轮
    {
      const ag = mkRich('r3');
      const d = createDutyAgent({ ctx: mkCtx({ get: () => ag }), sessionId: 's1' });
      await d.send('干活');
      const idle = await d.awaitIdle({ idleMs: 500, pollMs: 5, earlyExit: () => true });
      assert.equal(idle.earlyExit, true);
      assert.equal(idle.via, 'marker');
      assert.ok(!idle.timedOut);
    }

    // ⑫d earlyExit 抛错：吞掉，退回正常判定（这里 agent 一直 running → 超时）
    {
      const ag = mkRich('r4');
      const d = createDutyAgent({ ctx: mkCtx({ get: () => ag }), sessionId: 's1' });
      await d.send('干活');
      const idle = await d.awaitIdle({
        idleMs: 120, pollMs: 5,
        earlyExit: () => { throw new Error('boom'); },
      });
      assert.equal(idle.earlyExit, undefined);
      assert.equal(idle.timedOut, true);
      ag.status = 'idle';
    }

    // ⑫e queued 轮禁用 earlyExit（标记可能属于上一轮）
    {
      const ag = mkRich('r5');
      ag.status = 'running';
      const d = createDutyAgent({ ctx: mkCtx({ get: () => ag }), sessionId: 's1' });
      const sent = await d.send('排队活');
      assert.equal(sent.runningNow, true);
      setTimeout(() => { ag.msgs.push({ role: 'assistant', content: [] }); ag.status = 'idle'; }, 20);
      setTimeout(() => { ag.status = 'running'; }, 40);
      setTimeout(() => { ag.msgs.push({ role: 'assistant', content: [] }); ag.status = 'idle'; }, 60);
      const idle = await d.awaitIdle({ idleMs: 800, pollMs: 5, earlyExit: () => true });
      assert.notEqual(idle.via, 'marker', 'queued 轮不允许提前收轮');
      assert.equal(idle.via, 'messages');
    }
    ok('⑫ awaitIdle 基线/queued/earlyExit');
  }

  console.log(`\nALL PASSED (${pass})`);
} catch (e) {
  console.error('日志尾部：', logs.slice(-6).join('\n'));
  throw e;
}
