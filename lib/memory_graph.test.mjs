/**
 * lib/memory_graph.test.mjs —— 记忆星图：节点/边/强度/隐私/上限/确定性。
 *
 * 运行：node lib/memory_graph.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { memoryGraph, parseTraits, starStrength } from './memory_graph.js';
import { recordRecall, writeMemoryStore } from './memory_layers.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-graph-'));
const now = new Date('2026-11-26T12:00:00+08:00');
let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

try {
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  writeMemoryStore(home, {
    profile: {
      version: 1,
      updatedAt: '2026-11-26T00:00:00.000Z',
      facts: [{
        id: 'f_pub', text: '主人喜欢咖啡', category: 'preference', confidence: 0.9,
        first_seen: '2026-11-20', last_seen: '2026-11-20', pinned: true,
        superseded_by: '', visibility: 'public',
      }, {
        id: 'f_work', text: '主人最近总在加班', category: 'fact', confidence: 0.8,
        first_seen: '2026-11-20', last_seen: '2026-11-21', pinned: false,
        superseded_by: '', visibility: 'public',
      }, {
        id: 'f_old', text: '主人换了工作', category: 'fact', confidence: 0.8,
        first_seen: '2026-01-01', last_seen: '2026-01-01', pinned: false,
        superseded_by: 'f_new', visibility: 'public',
      }, {
        id: 'f_new', text: '主人在学吉他', category: 'fact', confidence: 0.8,
        first_seen: '2026-11-21', last_seen: '2026-11-21', pinned: false,
        superseded_by: '', visibility: 'public',
      }, {
        id: 'f_priv', text: '主人的生日在冬天', category: 'fact', confidence: 0.7,
        first_seen: '2026-11-22', last_seen: '2026-11-22', pinned: false,
        superseded_by: '', visibility: 'private',
      }],
      pending: [],
      relationship: {
        stage: '熟悉',
        milestones: [
          { at: '2026-11-20', text: '第一次聊到很晚', episode_id: 'ep_a' },
          { at: '2026-11-24', text: '日记里的小心事', episode_id: 'ep_priv' },
          { at: '2026-11-25', text: '悬空的纪念', episode_id: 'ep_gone' },
        ],
      },
    },
    episodes: [{
      id: 'ep_a', ts: '2026-11-20T12:00:00.000Z', kind: 'chat',
      summary: '主人加班到很晚，聊了会儿天。', tags: ['加班', '私信'],
      evidence: [{ source: 'dm', quote: '今天又加班到十点', at: '2026-11-20T12:00:00.000Z' }],
      importance: 3, valence: -1, visibility: 'public',
    }, {
      id: 'ep_b', ts: '2026-11-21T12:00:00.000Z', kind: 'chat',
      summary: '主人又加班了，给他打气。', tags: ['加班'],
      evidence: [{ source: 'dm', quote: '这周第三次加班', at: '2026-11-21T12:00:00.000Z' }],
      importance: 2, valence: -1, visibility: 'public',
    }, {
      id: 'ep_c', ts: '2026-11-22T12:00:00.000Z', kind: 'chat',
      summary: '周末去看了海，风很大。', tags: ['看海'],
      evidence: [{ source: 'dm', quote: '周末去看了海', at: '2026-11-22T12:00:00.000Z' }],
      importance: 3, valence: 1, visibility: 'public',
    }, {
      id: 'ep_d', ts: '2026-11-23T12:00:00.000Z', kind: 'chat',
      summary: '主人换了新工作，替他高兴。', tags: ['工作'],
      evidence: [{ source: 'dm', quote: '我换工作了', at: '2026-11-23T12:00:00.000Z' }],
      importance: 4, valence: 1, visibility: 'public',
    }, {
      id: 'ep_priv', ts: '2026-11-24T12:00:00.000Z', kind: 'diary',
      summary: '私人：很想主人。', tags: ['私人日记'],
      evidence: [{ source: 'diary', quote: '今天特别想主人', at: '2026-11-24T12:00:00.000Z' }],
      importance: 3, valence: 1, visibility: 'private',
    }],
    arcs: {
      version: 1,
      updatedAt: '2026-11-24T00:00:00.000Z',
      arcs: [{
        id: 'arc_1', period: '2026-11-17 ~ 2026-11-23', title: '赶项目的一周',
        summary: '主人连续加班，周末才缓过来。', episode_ids: ['ep_a', 'ep_b', 'ep_gone'],
        visibility: 'public', createdAt: '2026-11-23T00:00:00.000Z',
      }],
    },
    meta: { version: 1, migratedAt: '2026-11-01T00:00:00.000Z' },
  }, now);

  const persona = {
    name: '大肥鱼',
    ownerTitle: '主人',
    text: '性格：好奇、嘴硬心软\n喜欢：白饭、魔方\n不喜欢：被敷衍\n说话：短句为主',
  };
  const preferences = { like: ['咖啡'], dislike: [] };

  // 1) 默认不出现私人节点；节点/主题/边齐全
  {
    const g = memoryGraph({
      home, now, persona, owner: { nickname: '测试主人' }, preferences,
      mood: { energy: 70, social: 40, boredom: 30, label: '平静' },
    });
    const ids = new Set(g.nodes.map((n) => n.id));
    assert.equal(g.ok, true);
    assert.ok(ids.has('self') && ids.has('owner'));
    assert.ok(ids.has('mood'), '带心情时生成心情星');
    const moodNode = g.nodes.find((n) => n.id === 'mood');
    assert.equal(moodNode.type, 'mood');
    assert.equal(moodNode.state, 'pinned');
    assert.match(moodNode.sub, /精力 70 · 想念 40 · 无聊 30/);
    assert.ok(g.edges.some((e) => e.kind === 'core' && [e.a, e.b].includes('mood')));
    assert.ok(ids.has('ep_a') && ids.has('ep_b') && ids.has('ep_c') && ids.has('ep_d'));
    assert.ok(!ids.has('ep_priv'), '私人情节默认不出现');
    assert.ok(!ids.has('f_priv'), '私人事实默认不出现');
    assert.ok(ids.has('topic:加班'), '共享标签生成主题星');
    assert.ok(ids.has('arc_1'));
    assert.ok(ids.has('milestone:0') && ids.has('milestone:2'), '公开/悬空里程碑进图');
    assert.ok(!ids.has('milestone:1'), '引用私人情节的里程碑默认不出现');
    const ownerNode = g.nodes.find((n) => n.id === 'owner');
    assert.match(ownerNode.detail, /关系阶段：熟悉/);
    assert.ok(g.edges.some((e) => e.kind === 'about'
      && [e.a, e.b].includes('owner') && [e.a, e.b].includes('milestone:0')), '主人→里程碑');
    assert.ok(g.edges.some((e) => e.kind === 'evidence'
      && [e.a, e.b].includes('milestone:0') && [e.a, e.b].includes('ep_a')), '里程碑→情节');
    assert.ok(!g.edges.some((e) => [e.a, e.b].includes('milestone:2') && [e.a, e.b].includes('ep_gone')),
      '悬空里程碑不连边');
    assert.equal(g.stats.nodes.episode, 4);
    assert.equal(g.stats.nodes.fact, 4);
    assert.equal(g.stats.nodes.arc, 1);
    assert.ok(g.edges.some((e) => e.kind === 'part_of'
      && ((e.a === 'ep_a' && e.b === 'arc_1') || (e.b === 'ep_a' && e.a === 'arc_1'))));
    assert.ok(g.edges.some((e) => e.kind === 'part_of'
      && [e.a, e.b].includes('ep_b') && [e.a, e.b].includes('arc_1')));
    assert.ok(g.edges.some((e) => e.kind === 'related'
      && [e.a, e.b].includes('ep_a') && [e.a, e.b].includes('ep_b')), '相似情节连线');
    assert.ok(g.edges.some((e) => e.kind === 'supersedes' && e.a === 'f_old' && e.b === 'f_new'));
    assert.ok(g.edges.some((e) => e.kind === 'evidence'
      && e.a === 'f_work' && [e.a, e.b].includes('ep_a')), '事实→情节证据边');
    assert.ok(g.nodes.every((n) => Number.isFinite(n.degree)));
    ok('节点/主题/叙事/相似/取代/证据边');
  }

  // 2) 隐私：不下发原话；includePrivate 才带私人节点
  {
    const g = memoryGraph({ home, now, persona, preferences });
    const raw = JSON.stringify(g);
    assert.ok(!raw.includes('今天又加班到十点'), '引文原话不能进图');
    assert.ok(!raw.includes('这周第三次加班'));
    assert.ok(!raw.includes('今天特别想主人'));
    const priv = memoryGraph({ home, now, persona, preferences, includePrivate: true });
    const ids = new Set(priv.nodes.map((n) => n.id));
    assert.ok(ids.has('ep_priv') && ids.has('f_priv'));
    assert.ok(ids.has('milestone:1'), 'includePrivate 时私人里程碑才出现');
    assert.equal(priv.nodes.find((n) => n.id === 'ep_priv').private, true);
    assert.ok(priv.stats.includePrivate);
    ok('隐私门（默认过滤 + 原话不进图 + includePrivate）');
  }

  // 3) 上限与截断
  {
    const g = memoryGraph({ home, now, persona, maxEpisodes: 2 });
    assert.equal(g.stats.nodes.episode, 2);
    assert.equal(g.stats.available.episodes, 4);
    assert.equal(g.stats.truncated.episodes, true);
    const g2 = memoryGraph({ home, now, persona, minSim: 0.99 });
    assert.ok(!g2.edges.some((e) => e.kind === 'related'), '阈值调高后没有相似边');
    ok('上限/截断/相似阈值');
  }

  // 4) 人设拆性格星 + core 边
  {
    const g = memoryGraph({ home, now, persona, preferences });
    const traits = g.nodes.filter((n) => n.type === 'trait');
    assert.ok(traits.length >= 4);
    assert.ok(traits.some((t) => t.label === '嘴硬心软' && t.traitKind === 'trait'));
    assert.ok(traits.some((t) => t.label === '咖啡' && t.traitKind === 'like'));
    assert.ok(traits.some((t) => t.label === '被敷衍' && t.traitKind === 'dislike'));
    assert.ok(g.edges.filter((e) => e.kind === 'core' && e.a === 'self'
      && e.b.startsWith('trait:')).length === traits.length);
    assert.ok(g.edges.some((e) => e.kind === 'core' && e.a === 'self' && e.b === 'owner'));
    assert.deepEqual(parseTraits('喜欢：A、B\n不喜欢：C'), [
      { kind: 'like', label: 'A' }, { kind: 'like', label: 'B' }, { kind: 'dislike', label: 'C' },
    ]);
    ok('人设 → 性格星 + core 边');
  }

  // 5) 强度：置顶恒亮，旧记忆变暗，重要/情绪延长半衰期
  {
    const pinned = starStrength({ importance: 3, pinned: true, ts: '2020-01-01', now: now.getTime() });
    assert.equal(pinned.state, 'pinned');
    assert.equal(pinned.strength, 1);
    const fresh = starStrength({ importance: 4, ts: '2026-11-25', now: now.getTime() });
    const old = starStrength({ importance: 4, ts: '2026-08-01', now: now.getTime() });
    assert.ok(fresh.strength > old.strength);
    const calm = starStrength({ importance: 3, valence: 0, ts: '2026-10-01', now: now.getTime() });
    const emotional = starStrength({ importance: 3, valence: 2, ts: '2026-10-01', now: now.getTime() });
    assert.ok(emotional.strength > calm.strength, '情绪强的记得更久');
    ok('星等衰减（置顶/新鲜/情绪半衰期）');
  }

  // 6) 确定性：同一时刻两次构建完全一致
  {
    const a = memoryGraph({ home, now, persona, preferences });
    const b = memoryGraph({ home, now, persona, preferences });
    assert.deepEqual(a, b);
    assert.equal(a.generatedAt, now.toISOString());
    ok('确定性构建');
  }

  // 7) 强化：被想起过的记忆从 last_used_at 重新起算、亮度更高；共现边进图
  {
    const base = starStrength({
      importance: 3, valence: 0, ts: '2026-09-01T12:00:00.000Z', now: now.getTime(),
    });
    const boosted = starStrength({
      importance: 3, valence: 0, ts: '2026-09-01T12:00:00.000Z',
      uses: 3, lastUsedAt: '2026-11-25T12:00:00.000Z', now: now.getTime(),
    });
    assert.ok(boosted.strength > base.strength + 0.2, '想起过的星明显更亮');
    // 只有 uses 没有 last_used_at 时，仍从创建时间衰减，只是起点略高
    const usesOnly = starStrength({
      importance: 3, valence: 0, ts: '2026-09-01T12:00:00.000Z', uses: 3, now: now.getTime(),
    });
    assert.ok(usesOnly.strength >= base.strength, 'uses 抬高起点');
    assert.ok(usesOnly.strength < boosted.strength, '时钟归零比单纯抬起点更强');

    const rec = recordRecall({
      home, ids: ['ep_a', 'ep_c'], trigger: 'test', now,
    });
    assert.equal(rec.ok, true);
    assert.equal(rec.links, 1);
    const g = memoryGraph({ home, now, persona, preferences });
    assert.ok(g.edges.some((e) => e.kind === 'co_recall'
      && [e.a, e.b].includes('ep_a') && [e.a, e.b].includes('ep_c')), '共现边进星图');
    const epA = g.nodes.find((n) => n.id === 'ep_a');
    assert.equal(epA.uses, 1, '节点带想起次数');
    assert.match(epA.sub, /想起 1 次/);
    ok('强化亮度 + 共现边进图');
  }
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nALL PASSED (${pass})`);
