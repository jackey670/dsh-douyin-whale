/**
 * lib/memory_layers.test.mjs —— 四层记忆的迁移、索引、检索与预算。
 *
 * 运行：node lib/memory_layers.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  buildIndex, buildMemoryContext, deleteMemoryItem, ensureMemoryLayers,
  memoryLayersStats, memoryOverview, memoryPaths, migrateMemoryLayers,
  pinMemoryFact, readMemoryStore, resolvePendingFact, searchIndex, searchMemory,
  seedPreferenceFacts, selectEpisodes, tokenize, withMemoryLayers, writeMemoryStore,
} from './memory_layers.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memory-'));
const nick = '测试主人';
const paths = memoryPaths(home);
let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

try {
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(path.join(paths.dir, `dm-${nick}.json`), JSON.stringify({
    who: { nick },
    updatedAt: '2026-11-07T00:00:00.000Z',
    rounds: 2,
    facts: ['主人在赶项目', '主人喜欢宠物'],
    messages: [
      { at: '2026-11-06T13:00:00.000Z', from: 'them', text: '这周天天加班到十点', kind: 'text' },
      { at: '2026-11-06T13:05:00.000Z', from: 'me', text: '辛苦啦，早点睡', kind: 'text' },
      { at: '2026-11-07T02:00:00.000Z', from: 'them', text: '周末去看了海', kind: 'text' },
      { at: '2026-11-07T02:05:00.000Z', from: 'me', text: '拍照片了吗', kind: 'text' },
    ],
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(home, 'whale-diary.md'), [
    '## 2026-11-06 · 22:10（值班轮）',
    '今天主人说加班，听着有点累。',
    '',
    '## 2026-11-07 · 09:00（值班轮）',
    '早上看了鲸鱼视频，挺开心的。',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(home, 'whale-diary-private.md'), [
    '## 2026-11-06 · 22:30（值班轮）',
    '我有点心疼主人，想多陪他说两句。',
    '',
  ].join('\n'), 'utf8');

  // 1) 分词：中文二元组 + 英文词
  {
    const t = tokenize('加班 projectAI 2026');
    assert.ok(t.includes('加班'), '中文二元组');
    assert.ok(t.includes('projectai'), '英文词');
    assert.ok(t.includes('2026'), '数字词');
    ok('分词（中文二元组 + 英文/数字）');
  }

  // 2) 迁移：2 天聊天 + 3 节日记 = 5 条情节，2 条事实
  {
    const r = migrateMemoryLayers({ home, nick });
    assert.equal(r.ok, true);
    assert.equal(r.episodes, 5);
    assert.equal(r.facts, 2);
    const eps = fs.readFileSync(paths.episodes, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(eps.length, 5);
    assert.ok(eps.some((e) => e.kind === 'chat'));
    assert.ok(eps.some((e) => e.tags.includes('日记')));
    assert.ok(eps.some((e) => e.tags.includes('私人日记')));
    assert.ok(eps.some((e) => e.visibility === 'private'), '私人日记标 private');
    assert.ok(eps.some((e) => e.visibility === 'public'), '普通情节标 public');
    assert.ok(eps.every((e) => e.evidence.length > 0), '每条都有原话证据');
    const profile = JSON.parse(fs.readFileSync(paths.profile, 'utf8'));
    assert.equal(profile.facts.length, 2);
    ok('迁移 dm 消息 + 两本日记 → episodes/profile');
  }

  // 3) 幂等：再跑一次不重复
  {
    const again = migrateMemoryLayers({ home, nick });
    assert.equal(again.skipped, true);
    const n = fs.readFileSync(paths.episodes, 'utf8').trim().split('\n').length;
    assert.equal(n, 5);
    ok('迁移幂等');
  }

  // 4) 索引与检索
  {
    const eps = fs.readFileSync(paths.episodes, 'utf8').trim().split('\n').map(JSON.parse);
    const index = buildIndex(eps);
    assert.ok(Object.keys(index.terms).includes('加班'));
    const hits = searchIndex(index, '加班');
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].relevance > 0);
    const picked = selectEpisodes({ episodes: eps, index, query: '加班', limit: 2 });
    assert.ok(picked.length >= 1);
    assert.ok(picked[0].summary.includes('加班'));
    ok('倒排索引命中「加班」');
  }

  // 5) 记忆块：档案 + 相关回忆 + 预算
  {
    const ctx = buildMemoryContext({ home, nick, query: '加班' });
    assert.match(ctx.text, /【主人档案】/);
    assert.match(ctx.text, /【相关回忆】/);
    assert.match(ctx.text, /加班/);
    assert.ok(ctx.used.length >= 1);
    assert.ok(ctx.stats.chars <= 1000);
    const tiny = buildMemoryContext({ home, nick, query: '加班', budgetChars: 40 });
    assert.ok(tiny.text.length <= 40, `预算 40，实际 ${tiny.text.length}`);
    ok('记忆块（档案/回忆/预算）');
  }

  // 6) 私人日记默认不注入；显式 includePrivate 才参与
  {
    const normal = buildMemoryContext({ home, nick, query: '心疼' });
    assert.equal(normal.used.length, 0, '默认不召回私人日记');
    const priv = buildMemoryContext({ home, nick, query: '心疼', includePrivate: true });
    assert.ok(priv.used.length >= 1, '显式允许时能召回');
    ok('私人日记默认过滤');
  }

  // 7) withMemoryLayers 挂到 mem 上并打日志
  {
    const logs = [];
    const mem = withMemoryLayers({
      home, nick, query: '加班', mem: { recent: [] }, log: (m) => logs.push(m),
    });
    assert.ok(mem.layers.includes('【相关回忆】'));
    assert.ok(logs.some((m) => m.includes('注入')));
    assert.equal(mem.recent.length, 0, '原有 mem 字段保留');
    ok('withMemoryLayers 挂载 + 日志只记条数');
  }

  // 7) 统计与 ensure
  {
    const st = memoryLayersStats(home);
    assert.equal(st.episodes, 5);
    assert.equal(st.profile, 2);
    assert.ok(st.terms > 0);
    assert.ok(st.migratedAt);
    assert.ok(st.bytes > 0);
    const ensured = ensureMemoryLayers({ home, nick });
    assert.equal(ensured.migrated, false);
    ok('统计 + ensureMemoryLayers 幂等');
  }

  // 9) 私人事实默认不注入
  {
    const store = JSON.parse(fs.readFileSync(paths.profile, 'utf8'));
    store.facts.push({
      id: 'f_priv', text: '测试私人事实', category: 'fact',
      confidence: 1, visibility: 'private',
    });
    fs.writeFileSync(paths.profile, JSON.stringify(store), 'utf8');
    const off = buildMemoryContext({ home, nick, query: '' });
    assert.doesNotMatch(off.text, /测试私人事实/);
    const on = buildMemoryContext({ home, nick, query: '', includePrivate: true });
    assert.match(on.text, /测试私人事实/);
    ok('私人事实默认不注入');
  }

  // 11) 偏好初始化：置顶事实、幂等、跳过重复
  {
    const cfg = { preferences: { like: ['宠物', '咖啡'], dislike: ['剧透'] } };
    const r1 = seedPreferenceFacts({ home, cfg });
    assert.equal(r1.ok, true);
    assert.equal(r1.added, 2, '宠物已存在，只加咖啡和剧透');
    const r2 = seedPreferenceFacts({ home, cfg });
    assert.equal(r2.added, 0);
    const store = readMemoryStore(home);
    const coffee = store.profile.facts.find((f) => f.text === '主人喜欢咖啡');
    assert.ok(coffee && coffee.pinned && coffee.source === 'config');
    assert.ok(store.profile.facts.some((f) => f.text === '主人不喜欢剧透'));
    ok('偏好初始化（置顶/幂等/去重）');
  }

  // 12) 搜索：事实 + 情节，不返回证据原文；私人条目默认过滤
  {
    const s = searchMemory({ home, q: '加班' });
    assert.ok(s.episodes.length >= 1);
    assert.ok(s.episodes[0].summary.includes('加班'));
    assert.ok(!('quote' in s.episodes[0]), '搜索结果不返回原话');
    const coffee = searchMemory({ home, q: '咖啡' });
    assert.ok(coffee.facts.some((f) => f.text.includes('咖啡')));
    const off = searchMemory({ home, q: '私人日记' });
    assert.ok(off.episodes.every((e) => !e.private), '默认不返回私人情节');
    const on = searchMemory({ home, q: '私人日记', includePrivate: true });
    assert.ok(on.episodes.some((e) => e.private), '显式允许时返回私人情节');
    ok('searchMemory（事实/情节/私人过滤）');
  }

  // 13) 置顶 + 删除（事实软删、情节移出 jsonl、原文不动）
  {
    const fact = searchMemory({ home, q: '咖啡' }).facts[0];
    const pinned = pinMemoryFact({ home, id: fact.id, pinned: true });
    assert.equal(pinned.pinned, true);
    assert.ok(memoryOverview({ home }).facts.some((f) => f.id === fact.id && f.pinned));
    const delF = deleteMemoryItem({ home, id: fact.id });
    assert.equal(delF.kind, 'fact');
    assert.ok(!searchMemory({ home, q: '咖啡' }).facts.some((f) => f.id === fact.id));
    assert.doesNotMatch(buildMemoryContext({ home, nick, query: '咖啡' }).text, /主人喜欢咖啡/);

    const ep = searchMemory({ home, q: '加班' }).episodes[0];
    const delE = deleteMemoryItem({ home, id: ep.id });
    assert.equal(delE.kind, 'episode');
    assert.ok(!searchMemory({ home, q: '加班' }).episodes.some((e) => e.id === ep.id));
    assert.ok(fs.existsSync(path.join(paths.dir, `dm-${nick}.json`)), '原始私信文件还在');
    ok('置顶/删除（事实软删 + 情节移除 + 原文保留）');
  }

  // 14) 待确认：采纳进档案
  {
    const store = readMemoryStore(home);
    store.profile.pending = [{
      id: 'p_test_01', text: '主人喜欢潜水', category: 'preference', confidence: 0.7,
      first_seen: '2026-11-13', last_seen: '2026-11-13', evidence: '', visibility: 'public',
    }];
    writeMemoryStore(home, { ...store, meta: store.meta || {} });
    const r = resolvePendingFact({ home, id: 'p_test_01', action: 'accept' });
    assert.ok(r.fact);
    assert.equal(r.fact.text, '主人喜欢潜水');
    const after = readMemoryStore(home);
    assert.ok(!(after.profile.pending || []).some((p) => p.id === 'p_test_01'));
    assert.ok(after.profile.facts.some((f) => f.text === '主人喜欢潜水'));
    ok('待确认事实采纳');
  }

  // 15) 周反思注入：公开 arc 进【最近这几周】，私人默认不注入
  {
    const store = readMemoryStore(home);
    store.arcs = {
      version: 1,
      updatedAt: '2026-11-14T00:00:00.000Z',
      arcs: [{
        id: 'arc_pub', period: '2026-11-08 ~ 2026-11-14', title: '赶项目的一周',
        summary: '主人连续加班，周末才缓过来。', episode_ids: ['ep_x'],
        visibility: 'public', createdAt: '2026-11-14T00:00:00.000Z',
      }, {
        id: 'arc_priv', period: '2026-11-08 ~ 2026-11-14', title: '偷偷心疼',
        summary: '大肥鱼心疼主人加班。', episode_ids: ['ep_y'],
        visibility: 'private', createdAt: '2026-11-13T00:00:00.000Z',
      }],
    };
    writeMemoryStore(home, { ...store, meta: store.meta || {} });
    const ctx = buildMemoryContext({ home, nick, query: '' });
    assert.match(ctx.text, /【最近这几周】/);
    assert.match(ctx.text, /赶项目的一周/);
    assert.doesNotMatch(ctx.text, /偷偷心疼/);
    assert.equal(ctx.stats.arcs, 1);
    const inc = buildMemoryContext({ home, nick, query: '', includePrivate: true });
    assert.match(inc.text, /偷偷心疼/);
    ok('周反思注入（公开/私人过滤）');
  }

  // 10) 没有记忆时返回空块，不抛错
  {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memory-empty-'));
    try {
      const ctx = buildMemoryContext({ home: emptyHome, nick: '', query: '随便' });
      assert.equal(ctx.text, '');
      assert.equal(ctx.used.length, 0);
      assert.ok(fs.existsSync(memoryPaths(emptyHome).meta), '空迁移也写 meta');
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
    ok('空记忆返回空块');
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
