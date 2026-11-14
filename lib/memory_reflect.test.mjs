/**
 * lib/memory_reflect.test.mjs —— 周反思：窗口、闸门、校验、写回与重跑替换。
 *
 * 运行：node lib/memory_reflect.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  applyArcs, buildReflectionPrompt, collectReflectionEpisodes, reflectionPeriod,
  runReflection, shouldReflect, validateArcs,
} from './memory_reflect.js';
import { readMemoryStore, writeMemoryStore } from './memory_layers.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reflect-'));
const now = new Date('2026-11-14T12:00:00+08:00');
let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

const ep = (id, ts, summary, quote, visibility = 'public', tags = ['日常']) => ({
  id, ts, kind: visibility === 'private' ? 'diary' : 'chat', summary,
  evidence: [{ source: 'dm', quote, at: ts }],
  tags, importance: 3, valence: 0, visibility, source_ref: 'fixture',
  last_used_at: '', uses: 0,
});

function resetStore() {
  fs.rmSync(path.join(home, 'memory'), { recursive: true, force: true });
  writeMemoryStore(home, {
    profile: { version: 1, facts: [], pending: [], relationship: { stage: '', milestones: [] } },
    episodes: [
      ep('ep_01', '2026-11-09T21:00:00+08:00', '主人加班到十点，项目还没收尾。', '这周天天加班到十点', 'public', ['工作']),
      ep('ep_02', '2026-11-10T22:00:00+08:00', '主人忙得晚饭都忘了吃。', '忙得晚饭都忘了吃', 'public', ['工作', '健康']),
      ep('ep_03', '2026-11-12T20:00:00+08:00', '主人买了新键盘，青轴很响。', '新键盘是青轴的', 'public', ['数码']),
      ep('ep_04', '2026-11-13T18:00:00+08:00', '主人周末想去海边走走。', '周末想去海边', 'public', ['旅行']),
      ep('ep_05', '2026-11-11T23:30:00+08:00', '大肥鱼偷偷心疼主人加班。', '我有点心疼主人', 'private', ['私人日记']),
    ],
    arcs: { version: 1, updatedAt: now.toISOString(), arcs: [] },
    meta: {
      version: 1, migratedAt: '2026-10-20T00:00:00.000Z',
      lastConsolidatedAt: '2026-11-12T00:00:00.000Z',
    },
  }, now);
}

try {
  resetStore();

  // 1) 窗口：最近 7 天，label/key 稳定
  {
    const p = reflectionPeriod(now);
    assert.equal(p.start, '2026-11-08');
    assert.equal(p.end, '2026-11-14');
    assert.equal(p.label, '2026-11-08 ~ 2026-11-14');
    assert.equal(p.key, '20261114');
    assert.ok(p.startMs < Date.parse('2026-11-09T00:00:00+08:00'));
    ok('reflectionPeriod 7 天窗口');
  }

  // 2) 采集：窗口内 5 条，私人标记保留
  {
    const { episodes } = collectReflectionEpisodes({ home, now });
    assert.equal(episodes.length, 5);
    assert.ok(episodes.some((e) => e.visibility === 'private'));
    const old = collectReflectionEpisodes({ home, now, days: 1 });
    assert.ok(old.episodes.length <= 1, '1 天窗口只覆盖今天');
    ok('collectReflectionEpisodes 窗口 + 私人标记');
  }

  // 3) 闸门：关闭/太少/7 天内/重试间隔/手动
  {
    const episodes = collectReflectionEpisodes({ home, now }).episodes;
    assert.equal(shouldReflect({
      episodes, cfg: { memory: { reflect: { enabled: false } } }, now,
    }).reason, 'disabled');
    assert.equal(shouldReflect({ episodes: episodes.slice(0, 2), cfg: {}, now }).reason, 'not-enough');
    assert.equal(shouldReflect({
      episodes, cfg: {}, now,
      arcs: [{ createdAt: '2026-11-12T12:00:00+08:00' }],
    }).reason, 'too-soon');
    assert.equal(shouldReflect({
      episodes, cfg: {}, now,
      meta: { lastReflectAttemptAt: '2026-11-14T11:30:00+08:00' },
    }).reason, 'retry-later');
    assert.equal(shouldReflect({ episodes, cfg: {}, now, force: true }).reason, 'manual');
    assert.equal(shouldReflect({ episodes, cfg: {}, now }).ok, true);
    ok('shouldReflect 五种闸门');
  }

  // 4) 提示词：编号、隐私、严格 JSON
  {
    const { episodes, period } = collectReflectionEpisodes({ home, now });
    const prompt = buildReflectionPrompt({ episodes, period });
    assert.match(prompt, /\[E1\]/);
    assert.match(prompt, /\[E5\]/);
    assert.match(prompt, /私人日记/);
    assert.match(prompt, /输出严格 JSON/);
    assert.match(prompt, /episode_ids/);
    ok('反思提示词（编号/私人/JSON）');
  }

  // 5) 校验：未知编号/单条引用/URL/重复丢弃；私人来源标 private
  {
    const { episodes, period } = collectReflectionEpisodes({ home, now });
    const v = validateArcs({
      episodes, period, now,
      candidates: {
        arcs: [
          { title: '赶项目的一周', summary: '主人连续加班，周末才缓过来。', episode_ids: ['E1', 'E2'] },
          { title: '私人心情', summary: '大肥鱼偷偷心疼主人加班。', episode_ids: ['E3'] },
          { title: '坏链接', summary: 'https://example.com', episode_ids: ['E1', 'E2'] },
          { title: '赶项目的一周', summary: '主人连续加班，周末才缓过来。', episode_ids: ['E1', 'E2'] },
          { title: '加班与周末', summary: '主人加班到很晚，周末去海边放松。', episode_ids: ['E1', 'E2', 'E9', 'E3'] },
        ],
      },
    });
    assert.equal(v.arcs.length, 2);
    assert.equal(v.arcs[0].visibility, 'public');
    assert.equal(v.arcs[1].visibility, 'private');
    assert.equal(v.arcs[1].episode_ids.length, 3, '不存在的 E9 被丢掉');
    assert.ok(v.rejected.length >= 3);
    ok('validateArcs 编号/长度/URL/去重/私人');
  }

  // 6) 写回：同一 period 重跑替换，不叠加
  {
    const p = reflectionPeriod(now);
    const arc = (title, n) => ({
      id: `arc_${p.key}_${n}`, period: p.label, title, summary: '测试摘要，至少八个字。',
      episode_ids: ['ep_01', 'ep_02'], visibility: 'public', createdAt: now.toISOString(),
    });
    const first = applyArcs({ home, arcs: [arc('第一版', 1), arc('第二版', 2)], period: p, episodeCount: 5, now });
    assert.equal(first.added, 2);
    assert.equal(readMemoryStore(home).arcs.arcs.length, 2);
    const again = applyArcs({ home, arcs: [arc('替换版', 3)], period: p, episodeCount: 5, now });
    assert.equal(again.replaced, 2);
    assert.equal(again.total, 1);
    ok('applyArcs 同 period 替换');
  }

  // 7) 端到端：模型 JSON → 校验 → 落盘 → 7 天内重跑被闸门挡住
  {
    resetStore();
    const response = {
      arcs: [
        { title: '赶项目的一周', summary: '主人连续加班，周末才缓过来。', episode_ids: ['E1', 'E2'] },
        { title: '加班的夜里', summary: '大肥鱼偷偷心疼主人，没敢多说。', episode_ids: ['E1', 'E3'] },
      ],
    };
    const r = await runReflection({
      home, cfg: {}, now, force: true, lock: false,
      invoke: async () => JSON.stringify(response),
    });
    assert.equal(r.ok, true);
    assert.equal(r.added, 2);
    const store = readMemoryStore(home);
    assert.equal(store.arcs.arcs.length, 2);
    assert.equal(store.arcs.arcs[1].visibility, 'private');
    assert.equal(store.meta.lastReflection.arcs, 2);
    const blocked = await runReflection({
      home, cfg: {}, now: new Date('2026-11-15T12:00:00+08:00'), lock: false,
      invoke: async () => { throw new Error('不应被调用'); },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'too-soon');
    ok('runReflection 端到端 + 重跑闸门');
  }

  // 8) 坏 JSON / 无有效叙事线：不写 arcs，记尝试时间
  {
    resetStore();
    const bad = await runReflection({
      home, cfg: {}, now, force: true, lock: false,
      invoke: async () => '不是 JSON',
    });
    assert.equal(bad.reason, 'bad-json');
    assert.equal(readMemoryStore(home).arcs.arcs.length, 0);
    assert.equal(readMemoryStore(home).meta.lastReflectError, 'bad-json');

    const none = await runReflection({
      home, cfg: {}, now: new Date('2026-11-14T13:00:00+08:00'), force: true, lock: false,
      invoke: async () => JSON.stringify({ arcs: [] }),
    });
    assert.equal(none.reason, 'no-valid-arcs');
    ok('坏 JSON / 空 arcs 不写记忆');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
