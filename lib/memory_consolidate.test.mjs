/**
 * lib/memory_consolidate.test.mjs —— 记忆固化：采集、闸门、证据校验、写回。
 *
 * 运行：node lib/memory_consolidate.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  buildConsolidationPrompt, collectSources, parseConsolidationResponse,
  runConsolidation, shouldConsolidate, validateCandidates,
} from './memory_consolidate.js';
import {
  buildMemoryContext,
  migrateMemoryLayers, memoryPaths, readMemoryStore, writeMeta,
} from './memory_layers.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-consolidate-'));
const nick = '测试主人';
const now = new Date('2026-11-11T04:00:00Z');     // 本地 12:00
const since = '2026-11-10T00:00:00Z';
let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

function resetStore() {
  const paths = memoryPaths(home);
  fs.rmSync(paths.dir, { recursive: true, force: true });
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(path.join(paths.dir, `dm-${nick}.json`), JSON.stringify({
    who: { nick },
    updatedAt: '2026-11-11T02:00:00.000Z',
    rounds: 2,
    facts: [],
    messages: [
      { at: '2026-11-10T13:00:00.000Z', from: 'them', text: '我下周三要去杭州出差', kind: 'text' },
      { at: '2026-11-10T13:05:00.000Z', from: 'me', text: '记得带伞', kind: 'text' },
      { at: '2026-11-11T02:00:00.000Z', from: 'them', text: '我其实不太喜欢吃香菜', kind: 'text' },
    ],
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(home, 'whale-diary.md'), [
    '## 2026-11-10 · 22:00（值班轮）',
    '今天主人说要去杭州出差。',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(home, 'whale-diary-private.md'), [
    '## 2026-11-11 · 09:00（值班轮）',
    '今天主人说要去杭州，我有点舍不得。',
    '',
  ].join('\n'), 'utf8');
  migrateMemoryLayers({ home, nick, now: new Date('2026-11-10T08:00:00Z') });
  const store = readMemoryStore(home);
  writeMeta(home, {
    ...store.meta,
    lastConsolidatedAt: since,
    lastConsolidateAttemptAt: '',
  });
}

try {
  resetStore();

  // 1) 采集：只取 since 之后的素材，私人日记标 private
  {
    const sources = collectSources({ home, nick, since: Date.parse(since), now });
    assert.ok(sources.length >= 4);
    assert.ok(sources.some((s) => s.kind === 'chat' && s.text.includes('杭州')));
    assert.ok(sources.some((s) => s.kind === 'diary' && s.visibility === 'public'));
    const priv = sources.find((s) => s.text.includes('舍不得'));
    assert.ok(priv && priv.visibility === 'private', '私人日记保留 private 标记');
    assert.ok(sources[0].id.startsWith('S'));
    ok('collectSources 过滤 since + 私人标记');
  }

  // 2) 闸门：开关/无素材/间隔/消息数/夜间/手动
  {
    const src = [{ kind: 'chat' }, { kind: 'chat' }];
    const meta = { lastConsolidateAttemptAt: '2026-11-11T03:00:00Z' };
    assert.equal(shouldConsolidate({ sources: [], meta, cfg: {} }).reason, 'no-sources');
    assert.equal(shouldConsolidate({
      sources: [{ kind: 'chat' }], meta: {}, cfg: { memory: { consolidate: { enabled: false } } },
    }).reason, 'disabled');
    assert.equal(shouldConsolidate({ sources: src, meta, cfg: {}, now }).reason, 'too-soon');
    assert.equal(shouldConsolidate({
      sources: src, meta: {}, cfg: {}, now: new Date('2026-11-11T04:00:00Z'),
    }).reason, 'not-enough');
    assert.equal(shouldConsolidate({
      sources: src, meta: {},
      cfg: { memory: { consolidate: { minMessages: 2 } } }, now,
    }).ok, true);
    const night = new Date('2026-11-11T04:30:00+08:00'); // 本地 04:30
    assert.equal(shouldConsolidate({
      sources: [{ kind: 'diary' }], meta: {}, cfg: {}, now: night,
    }).reason, 'quiet-hours');
    assert.equal(shouldConsolidate({
      sources: [{ kind: 'diary' }], meta: {}, cfg: {}, now, force: true,
    }).ok, true);
    ok('shouldConsolidate 六种条件');
  }

  // 3) JSON 解析容忍代码围栏和前后废话
  {
    assert.deepEqual(parseConsolidationResponse('```json\n{"facts":[]}\n```'), { facts: [] });
    assert.deepEqual(parseConsolidationResponse('好的\n{"episodes":[]}\n完'), { episodes: [] });
    assert.equal(parseConsolidationResponse('不是 JSON'), null);
    ok('parseConsolidationResponse 容错');
  }

  // 4) 证据校验：对不上/URL/重复都丢
  {
    const sources = collectSources({ home, nick, since: Date.parse(since), now });
    const v = validateCandidates({
      sources,
      candidates: {
        facts: [
          { text: '主人在杭州出差', confidence: 0.9, evidence: '我下周三要去杭州出差' },
          { text: '主人住在火星', confidence: 0.9, evidence: '我住在火星' },
          { text: '主人爱吃辣', confidence: 0.9, evidence: 'https://example.com' },
          { text: '主人在杭州出差', confidence: 0.9, evidence: '我下周三要去杭州出差' },
        ],
        episodes: [
          { summary: '主人要去杭州', evidence: '我下周三要去杭州出差', tags: ['行程'], importance: 4, valence: 0 },
          { summary: '私人日记的舍不得', evidence: '我有点舍不得', tags: ['心情'], importance: 3, valence: -1 },
        ],
      },
    });
    assert.equal(v.facts.length, 1, '只保留证据对得上的事实');
    assert.equal(v.episodes.length, 2);
    assert.equal(v.episodes[1].visibility, 'private', '私人来源情节标 private');
    assert.ok(v.rejected.length >= 3);
    ok('validateCandidates 证据/URL/去重');
  }

  // 5) 端到端：写回 facts/episodes/meta/index
  {
    resetStore();
    const response = {
      facts: [
        { text: '主人下周三去杭州出差', confidence: 0.9, evidence: '我下周三要去杭州出差' },
        { text: '主人不喜欢吃香菜', confidence: 0.8, evidence: '我其实不太喜欢吃香菜' },
        { text: '主人住在火星', confidence: 0.9, evidence: '我住在火星' },
      ],
      episodes: [
        { summary: '主人下周要去杭州出差', evidence: '我下周三要去杭州出差', tags: ['行程'], importance: 4, valence: 0 },
        { summary: '主人说要去杭州，我舍不得', evidence: '我有点舍不得', tags: ['心情'], importance: 3, valence: -1 },
      ],
      profile_updates: [],
    };
    const r = await runConsolidation({
      home, nick, cfg: {}, now, force: true, lock: false,
      invoke: async () => JSON.stringify(response),
    });
    assert.equal(r.ok, true);
    assert.equal(r.factsAdded, 2);
    assert.equal(r.episodesAdded, 2);
    assert.ok(r.rejected >= 1);
    const store = readMemoryStore(home);
    assert.equal(store.profile.facts.length, 2);
    assert.equal(store.profile.facts.filter((f) => f.text.includes('杭州')).length, 1);
    const priv = store.episodes.find((e) => e.summary.includes('舍不得'));
    assert.equal(priv.visibility, 'private');
    assert.ok(store.meta.lastConsolidatedAt);
    assert.equal(store.meta.lastConsolidation.factsAdded, 2);
    const index = JSON.parse(fs.readFileSync(memoryPaths(home).index, 'utf8'));
    assert.ok(index.terms['杭州'], '索引已重建');
    ok('runConsolidation 端到端写回');
  }

  // 6) 再跑一次：事实更新不重复，情节去重
  {
    const store = readMemoryStore(home);
    writeMeta(home, { ...store.meta, lastConsolidatedAt: since, lastConsolidateAttemptAt: '' });
    const response = {
      facts: [{ text: '主人下周三去杭州出差', confidence: 0.95, evidence: '我下周三要去杭州出差' }],
      episodes: [{ summary: '主人下周要去杭州出差', evidence: '我下周三要去杭州出差', tags: ['行程'], importance: 4, valence: 0 }],
    };
    const r = await runConsolidation({
      home, nick, cfg: {}, now, force: true, lock: false,
      invoke: async () => JSON.stringify(response),
    });
    assert.equal(r.factsAdded, 0);
    assert.equal(r.factsUpdated, 1);
    assert.equal(r.episodesAdded, 0);
    const after = readMemoryStore(home);
    assert.equal(after.profile.facts.length, 2, '事实没有重复');
    ok('重复固化去重');
  }

  // 7) 坏 JSON：不写记忆，但记下尝试时间
  {
    const store = readMemoryStore(home);
    writeMeta(home, { ...store.meta, lastConsolidatedAt: since, lastConsolidateAttemptAt: '' });
    const before = readMemoryStore(home).profile.facts.length;
    const r = await runConsolidation({
      home, nick, cfg: {}, now, force: true, lock: false,
      invoke: async () => '这不是 JSON',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad-json');
    const after = readMemoryStore(home);
    assert.equal(after.profile.facts.length, before);
    assert.equal(after.meta.lastConsolidateError, 'bad-json');
    assert.ok(after.meta.lastConsolidateAttemptAt);
    ok('坏 JSON 不写记忆');
  }

  // 8) 提示词包含编号素材和证据规则
  {
    const sources = collectSources({ home, nick, since: Date.parse(since), now });
    const prompt = buildConsolidationPrompt({ sources });
    assert.match(prompt, /输出严格 JSON/);
    assert.match(prompt, /evidence 必须逐字来自素材/);
    assert.match(prompt, /\[S1\]/);
    ok('固化提示词格式');
  }

  // 9) 低置信度事实进待确认，不进档案
  {
    resetStore();
    const response = {
      facts: [
        { text: '主人出差喜欢靠窗', confidence: 0.7, evidence: '我下周三要去杭州出差' },
        { text: '主人下周三去杭州出差', confidence: 0.9, evidence: '我下周三要去杭州出差' },
      ],
      episodes: [],
    };
    const r = await runConsolidation({
      home, nick, cfg: {}, now, force: true, lock: false,
      invoke: async () => JSON.stringify(response),
    });
    assert.equal(r.ok, true);
    assert.equal(r.factsAdded, 1);
    assert.equal(r.factsPending, 1);
    const store = readMemoryStore(home);
    assert.equal(store.profile.facts.length, 1);
    assert.equal(store.profile.pending.length, 1);
    assert.equal(store.profile.pending[0].text, '主人出差喜欢靠窗');
    const ctx = buildMemoryContext({ home, nick, query: '靠窗' });
    assert.doesNotMatch(ctx.text, /靠窗/, '待确认事实不进提示词');
    ok('低置信度事实进待确认');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
