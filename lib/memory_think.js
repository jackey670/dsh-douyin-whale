/**
 * lib/memory_think.js —— 思维链：在记忆星图上做一次确定性的激活扩散。
 *
 * 不是向量检索：从「种子星」（点击的节点，或用问题直接匹配到的节点）出发，
 * 沿星图已有的边一跳一跳扩散，按边类型加权，越近、边越强得分越高。
 * 输出只带节点摘要（label/sub）和路径（via/viaKind），**不带 evidence 原话**。
 *
 * 设计取舍：
 *   · 扩散只读、确定性：同一张图 + 同一输入，结果完全一致；
 *   · 每跳取分数最高的 24 个节点继续扩散，防止大 hub 把整张图点亮；
 *   · 同一节点保留最高分路径，后面的低分路径不覆盖；
 *   · 私人节点是否出现完全由图决定（memoryGraph 已经过滤），这里不再判权。
 */
import { memoryGraph } from './memory_graph.js';
import { tokenize } from './memory_layers.js';

/** 边类型 → 扩散系数：直接因果/共现最强，文本相似最弱。 */
const EDGE_W = {
  core: 0.9,
  co_recall: 0.9,
  evidence: 0.85,
  part_of: 0.8,
  about: 0.7,
  related: 0.55,
  supersedes: 0.35,
};
const MAX_SEEDS = 5;
const MIN_SEED_SCORE = 0.12;
const MIN_ACTIVATION = 0.06;
const BEAM = 24;

const round3 = (n) => Math.round(n * 1000) / 1000;

function nodeTokens(n) {
  return new Set(tokenize([
    n.label, n.detail, n.sub, (n.tags || []).join(' '),
  ].filter(Boolean).join(' ')));
}

function buildAdj(edges) {
  const adj = new Map();
  const push = (from, to, kind, w) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ id: to, kind, w });
  };
  for (const e of edges || []) {
    const w = Math.max(0.05, Math.min(1, Number(e.w) || 0.5));
    push(e.a, e.b, e.kind, w);
    push(e.b, e.a, e.kind, w);
  }
  return adj;
}

/**
 * 在星图上走一条思维链。
 * @param {object} opts
 * @param {string} [opts.home] 没传 graph 时用它现建一张（无 persona/private 配置）
 * @param {object} [opts.graph] 已构建好的 memoryGraph 结果（推荐，保证和面板一致）
 * @param {string} [opts.q] 问题/关键词；没有 seed 时用它找种子
 * @param {string} [opts.seed] 起点节点 id；优先于 q
 * @param {number} [opts.hops=2] 扩散跳数，1–3
 * @param {number} [opts.limit=12] 返回条数，1–30
 */
export function thinkChain({
  home, graph, q = '', seed = '', hops = 2, limit = 12,
} = {}) {
  const g = graph || memoryGraph({ home });
  const nodes = new Map((g?.nodes || []).map((n) => [n.id, n]));
  const hMax = Math.max(1, Math.min(3, Math.round(Number(hops) || 2)));
  const cap = Math.max(1, Math.min(30, Math.round(Number(limit) || 12)));
  const question = String(q || '').slice(0, 120);
  const seedId = String(seed || '').slice(0, 80);
  const empty = {
    ok: true, q: question, seed: seedId, chain: [], seeds: [],
    stats: { nodes: nodes.size, edges: (g?.edges || []).length, hops: hMax, visited: 0 },
  };
  if (!nodes.size) return empty;

  // 种子：显式 seed > 问题匹配（token 覆盖率的余弦近似）
  let seeds = [];
  if (seedId && nodes.has(seedId)) {
    seeds = [{ id: seedId, score: 1 }];
  } else {
    const qt = new Set(tokenize(question));
    if (qt.size) {
      for (const n of nodes.values()) {
        const nt = nodeTokens(n);
        if (!nt.size) continue;
        let inter = 0;
        for (const t of qt) if (nt.has(t)) inter += 1;
        const score = inter / Math.sqrt(qt.size * nt.size);
        if (score >= MIN_SEED_SCORE) seeds.push({ id: n.id, score });
      }
      seeds.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      seeds = seeds.slice(0, MAX_SEEDS);
    }
  }
  if (!seeds.length) return empty;

  const adj = buildAdj(g?.edges);
  const best = new Map();
  for (const s of seeds) best.set(s.id, { score: s.score, hop: 0, via: '', viaKind: '' });

  let frontier = seeds.map((s) => ({ id: s.id, score: s.score }));
  for (let hop = 1; hop <= hMax; hop += 1) {
    const next = new Map();
    for (const cur of frontier) {
      for (const link of adj.get(cur.id) || []) {
        if (!nodes.has(link.id)) continue;
        const score = cur.score * (EDGE_W[link.kind] ?? 0.5) * (0.55 + 0.45 * link.w);
        if (score < MIN_ACTIVATION) continue;
        const prev = best.get(link.id);
        if (prev && prev.score >= score) continue;
        best.set(link.id, { score, hop, via: cur.id, viaKind: link.kind });
        next.set(link.id, { id: link.id, score });
      }
    }
    frontier = [...next.values()]
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, BEAM);
    if (!frontier.length) break;
  }

  const chain = [...best.entries()]
    .map(([id, v]) => {
      const n = nodes.get(id);
      return {
        id, type: n.type, label: n.label, sub: n.sub || '',
        hop: v.hop, score: round3(v.score), via: v.via, viaKind: v.viaKind,
      };
    })
    // 分高的在前；同分时先近后远，再按 id 保证确定性
    .sort((a, b) => b.score - a.score || a.hop - b.hop || a.id.localeCompare(b.id))
    .slice(0, cap);

  return {
    ok: true,
    q: question,
    seed: seedId,
    seeds: seeds.map((s) => ({ id: s.id, score: round3(s.score) })),
    chain,
    stats: { nodes: nodes.size, edges: (g?.edges || []).length, hops: hMax, visited: best.size },
  };
}
