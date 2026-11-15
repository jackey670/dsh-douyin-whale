/**
 * lib/session_rotate.test.mjs —— 值班会话轮换：闸门、简报、状态文件、编排。
 *
 * 运行：node lib/session_rotate.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  buildHandoffBriefing, readSessionState, sessionStatePath, shouldRotate, writeSessionState,
} from './session_rotate.js';
import { writeMemoryStore } from './memory_layers.js';
import { maybeRotateDutySession } from './whale_tick.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-rotate-'));
const nick = '测试主人';
const now = new Date('2026-11-14T12:00:00+08:00');
let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

const ep = (id, ts, summary, visibility = 'public', importance = 3) => ({
  id, ts, kind: visibility === 'private' ? 'diary' : 'chat', summary,
  evidence: [{ source: 'dm', quote: summary }], tags: ['测试'],
  importance, valence: 0, visibility, source_ref: 'fixture', last_used_at: '', uses: 0,
});

fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
writeMemoryStore(home, {
  profile: {
    version: 1,
    facts: [
      { id: 'f_pub', text: '主人喜欢咖啡', category: 'preference', confidence: 0.9, pinned: true, visibility: 'public' },
      { id: 'f_priv', text: '主人的私人边界', category: 'boundary', confidence: 0.9, visibility: 'private' },
    ],
    pending: [],
    relationship: {
      stage: '熟悉',
      milestones: [{ at: '2026-10-20', text: '第一次聊到很晚', visibility: 'public' }],
    },
  },
  episodes: [
    ep('ep_pub', '2026-10-20T21:00:00+08:00', '主人加班到很晚，项目要交付。', 'public', 5),
    ep('ep_priv', '2026-10-21T22:00:00+08:00', '大肥鱼偷偷心疼主人。', 'private', 4),
  ],
  arcs: {
    version: 1,
    arcs: [
      { id: 'arc_pub', period: '2026-11-08 ~ 2026-11-14', title: '赶项目的一周', summary: '主人连续加班，周末才缓过来。', episode_ids: ['ep_pub'], visibility: 'public', createdAt: '2026-11-14T00:00:00.000Z' },
      { id: 'arc_priv', period: '2026-11-08 ~ 2026-11-14', title: '偷偷心疼', summary: '大肥鱼心疼主人。', episode_ids: ['ep_priv'], visibility: 'private', createdAt: '2026-11-13T00:00:00.000Z' },
    ],
  },
  meta: {
    version: 1, migratedAt: '2026-10-01T00:00:00.000Z',
    lastConsolidatedAt: now.toISOString(),
  },
}, now);
fs.writeFileSync(path.join(home, 'memory', `dm-${nick}.json`), JSON.stringify({
  who: { nick },
  rounds: 3,
  facts: [],
  messages: [
    { at: '2026-11-14T10:00:00+08:00', from: 'them', text: '今晚吃什么', kind: 'text' },
    { at: '2026-11-14T10:01:00+08:00', from: 'me', text: '火锅？', kind: 'text' },
  ],
}, null, 2), 'utf8');

try {
  // 1) 闸门：关闭/手动/用量/年龄/轮数/正常
  {
    const high = { ratio: 0.8, usedTokens: 800, contextWindow: 1000 };
    assert.equal(shouldRotate({ context: high, cfg: { duty: { rotate: { enabled: false } } } }).reason, 'disabled');
    assert.equal(shouldRotate({ context: high, cfg: {}, force: true }).reason, 'manual');
    assert.equal(shouldRotate({ context: high, cfg: {}, now }).reason, 'usage');
    assert.equal(shouldRotate({
      context: { ratio: 0.1 }, startedAt: '2026-11-06T12:00:00+08:00', cfg: {}, now,
    }).reason, 'age');
    assert.equal(shouldRotate({ context: { ratio: 0.1 }, turns: 201, cfg: {}, now }).reason, 'turns');
    assert.equal(shouldRotate({ context: { ratio: 0.1 }, turns: 1, cfg: {}, now }).ok, false);
    ok('shouldRotate 六种条件');
  }

  // 2) 简报：公开内容进、私人内容不进、长度受限
  {
    const text = buildHandoffBriefing({
      home, nick, now,
      mood: { label: '平静', energy: 70, social: 40, boredom: 30 },
    });
    assert.match(text, /【主人档案】/);
    assert.match(text, /主人喜欢咖啡/);
    assert.match(text, /【我们之间】/);
    assert.match(text, /第一次聊到很晚/);
    assert.match(text, /【最近这几周】/);
    assert.match(text, /赶项目的一周/);
    assert.match(text, /【重要回忆】/);
    assert.match(text, /加班到很晚/);
    assert.match(text, /【最近聊过】/);
    assert.match(text, /今晚吃什么/);
    assert.match(text, /【现在状态】平静/);
    assert.doesNotMatch(text, /私人边界/);
    assert.doesNotMatch(text, /偷偷心疼/);
    assert.doesNotMatch(text, /偷偷心疼主人/);
    assert.ok(text.length <= 1400, `简报 ${text.length} 字`);
    const tiny = buildHandoffBriefing({ home, nick, now, maxChars: 200 });
    assert.ok(tiny.length <= 200, `截断后 ${tiny.length} 字`);
    ok('交接简报（公开/私人过滤 + 预算）');
  }

  // 3) 状态文件：原子写 + 读回
  {
    const file = sessionStatePath(home);
    writeSessionState(file, {
      version: 1,
      current: { epoch: 2, sessionId: 'douyin-whale-duty-e2', startedAt: now.toISOString() },
      history: [{ epoch: 1, sessionId: 'douyin-whale-duty-v2' }],
    });
    const st = readSessionState(file);
    assert.equal(st.current.epoch, 2);
    assert.equal(st.current.sessionId, 'douyin-whale-duty-e2');
    assert.equal(st.history.length, 1);
    assert.equal(readSessionState(path.join(home, 'memory', 'nope.json')), null);
    ok('session-epochs 状态读写');
  }

  // 4) 编排：到阈值先固化/反思再 rotate；不到阈值不动
  {
    const calls = [];
    const dutyAgent = {
      contextInfo: () => ({
        ready: true, ratio: 0.8, usedTokens: 800, contextWindow: 1000,
        turns: 3, startedAt: '2026-11-13T12:00:00+08:00', source: 'usage',
      }),
      ask: async () => ({ ok: true, text: '{}' }),
      rotate: async ({ briefing, reason }) => {
        calls.push({ briefing, reason });
        return { ok: true, sessionId: 'douyin-whale-duty-e2', epoch: 2 };
      },
    };
    const r = await maybeRotateDutySession({
      dutyAgent, cfg: {}, home, nick, mood: { label: '平静' }, now,
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reason, 'usage');
    assert.match(calls[0].briefing, /主人喜欢咖啡/);

    const low = { ...dutyAgent, contextInfo: () => ({ ready: true, ratio: 0.1, turns: 1 }) };
    const r2 = await maybeRotateDutySession({ dutyAgent: low, cfg: {}, home, nick, now });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'ok');
    ok('maybeRotateDutySession 编排');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
