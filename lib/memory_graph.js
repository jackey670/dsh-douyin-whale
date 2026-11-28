/**
 * lib/memory_graph.js —— 记忆星图：把四层记忆拼成可视图（节点 + 边）。
 *
 * 原则：
 *   · 只读、确定性：不写库、不调模型、不用向量；
 *   · evidence 原话只参与相似度计算，**绝不下发**（唯一出口仍是 /memory/episode）；
 *   · 私人条目默认不出现；私人节点不出现时，连着它的边也不出现；
 *   · 节点只带摘要级 label + 详情字段，不带聊天原文。
 *
 * 边的类型（少而明确）：
 *   core        self → 性格/主人
 *   about       事实/情节 → 主题，或 主人 → 事实/里程碑
 *   evidence    事实/里程碑 → 情节（原话依据在哪些情节里）
 *   part_of     情节 → 叙事线
 *   related     情节 ↔ 情节（bigram 相似度）
 *   supersedes  新事实 → 被取代的旧事实
 */
import { readMemoryLinks, readMemoryStore, tokenize } from './memory_layers.js';

const DAY_MS = 86_400_000;
const HALF_LIFE = { 1: 2, 2: 5, 3: 14, 4: 45 };
/** 出现频率过高的标签不建主题星，否则会变成一个吞掉所有边的大 hub。 */
const GENERIC_TAGS = new Set([
  '私人日记', '日记', '私信', '聊天', '日常', '值班轮', '日记轮', '互动', '日常分享',
]);

const clamp01 = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
};
const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const hash32 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** 星等：重要度定初始强度与半衰期，情绪强度延长半衰期；置顶不衰减。
 *  被想起过（uses/lastUsedAt）的记忆从「上次想起」重新起算，且初始强度略高——
 *  这就是「越用越亮」的那一半，另一半由 recordRecall 写回 uses。 */
export function starStrength({
  importance = 2, valence = 0, ts = '', pinned = false,
  uses = 0, lastUsedAt = '', now = Date.now(),
} = {}) {
  if (pinned) return { strength: 1, state: 'pinned', halfLifeDays: null };
  const imp = Math.max(1, Math.min(5, Math.round(Number(importance) || 2)));
  const emotion = clamp01(Math.abs(Number(valence) || 0) / 2);
  const used = Math.max(0, Math.round(Number(uses) || 0));
  // 每被想起一次，起点 +0.04，最多 +0.25；封顶后靠「时钟归零」继续生效
  const s0 = clamp01(0.5 + imp / 10 + Math.min(0.25, 0.04 * used));
  const halfLifeDays = (HALF_LIFE[imp] ?? 14) * (1 + 2 * emotion);
  // 衰减从「上次想起」算起；没想起过才从创建时间算
  const anchor = Date.parse(lastUsedAt || '') || Date.parse(ts || '');
  const days = Number.isFinite(anchor) ? Math.max(0, (now - anchor) / DAY_MS) : 0;
  const strength = s0 * (0.5 ** (days / halfLifeDays));
  const state = strength >= 0.5 ? 'clear' : strength >= 0.15 ? 'faded' : 'trace';
  return { strength: Math.round(strength * 1000) / 1000, state, halfLifeDays };
}

/** 从人设文本 + 配置偏好拆出「性格星」。 */
export function parseTraits(personaText = '', preferences = {}) {
  const out = [];
  const push = (kind, label) => {
    const t = oneLine(label, 16);
    if (!t) return;
    if (out.some((x) => x.kind === kind && x.label === t)) return;
    out.push({ kind, label: t });
  };
  for (const line of String(personaText || '').split(/\n+/)) {
    const m = line.match(/^(性格|喜欢|不喜欢|说话)[:：]\s*(.+)$/);
    if (!m) continue;
    const kind = m[1] === '喜欢' ? 'like'
      : m[1] === '不喜欢' ? 'dislike'
        : m[1] === '性格' ? 'trait' : 'style';
    for (const part of m[2].split(/[、,，;；]/)) push(kind, part);
  }
  for (const [kind, arr] of [['like', preferences?.like], ['dislike', preferences?.dislike]]) {
    for (const item of Array.isArray(arr) ? arr : []) push(kind, item);
  }
  return out.slice(0, 16);
}

function episodeTokens(ep) {
  const parts = [ep.summary, (ep.tags || []).join(' ')];
  for (const e of ep.evidence || []) parts.push(e?.quote || '');
  return new Set(tokenize(parts.join(' ')));
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.sqrt(a.size * b.size);
}

/**
 * 构建星图。
 * @param {object} opts
 * @param {string} opts.home 记忆根目录（~/.dsh）
 * @param {boolean} [opts.includePrivate=false]
 * @param {number} [opts.maxEpisodes=280]
 * @param {number} [opts.maxFacts=200]
 * @param {number} [opts.maxArcs=50]
 * @param {number} [opts.minSim=0.18] 情节相似边门槛
 * @param {number} [opts.maxLinksPerNode=4]
 * @param {object} [opts.persona] 配置里的 persona（name/ownerTitle/text）
 * @param {object} [opts.owner] 配置里的 owner（nickname）
 * @param {object} [opts.preferences] like/dislike
 * @param {object} [opts.mood] 当前心情 { energy, social, boredom, label }
 * @param {Date|number} [opts.now]
 */
export function memoryGraph({
  home,
  includePrivate = false,
  maxEpisodes = 280,
  maxFacts = 200,
  maxArcs = 50,
  minSim = 0.18,
  maxLinksPerNode = 4,
  persona = {},
  owner = {},
  preferences = {},
  mood = null,
  now = new Date(),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const { profile, episodes: allEpisodes, arcs: arcStore } = readMemoryStore(home);
  const visible = (x) => includePrivate || x?.visibility !== 'private';

  const factsAll = (Array.isArray(profile.facts) ? profile.facts : [])
    .filter((f) => f && f.text && !f.deleted && visible(f));
  const facts = factsAll.slice(0, Math.max(1, maxFacts));
  const factsAvailable = factsAll.length;

  const epsAll = (allEpisodes || [])
    .filter((e) => e && e.summary && visible(e))
    .sort((a, b) => (Date.parse(b.ts || '') || 0) - (Date.parse(a.ts || '') || 0));
  const episodes = epsAll.slice(0, Math.max(1, maxEpisodes));
  const episodesAvailable = epsAll.length;

  const arcsAll = ((arcStore?.arcs) || []).filter((a) => a && a.title && visible(a));
  const arcs = arcsAll.slice(0, Math.max(1, maxArcs));

  const nodes = [];
  const add = (node) => { nodes.push(node); return node; };

  const selfName = oneLine(persona?.name || '大肥鱼', 20) || '大肥鱼';
  add({
    id: 'self', type: 'self', label: selfName,
    sub: '性格与记忆的中心',
    detail: oneLine(persona?.text || '', 300),
    private: false,
  });
  const traits = parseTraits(persona?.text || '', preferences);
  const traitIds = traits.map((t, i) => `trait:${i}`);
  traits.forEach((t, i) => add({
    id: `trait:${i}`, type: 'trait', label: t.label, sub: t.kind,
    traitKind: t.kind, private: false,
  }));
  const ownerLabel = oneLine(owner?.nickname || persona?.ownerTitle || '主人', 20) || '主人';
  const relStage = oneLine(profile.relationship?.stage || '', 16);
  add({
    id: 'owner', type: 'owner', label: ownerLabel, sub: '主人',
    detail: relStage ? `关系阶段：${relStage}` : '',
    private: false,
  });

  // 心情星：v1.18.0 之前心情只进提示词，不进星图；它不是记忆，是「此刻的她」
  let moodNode = null;
  if (mood && Number.isFinite(Number(mood.energy))) {
    const axis = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const energy = axis(mood.energy);
    const social = axis(mood.social);
    const boredom = axis(mood.boredom);
    moodNode = add({
      id: 'mood', type: 'mood', label: oneLine(mood.label || '心情', 12),
      sub: `精力 ${energy} · 想念 ${social} · 无聊 ${boredom}`,
      detail: '当前状态（0–100），随时间和互动漂移',
      strength: 1, state: 'pinned', private: false,
      mood: { energy, social, boredom },
    });
  }

  const factNodes = facts.map((f) => {
    const ts = f.last_seen || f.first_seen || '';
    const st = starStrength({ importance: 4, valence: 0, ts, pinned: f.pinned, now: nowMs });
    return add({
      id: f.id, type: 'fact', label: oneLine(f.text, 36), detail: oneLine(f.text, 160),
      sub: `${f.category || 'fact'} · 置信 ${Math.round((Number(f.confidence) || 0) * 100)}%`,
      ts, importance: 4, confidence: Number(f.confidence) || 0,
      strength: st.strength, state: st.state, pinned: Boolean(f.pinned),
      superseded: Boolean(f.superseded_by), private: f.visibility === 'private',
      category: f.category || 'fact',
    });
  });

  const episodeNodes = episodes.map((e) => {
    const st = starStrength({
      importance: e.importance, valence: e.valence, ts: e.ts,
      uses: e.uses, lastUsedAt: e.last_used_at, now: nowMs,
    });
    return add({
      id: e.id, type: 'episode', label: oneLine(e.summary, 44), detail: oneLine(e.summary, 200),
      sub: `${String(e.ts || '').slice(0, 10)} · 重要度 ${Number(e.importance) || 2}`
        + (Number(e.uses) ? ` · 想起 ${Number(e.uses)} 次` : ''),
      ts: e.ts || '', importance: Number(e.importance) || 2,
      valence: Number(e.valence) || 0,
      uses: Number(e.uses) || 0, lastUsedAt: e.last_used_at || '',
      strength: st.strength, state: st.state,
      private: e.visibility === 'private', tags: (e.tags || []).slice(0, 6),
      kind: e.kind || 'chat',
    });
  });

  const arcNodes = arcs.map((a) => add({
    id: a.id, type: 'arc', label: oneLine(a.title, 24), detail: oneLine(a.summary, 200),
    sub: oneLine(a.period || '', 24), ts: a.createdAt || '',
    importance: 5, strength: 1, state: 'pinned',
    private: a.visibility === 'private',
    episodeCount: (a.episode_ids || []).length,
  }));

  // 里程碑星：关系里的大事（第一次…/换工作…）。引用私人情节的整条跳过
  // （里程碑文本可能复述私人日记内容）；引用已删情节的保留节点、不连边。
  const epVis = new Map((allEpisodes || []).map((e) => [e.id, e.visibility]));
  const milestonesAll = (Array.isArray(profile.relationship?.milestones)
    ? profile.relationship.milestones : []).filter((m) => m && m.text);
  const milestoneNodes = [];
  milestonesAll.slice(-20).forEach((m, i) => {
    if (m.episode_id && epVis.get(m.episode_id) === 'private' && !includePrivate) return;
    milestoneNodes.push({
      src: m,
      node: add({
        id: `milestone:${i}`, type: 'milestone',
        label: oneLine(m.text, 24), detail: oneLine(m.text, 120),
        sub: oneLine(m.at || '', 24), ts: m.at || '',
        importance: 4, strength: 0.9, state: 'clear', private: false,
      }),
    });
  });

  // 实体星：固化从素材里抽出的具体事物（人/宠物/物品/作品/地点）。
  // 私人来源默认不出现，规则与事实一致；证据原话不下发，只拿名字去撞情节。
  const entitiesAll = (Array.isArray(profile.entities) ? profile.entities : [])
    .filter((e) => e && e.name && visible(e))
    .sort((a, b) => (Date.parse(b.last_seen || '') || 0) - (Date.parse(a.last_seen || '') || 0));
  const entityNodes = entitiesAll.slice(0, 30).map((e) => {
    const ts = e.last_seen || e.first_seen || '';
    const st = starStrength({ importance: 3, valence: 0, ts, now: nowMs });
    return add({
      id: e.id || `entity:${oneLine(e.name, 16)}`, type: 'entity',
      label: oneLine(e.name, 16), detail: oneLine(e.name, 60),
      sub: `${e.kind || 'topic'}${ts ? ` · ${String(ts).slice(0, 10)}` : ''}`,
      ts, importance: 3, strength: st.strength, state: st.state,
      private: e.visibility === 'private',
      entityKind: e.kind || 'topic',
    });
  });

  // 主题星：只保留出现 ≥2 次、非通用、未超上限的标签
  const tagCount = new Map();
  for (const e of episodes) {
    for (const t of new Set(e.tags || [])) {
      if (!t || GENERIC_TAGS.has(t)) continue;
      tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
  }
  const topicTags = [...tagCount.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 40)
    .map(([t]) => t);
  const topicNodes = topicTags.map((t) => add({
    id: `topic:${t}`, type: 'topic', label: `#${oneLine(t, 16)}`,
    sub: `${tagCount.get(t)} 条`, count: tagCount.get(t), private: false,
  }));

  const edges = [];
  const seen = new Set();
  const addEdge = (a, b, kind, w) => {
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, kind, w: Math.round(Math.max(0.05, Math.min(1, w)) * 100) / 100 });
  };

  for (const id of traitIds) addEdge('self', id, 'core', 1);
  addEdge('self', 'owner', 'core', 0.6);
  if (moodNode) addEdge('self', 'mood', 'core', 0.8);
  for (const n of [...factNodes, ...episodeNodes, ...arcNodes]) {
    if (n.type === 'fact') addEdge('owner', n.id, 'about', 0.8);
  }
  // 主人 → 实体：实体是主人生活里的具体事物
  for (const n of entityNodes) addEdge('owner', n.id, 'about', 0.6);
  // 旧事实 → 新事实：superseded_by 指向取代它的那条
  const factIds = new Set(factNodes.map((f) => f.id));
  for (const f of facts) {
    const target = f.superseded_by;
    if (target && factIds.has(target)) addEdge(f.id, target, 'supersedes', 1);
  }
  // 主人 → 里程碑 → 引用到的情节
  for (const { node, src } of milestoneNodes) {
    addEdge('owner', node.id, 'about', 0.85);
    if (src.episode_id && episodeNodes.some((e) => e.id === src.episode_id)) {
      addEdge(node.id, src.episode_id, 'evidence', 0.7);
    }
  }
  for (const n of [...factNodes, ...episodeNodes]) {
    const tokens = new Set(tokenize(`${n.detail || n.label} ${(n.tags || []).join(' ')}`));
    for (const t of topicTags) {
      const tt = tokenize(t);
      if (tt.some((x) => tokens.has(x))) addEdge(n.id, `topic:${t}`, 'about', 0.55);
    }
  }
  for (const a of arcNodes) {
    const src = arcs.find((x) => x.id === a.id);
    const ids = new Set(episodeNodes.map((e) => e.id));
    for (const epId of src?.episode_ids || []) {
      if (ids.has(epId)) addEdge(epId, a.id, 'part_of', 0.8);
    }
  }

  // 事实/实体 → 情节：名字与情节（摘要+标签+引文）的 bigram 相似度，各取 top 2
  const epTokens = new Map(episodeNodes.map((n) => {
    const src = episodes.find((e) => e.id === n.id);
    return [n.id, episodeTokens(src || {})];
  }));
  for (const f of [...factNodes, ...entityNodes]) {
    const ft = new Set(tokenize(`${f.detail || f.label} ${f.category || f.entityKind || ''}`));
    const scored = [];
    for (const ep of episodeNodes) {
      const score = overlap(ft, epTokens.get(ep.id));
      if (score >= 0.12) scored.push({ id: ep.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const x of scored.slice(0, 2)) addEdge(f.id, x.id, 'evidence', 0.5 + 0.5 * x.score);
  }

  // 情节 ↔ 情节：倒排索引找候选，cosine 相似度，取每个节点 top-k
  if (episodeNodes.length > 1) {
    const inv = new Map();
    episodeNodes.forEach((n, i) => {
      for (const t of epTokens.get(n.id)) {
        if (!inv.has(t)) inv.set(t, []);
        inv.get(t).push(i);
      }
    });
    const perNode = new Map();
    for (let i = 0; i < episodeNodes.length; i += 1) {
      const a = episodeNodes[i];
      const ta = epTokens.get(a.id);
      const shared = new Map();
      for (const t of ta) {
        for (const j of inv.get(t) || []) {
          if (j <= i) continue;
          shared.set(j, (shared.get(j) || 0) + 1);
        }
      }
      for (const [j, inter] of shared) {
        const b = episodeNodes[j];
        const tb = epTokens.get(b.id);
        const score = inter / Math.sqrt(ta.size * tb.size || 1);
        if (score < minSim) continue;
        for (const [nodeId, other] of [[a.id, b.id], [b.id, a.id]]) {
          const list = perNode.get(nodeId) || [];
          list.push({ other, score });
          perNode.set(nodeId, list);
        }
      }
    }
    for (const [nodeId, list] of perNode) {
      list.sort((x, y) => y.score - x.score);
      for (const { other, score } of list.slice(0, Math.max(1, maxLinksPerNode))) {
        addEdge(nodeId, other, 'related', 0.35 + 0.6 * score);
      }
    }
  }

  // 共现边：同一轮被一起想起过（recordRecall 学出来的）。
  // 结构边已占用的 pair 不重复画——related 的信息量更大，共现只补新关系。
  try {
    const ids = new Set(nodes.map((n) => n.id));
    for (const l of readMemoryLinks(home)) {
      if (l.kind !== 'co_recall' || !ids.has(l.a) || !ids.has(l.b)) continue;
      addEdge(l.a, l.b, 'co_recall', Math.max(0.1, Number(l.w) || 0.2));
    }
  } catch { /* links 读不出不影响星图 */ }

  // 汇总度数
  const degree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) || 0) + 1);
    degree.set(e.b, (degree.get(e.b) || 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) || 0;

  const byType = nodes.reduce((m, n) => { m[n.type] = (m[n.type] || 0) + 1; return m; }, {});
  const byKind = edges.reduce((m, e) => { m[e.kind] = (m[e.kind] || 0) + 1; return m; }, {});
  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    nodes,
    edges,
    stats: {
      nodes: { total: nodes.length, ...byType },
      edges: { total: edges.length, ...byKind },
      available: { episodes: episodesAvailable, facts: factsAvailable, arcs: arcsAll.length },
      truncated: {
        episodes: episodesAvailable > episodes.length,
        facts: factsAvailable > facts.length,
        arcs: arcsAll.length > arcs.length,
      },
      includePrivate,
      minSim,
    },
  };
}

export { GENERIC_TAGS };
