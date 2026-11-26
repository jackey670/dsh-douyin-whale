/**
 * lib/memory_think.test.mjs —— 思维链：种子/问题匹配、逐跳扩散、隐私、上限、确定性。
 *
 * 运行：node lib/memory_think.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { memoryGraph } from './memory_graph.js';
import { thinkChain } from './memory_think.js';
import { writeMemoryStore } from './memory_layers.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-think-'));
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
        id: 'f_work', text: '主人最近总在加班', category: 'fact', confidence: 0.8,
        first_seen: '2026-11-20', last_seen: '2026-11-21', pinned: false,
        superseded_by: '', visibility: 'public',
      }, {
        id: 'f_priv', text: '主人的生日在冬天', category: 'fact', confidence: 0.7,
        first_seen: '2026-11-22', last_seen: '2026-11-22', pinned: false,
        superseded_by: '', visibility: 'private',
      }],
      pending: [],
      relationship: { stage: '', milestones: [] },
    },
    episodes: [{
      id: 'ep_a', ts: '2026-11-20T12:00:00.000Z', kind: 'chat',
      summary: '主人加班到很晚，聊了会儿天。', tags: ['加班'],
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
        summary: '主人连续加班，周末才缓过来。', episode_ids: ['ep_a', 'ep_b'],
        visibility: 'public', createdAt: '2026-11-23T00:00:00.000Z',
      }],
    },
    meta: { version: 1, migratedAt: '2026-11-01T00:00:00.000Z' },
  }, now);

  const persona = { name: '大肥鱼', ownerTitle: '主人', text: '性格：好奇、嘴硬心软' };
  const graph = memoryGraph({ home, now, persona });
  const idsOf = (r) => r.chain.map((c) => c.id);
  const find = (r, id) => r.chain.find((c) => c.id === id);

  // 1) 显式 seed：第一跳覆盖共现/主题/叙事/证据
  {
    const r = thinkChain({ graph, seed: 'ep_a', hops: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.chain[0].id, 'ep_a');
    assert.equal(r.chain[0].hop, 0);
    assert.equal(r.chain[0].score, 1);
    assert.ok(idsOf(r).includes('ep_b'), '相似情节可达');
    assert.ok(find(r, 'ep_b').hop <= 2);
    const direct = thinkChain({ graph, seed: 'ep_a', hops: 1 });
    assert.ok(idsOf(direct).includes('ep_b'), '相似情节一跳可达');
    assert.ok(idsOf(r).includes('topic:加班'));
    assert.ok(idsOf(r).includes('arc_1'));
    assert.ok(idsOf(r).includes('f_work'), '事实证据边可达');
    assert.equal(find(r, 'f_work').viaKind, 'evidence');
    ok('显式 seed 逐跳扩散（related/topic/arc/evidence）');
  }

  // 2) 两跳能沿「事实 → 主人」走到核心节点；一跳走不到
  {
    const one = thinkChain({ graph, seed: 'ep_a', hops: 1 });
    assert.ok(!idsOf(one).includes('owner'), '一跳到不了主人');
    const two = thinkChain({ graph, seed: 'ep_a', hops: 2 });
    assert.ok(idsOf(two).includes('owner'), '两跳经事实到主人');
    assert.equal(find(two, 'owner').hop, 2);
    assert.equal(find(two, 'owner').viaKind, 'about');
    ok('多跳扩散（episode → fact → owner）');
  }

  // 3) 问题匹配种子：关键词命中主题/情节
  {
    const r = thinkChain({ graph, q: '加班', hops: 1 });
    assert.ok(r.seeds.length >= 2, '至少主题与情节都当种子');
    assert.ok(idsOf(r).includes('topic:加班'));
    assert.ok(idsOf(r).includes('ep_a') && idsOf(r).includes('ep_b'));
    const none = thinkChain({ graph, q: '量子退火机的哈密顿量' });
    assert.deepEqual(none.chain, [], '无命中不瞎扩散');
    assert.equal(none.ok, true);
    const blank = thinkChain({ graph, q: '' });
    assert.deepEqual(blank.chain, []);
    ok('问题匹配种子 / 无命中不扩散');
  }

  // 4) 隐私：图里没有私人节点，seed 也进不来；带私人的图可以
  {
    const r = thinkChain({ graph, seed: 'ep_priv' });
    assert.deepEqual(r.chain, [], '私人节点不在图里，不能当种子');
    const raw = JSON.stringify(thinkChain({ graph, seed: 'ep_a', hops: 3 }));
    assert.ok(!raw.includes('今天特别想主人'), '引文原话不进思维链');
    assert.ok(!raw.includes('今天又加班到十点'));

    const privGraph = memoryGraph({ home, now, persona, includePrivate: true });
    const pr = thinkChain({ graph: privGraph, seed: 'ep_priv', hops: 1 });
    assert.ok(idsOf(pr).includes('ep_priv'));
    assert.equal(find(pr, 'ep_priv').hop, 0);
    ok('隐私门（私人不进图 / 原话不出现）');
  }

  // 5) 上限、跳数与确定性
  {
    const r3 = thinkChain({ graph, seed: 'ep_a', hops: 2, limit: 3 });
    assert.equal(r3.chain.length, 3);
    assert.equal(r3.stats.hops, 2);
    assert.ok(r3.chain.every((c) => c.hop <= 2));
    const h1 = thinkChain({ graph, seed: 'ep_a', hops: 9 });
    assert.equal(h1.stats.hops, 3, '跳数夹到 3');
    assert.ok(h1.chain.every((c) => c.hop <= 3));
    const a = thinkChain({ graph, seed: 'ep_a', hops: 2 });
    const b = thinkChain({ graph, seed: 'ep_a', hops: 2 });
    assert.deepEqual(a, b, '同一图同一输入完全一致');
    assert.ok(a.chain.every((c) => c.via === '' || idsOf(a).includes(c.via) || c.via === c.id));
    ok('上限/跳数夹取/确定性');
  }
} finally {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nALL PASSED (${pass})`);
