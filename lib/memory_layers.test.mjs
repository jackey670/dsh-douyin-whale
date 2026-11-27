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
  buildIndex, buildMemoryContext, deleteMemoryItem, ensureMemoryLayers, expandByLinks,
  memoryHealth, memoryLayersStats, memoryOverview, memoryPaths, migrateMemoryLayers,
  pinMemoryFact, readMemoryLinks, readMemoryStore, readRecallTraces, recordRecall,
  rebuildMemoryIndex, resolvePendingFact,
  searchIndex, searchMemory, seedPreferenceFacts, selectEpisodes, tokenize,
  withMemoryLayers, writeMemoryStore,
} from './memory_layers.js';
import { acquireMemoryLock, memoryLockPath } from './memory_lock.js';

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
    // 虚词二元组不进索引：负例误召的根因（「机的」「怎么」命中无关情节）
    const t2 = tokenize('量子退火机的哈密顿量怎么写');
    assert.ok(!t2.includes('机的'), '助词边界二元组要过滤');
    assert.ok(!t2.includes('怎么'), '疑问词二元组要过滤');
    assert.ok(t2.includes('量子'), '内容词保留');
    ok('分词（中文二元组 + 英文/数字 + 虚词过滤）');
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

  // 记忆体检：过期/重复/无引文/断引用/索引失配/积压 逐项可诊断；重建索引后清零
  {
    const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-health-'));
    const now = new Date('2026-11-26T12:00:00+08:00');
    try {
      fs.mkdirSync(path.join(h2, 'memory'), { recursive: true });
      writeMemoryStore(h2, {
        profile: {
          version: 1,
          updatedAt: '2026-11-26T00:00:00.000Z',
          facts: [{
            id: 'f_old', text: '主人换了工作', category: 'fact', confidence: 0.8,
            first_seen: '2026-01-01', last_seen: '2026-01-01', pinned: false,
            superseded_by: '', visibility: 'public',
          }, {
            id: 'f_dup1', text: '主人喜欢咖啡', category: 'preference', confidence: 0.9,
            first_seen: '2026-11-20', last_seen: '2026-11-20', pinned: false,
            superseded_by: '', visibility: 'public',
          }, {
            id: 'f_dup2', text: '主人喜欢咖啡呀', category: 'preference', confidence: 0.7,
            first_seen: '2026-11-21', last_seen: '2026-11-21', pinned: false,
            superseded_by: '', visibility: 'public',
          }],
          pending: [{
            id: 'p_old', text: '主人在学吉他', category: 'preference', confidence: 0.6,
            first_seen: '2026-08-01', last_seen: '2026-08-01', evidence: '', visibility: 'public',
          }],
          relationship: { stage: '', milestones: [] },
        },
        episodes: [{
          id: 'ep_ok', ts: '2026-11-20T12:00:00.000Z', kind: 'chat', summary: '主人加班。',
          evidence: [{ source: 'dm', quote: '又加班了', at: '2026-11-20T12:00:00.000Z' }],
          tags: [], importance: 2, valence: 0, visibility: 'public',
        }, {
          id: 'ep_noev', ts: '2026-11-21T12:00:00.000Z', kind: 'chat', summary: '没有引文的情节。',
          evidence: [], tags: [], importance: 2, valence: 0, visibility: 'public',
        }],
        arcs: {
          version: 1,
          arcs: [{
            id: 'arc_broken', period: '2026-11', title: '断引用', summary: '引用了一条不存在的。',
            episode_ids: ['ep_ok', 'ep_gone'], visibility: 'public', createdAt: '2026-11-22T00:00:00.000Z',
          }],
        },
        meta: { version: 1, migratedAt: '2026-11-01T00:00:00.000Z' },
      }, now);

      // 故意把索引弄失配（docCount 与情节数不一致）
      const idxFile = path.join(h2, 'memory', 'index.json');
      const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
      idx.docCount = 99;
      idx.builtAt = '2026-10-01T00:00:00.000Z';
      fs.writeFileSync(idxFile, JSON.stringify(idx));

      const h = memoryHealth({ home: h2, now });
      const by = (k) => h.issues.find((i) => i.key === k);
      assert.equal(by('staleFacts').count, 1, '只有 f_old 过期');
      assert.equal(by('staleFacts').sample[0].id, 'f_old');
      assert.equal(by('duplicateFacts').count, 1, '喜欢咖啡 vs 喜欢咖啡呀 是重复');
      assert.equal(by('episodesNoEvidence').count, 1);
      assert.equal(by('arcBrokenRefs').count, 1);
      assert.equal(by('indexStale').count, 1);
      assert.equal(by('pendingBacklog').count, 1);
      assert.match(by('pendingBacklog').detail, /天/);

      const re = rebuildMemoryIndex({ home: h2, now });
      assert.equal(re.ok, true);
      assert.equal(re.episodes, 2);
      const h2b = memoryHealth({ home: h2, now });
      assert.equal(h2b.issues.find((i) => i.key === 'indexStale').count, 0, '重建后索引不再失配');
      ok('记忆体检六项诊断 + 重建索引');
    } finally {
      try { fs.rmSync(h2, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // 回忆轨迹：强化 + 共现边 + trace；持锁时必须跳过而不是覆盖
  {
    const h3 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-recall-'));
    const t0 = new Date('2026-11-26T10:00:00.000Z');
    try {
      writeMemoryStore(h3, {
        profile: { version: 1, facts: [], pending: [], relationship: { stage: '', milestones: [] } },
        episodes: ['ep_1', 'ep_2', 'ep_3'].map((id) => ({
          id, ts: '2026-11-20T12:00:00.000Z', kind: 'chat', summary: `情节 ${id}`,
          evidence: [{ source: 'dm', quote: `原话 ${id}` }], tags: [], importance: 2,
          valence: 0, visibility: 'public', uses: 0, last_used_at: '',
        })),
        arcs: { version: 1, arcs: [] },
        meta: { version: 1 },
      }, t0);

      // 空输入：什么都不写
      const none = recordRecall({ home: h3, ids: [], now: t0 });
      assert.equal(none.ok, true);
      assert.equal(none.reinforced, 0);
      assert.ok(!fs.existsSync(memoryPaths(h3).traces), '空输入不创建 traces 文件');
      assert.ok(!fs.existsSync(memoryPaths(h3).links), '空输入不创建 links 文件');

      const ghost = recordRecall({ home: h3, ids: ['ep_missing'], now: t0 });
      assert.equal(ghost.ok, true);
      assert.equal(ghost.trace, null, '全部 id 都不存在时不算一次想起');
      assert.ok(!fs.existsSync(memoryPaths(h3).traces), '幽灵 id 不创建 traces 文件');
      assert.ok(!fs.existsSync(memoryPaths(h3).links), '幽灵 id 不创建 links 文件');

      const r1 = recordRecall({ home: h3, ids: ['ep_1', 'ep_2', 'ep_2', 'ep_missing'], trigger: 'watch', now: t0 });
      assert.equal(r1.ok, true);
      assert.equal(r1.reinforced, 2, '只强化存在的情节，重复 id 去重');
      assert.equal(r1.links, 1, '两条有效记忆 → 1 条共现边');
      let eps = readMemoryStore(h3).episodes;
      assert.equal(eps.find((e) => e.id === 'ep_1').uses, 1);
      assert.equal(eps.find((e) => e.id === 'ep_1').last_used_at, t0.toISOString());
      assert.equal(eps.find((e) => e.id === 'ep_3').uses, 0, '没被想起的不动');
      let links = readMemoryLinks(h3);
      assert.equal(links.length, 1);
      assert.deepEqual([links[0].a, links[0].b], ['ep_1', 'ep_2'], '无向边按 a<b 归一');
      assert.equal(links[0].kind, 'co_recall');
      assert.equal(links[0].w, 0.2);

      // 再次同现：权重 +0.05，最多 6 条 → C(3,2)=3 条边
      const t1 = new Date('2026-11-26T11:00:00.000Z');
      recordRecall({ home: h3, ids: ['ep_1', 'ep_2', 'ep_3'], now: t1 });
      links = readMemoryLinks(h3);
      assert.equal(links.length, 3);
      const l12 = links.find((l) => l.a === 'ep_1' && l.b === 'ep_2');
      assert.ok(Math.abs(l12.w - 0.25) < 1e-9, '同现边权重递增');
      eps = readMemoryStore(h3).episodes;
      assert.equal(eps.find((e) => e.id === 'ep_1').uses, 2);

      // 封顶 0.8
      for (let i = 0; i < 20; i += 1) {
        recordRecall({ home: h3, ids: ['ep_1', 'ep_2'], now: new Date(t1.getTime() + i + 1) });
      }
      links = readMemoryLinks(h3);
      assert.ok(links.find((l) => l.a === 'ep_1' && l.b === 'ep_2').w <= 0.8, '共现权重封顶 0.8');

      // 轨迹：只存 id，不存正文；新的在前。limit 要够大才能覆盖到最旧那条 watch
      const traces = readRecallTraces({ home: h3, limit: 100 });
      assert.ok(traces.length >= 3);
      assert.ok(traces[0].at >= traces[traces.length - 1].at, '新的在前');
      assert.deepEqual(traces[traces.length - 1].ids, ['ep_1', 'ep_2']);
      assert.equal(traces[traces.length - 1].trigger, 'watch');
      assert.equal(traces[0].trigger, 'prompt', '后面几次没传 trigger，默认 prompt');
      // limit 生效：只取最近 N 条
      assert.equal(readRecallTraces({ home: h3, limit: 3 }).length, 3);
      const traceRaw = fs.readFileSync(memoryPaths(h3).traces, 'utf8');
      assert.ok(!traceRaw.includes('原话'), 'trace 不含任何正文');
      assert.ok(!traceRaw.includes('情节 ep_1'), 'trace 不含摘要');
      ok('recordRecall：强化 / 共现边 / 轨迹（不含正文）');

      // 持锁期间：固化会整库重写，recordRecall 不能拿旧快照覆盖 → 整次跳过
      const usesOf = (id) => readMemoryStore(h3).episodes.find((e) => e.id === id).uses;
      const release = acquireMemoryLock(h3, new Date());
      assert.ok(release, '测试自己先拿到锁');
      assert.ok(fs.existsSync(memoryLockPath(h3)), '锁文件在 memory 目录');
      const before = readMemoryStore(h3).episodes.map((e) => e.uses);
      const busy = recordRecall({ home: h3, ids: ['ep_1', 'ep_2'], now: new Date() });
      assert.equal(busy.ok, false);
      assert.equal(busy.reason, 'busy');
      const after = readMemoryStore(h3).episodes.map((e) => e.uses);
      assert.deepEqual(after, before, '持锁时不改 episodes');

      release();
      assert.ok(!fs.existsSync(memoryLockPath(h3)), 'release 删掉锁文件');
      // 用相对断言：成功写入恰好 +1，不依赖前面各步累计了几次
      const u3 = usesOf('ep_3');
      const okAgain = recordRecall({ home: h3, ids: ['ep_3'], now: new Date() });
      assert.equal(okAgain.ok, true, '释放后可正常写入');
      assert.equal(usesOf('ep_3'), u3 + 1, '释放后写入 → +1');

      // 陈旧锁（持有者进程不存在）应被清掉重试
      fs.writeFileSync(memoryLockPath(h3), JSON.stringify({ pid: 99999999 }));
      const stale = recordRecall({ home: h3, ids: ['ep_3'], now: new Date() });
      assert.equal(stale.ok, true, '陈旧锁不阻塞');
      assert.equal(usesOf('ep_3'), u3 + 2, '陈旧锁自愈后写入 → 再 +1');
      assert.ok(!fs.existsSync(memoryLockPath(h3)), '陈旧锁用完也会释放');
      ok('recordRecall 与固化锁：busy 跳过 / 陈旧锁自愈');
    } finally {
      try { fs.rmSync(h3, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ── 图扩散召回（v1.20.0，默认关）：co_recall 邻居补进【相关回忆】──
  {
    const h4 = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-expand-'));
    try {
      const t = new Date('2026-11-26T12:00:00.000Z');
      const mkEp = (i, summary, visibility = 'public') => ({
        id: `ep_${i}`, ts: `2026-11-${10 + i}T12:00:00.000Z`, kind: 'chat',
        summary, evidence: [{ source: 'dm', quote: `原话 ${i}` }], tags: [],
        importance: 2, valence: 0, visibility,
      });
      writeMemoryStore(h4, {
        profile: { version: 1, facts: [], pending: [], relationship: {} },
        episodes: [
          mkEp(1, '主人聊起加班的事'), mkEp(2, '主人聊起咖啡口味'),
          mkEp(3, '主人感冒嗓子疼'), mkEp(4, '周末一起去看海'),
        ],
        arcs: { version: 1, arcs: [] },
        meta: { version: 1, migratedAt: t.toISOString() },
      }, t);
      // 学出来的共现边：加班 ↔ 感冒嗓子疼 / 看海（文本上不相似，靠共现连起来）
      fs.writeFileSync(memoryPaths(h4).links, [
        JSON.stringify({ a: 'ep_1', b: 'ep_3', kind: 'co_recall', w: 0.4 }),
        JSON.stringify({ a: 'ep_1', b: 'ep_4', kind: 'co_recall', w: 0.3 }),
      ].join('\n') + '\n', 'utf8');

      // 纯函数：种子命中才扩散，已选/私人不进
      assert.deepEqual(
        expandByLinks({ home: h4, seeds: [], episodes: [] }),
        [], '没有种子不扩散',
      );

      const base = buildMemoryContext({ home: h4, nick, query: '加班', now: t });
      assert.ok(base.used.includes('ep_1'), '基线召回 ep_1');
      assert.ok(!base.used.includes('ep_3'), '不开扩散不带共现邻居');
      assert.equal(base.stats.expanded, 0);

      const exp1 = buildMemoryContext({
        home: h4, nick, query: '加班', now: t, expand: { max: 1 },
      });
      assert.ok(exp1.used.includes('ep_3'), '开扩散补回共现邻居');
      assert.ok(!exp1.used.includes('ep_4'), 'max=1 只取权重最高的一条');
      assert.equal(exp1.stats.expanded, 1);
      assert.match(exp1.text, /主人感冒嗓子疼.*（联想到）/, '扩散行带标记');

      const exp2 = buildMemoryContext({
        home: h4, nick, query: '加班', now: t, expand: { max: 2 },
      });
      assert.ok(exp2.used.includes('ep_3') && exp2.used.includes('ep_4'), 'max=2 两条都进');
      assert.equal(exp2.used.length, 3, '4 条上限 + 2 条扩散 = 6 以内');

      // 私人邻居：默认挡住，includePrivate 才放行
      writeMemoryStore(h4, {
        profile: { version: 1, facts: [], pending: [], relationship: {} },
        episodes: [
          mkEp(1, '主人聊起加班的事'), mkEp(2, '主人聊起咖啡口味'),
          mkEp(3, '主人感冒嗓子疼'), mkEp(4, '周末一起去看海', 'private'),
        ],
        arcs: { version: 1, arcs: [] },
        meta: { version: 1, migratedAt: t.toISOString() },
      }, t);
      const noPriv = buildMemoryContext({
        home: h4, nick, query: '加班', now: t, expand: { max: 2 },
      });
      assert.ok(!noPriv.used.includes('ep_4'), '私人邻居默认不扩散');
      const withPriv = buildMemoryContext({
        home: h4, nick, query: '加班', now: t, expand: { max: 2 }, includePrivate: true,
      });
      assert.ok(withPriv.used.includes('ep_4'), 'includePrivate 才放行');
      ok('图扩散召回：co_recall 邻居 / 上限 / 私人过滤');
    } finally {
      try { fs.rmSync(h4, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log(`\nALL PASSED (${pass})`);
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}
