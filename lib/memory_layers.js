/**
 * lib/memory_layers.js —— 四层记忆的文件存储、索引与检索（Phase 1）。
 *
 * 设计见 docs/MEMORY-LAYERS.md。这一版只做：
 *   · 迁移：现有 dm-*.json 的 80 条消息 + 两本日记 → episodes；
 *   · 存储：profile.json / episodes.jsonl / arcs.json / index.json / meta.json；
 *   · 检索：字符二元组倒排 + 相关性/新近度/重要度/情绪强度打分；
 *   · 注入：buildMemoryContext 产出有字数预算的提示词块。
 *
 * 固化（模型抽取新事实）和会话轮换在 Phase 2，不在本模块里。
 * 原文是唯一真相：摘要只做导航，evidence 必须来自原文。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadDmMemory, safeKey } from '../scheduler/memory.mjs';

export const MEMORY_VERSION = 1;
export const MEMORY_FILES = {
  profile: 'profile.json',
  episodes: 'episodes.jsonl',
  arcs: 'arcs.json',
  index: 'index.json',
  meta: 'meta.json',
};

const DAY_MS = 86_400_000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const nowIso = (now = new Date()) => new Date(now).toISOString();

export function memoryPaths(home) {
  const dir = path.join(home, 'memory');
  return {
    dir,
    profile: path.join(dir, MEMORY_FILES.profile),
    episodes: path.join(dir, MEMORY_FILES.episodes),
    arcs: path.join(dir, MEMORY_FILES.arcs),
    index: path.join(dir, MEMORY_FILES.index),
    meta: path.join(dir, MEMORY_FILES.meta),
  };
}

function readJson(file, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object' && row.id);
  } catch {
    return [];
  }
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const body = rows.length ? `${rows.map((r) => JSON.stringify(r)).join('\n')}\n` : '';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

/** 中文按字符二元组切，英文/数字按词切；不引入分词依赖。 */
export function tokenize(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_+-]*/g)) {
    if (m[0].length >= 2) out.add(m[0]);
  }
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
  }
  return [...out].slice(0, 400);
}

function episodeTokens(ep) {
  const parts = [ep.summary, (ep.tags || []).join(' ')];
  for (const e of ep.evidence || []) parts.push(e?.quote || '');
  return tokenize(parts.join(' '));
}

/** 倒排索引：term → [episode id]；可从 episodes 全量重建。 */
export function buildIndex(episodes, now = new Date()) {
  const terms = {};
  for (const ep of episodes || []) {
    for (const t of episodeTokens(ep)) {
      if (!terms[t]) terms[t] = [];
      terms[t].push(ep.id);
    }
  }
  return {
    version: MEMORY_VERSION,
    builtAt: nowIso(now),
    docCount: (episodes || []).length,
    terms,
  };
}

/** 查询命中度：idf 加权命中做饱和（0–1），避免长问句里的虚词把分数摊薄。 */
export function searchIndex(index, query) {
  const q = tokenize(query);
  if (!q.length || !index?.terms) return [];
  const total = Math.max(1, Number(index.docCount) || 1);
  const idf = (t) => Math.log(1 + total / Math.max(1, (index.terms[t] || []).length));
  const scores = new Map();
  for (const t of q) {
    const w = idf(t);
    for (const id of index.terms[t] || []) {
      scores.set(id, (scores.get(id) || 0) + w);
    }
  }
  // 只按「命中的词」计分并饱和：命中一个稀有词（魔方）比命中三个虚词更有用。
  // 若按整个问句的 idf 总和做分母，长问句会被没命中的词稀释，近期寒暄反而排前面。
  return [...scores.entries()]
    .map(([id, s]) => ({ id, relevance: s / (s + 2) }))
    .sort((a, b) => b.relevance - a.relevance);
}

/**
 * 选情节：有 query 时按相关性+新近度+重要度+情绪；无 query 时偏新近度和重要度。
 * 同一 tag 最多占 2 条，避免一个话题刷屏。
 */
export function selectEpisodes({
  episodes = [], index = null, query = '', now = new Date(), limit = 4,
  includePrivate = false,
} = {}) {
  const hasQuery = tokenize(query).length > 0;
  const rel = new Map(searchIndex(index, query).map((x) => [x.id, x.relevance]));
  const scored = [];
  for (const ep of episodes) {
    if (!ep?.summary) continue;
    if (!includePrivate && ep.visibility === 'private') continue;
    const at = Date.parse(ep.ts || '') || now.getTime();
    const days = Math.max(0, (now.getTime() - at) / DAY_MS);
    const recency = Math.exp(-days / 30);
    const importance = clamp(Number(ep.importance) || 2, 1, 5) / 5;
    const affect = clamp(Math.abs(Number(ep.valence) || 0), 0, 2) / 2;
    const relevance = rel.get(ep.id) || 0;
    const score = hasQuery
      ? 0.45 * relevance + 0.25 * recency + 0.2 * importance + 0.1 * affect
      : 0.55 * recency + 0.35 * importance + 0.1 * affect;
    if (hasQuery && relevance <= 0) continue;
    scored.push({ ep, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  const tagCount = new Map();
  for (const { ep } of scored) {
    if (out.length >= limit) break;
    const tags = ep.tags || [];
    if (tags.some((t) => (tagCount.get(t) || 0) >= 2)) continue;
    out.push(ep);
    for (const t of tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  return out;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '??';
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
}

function oneLine(s, max = 120) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function formatEpisode(ep) {
  const summary = oneLine(ep.summary, 120);
  let line = `・${fmtDate(ep.ts)} ${summary}`;
  const quote = oneLine(ep.evidence?.[0]?.quote, 40);
  if (quote && !summary.includes(quote.slice(0, 8))) line += `（「${quote}」）`;
  return line;
}

/** 把当天的私信按天分组，规则摘要（不调模型），evidence 保留原话。 */
function chatEpisodes(dm, now) {
  const groups = new Map();
  for (const m of dm?.messages || []) {
    const at = Date.parse(m.at || '') || now.getTime();
    const d = new Date(at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...m, _at: at });
  }
  const out = [];
  let i = 0;
  for (const [date, msgs] of groups) {
    i += 1;
    const them = msgs.filter((m) => m.from === 'them');
    const last = them.at(-1) || msgs.at(-1);
    const summary = `聊天 ${msgs.length} 句，最后：${oneLine(last?.text, 90)}`;
    const evidence = msgs.slice(-3)
      .map((m) => ({
        source: 'dm',
        quote: oneLine(m.text, 80),
        at: new Date(m._at).toISOString(),
      }))
      .filter((e) => e.quote);
    out.push({
      id: `ep_${date.replace(/-/g, '')}_${String(i).padStart(2, '0')}`,
      ts: new Date(msgs[0]._at).toISOString(),
      kind: 'chat',
      summary: oneLine(summary, 120),
      evidence,
      tags: ['私信'],
      importance: 2,
      valence: 0,
      visibility: 'public',
      source_ref: 'dm',
      last_used_at: '',
      uses: 0,
    });
  }
  return out;
}

/** 两本日记按 `## ` 小节转 episode；私人日记只在本机索引。 */
function diaryEpisodes(home, now) {
  const files = [
    ['whale-diary.md', 'pub', '日记'],
    ['whale-diary-private.md', 'priv', '私人日记'],
  ];
  const out = [];
  for (const [file, tag, label] of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(home, file), 'utf8'); } catch { continue; }
    const sections = text.split(/^## /m).slice(1);
    let i = 0;
    for (const sec of sections) {
      const nl = sec.indexOf('\n');
      const head = (nl >= 0 ? sec.slice(0, nl) : sec).trim();
      const body = (nl >= 0 ? sec.slice(nl + 1) : '').trim();
      if (!head || !body) continue;
      i += 1;
      const dateMatch = head.match(/(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : nowIso(now).slice(0, 10);
      const first = body.split(/\n/).map((s) => s.trim()).find(Boolean) || body;
      out.push({
        id: `ep_${date.replace(/-/g, '')}_${tag}${String(i).padStart(2, '0')}`,
        ts: `${date}T12:00:00`,
        kind: 'diary',
        summary: oneLine(first, 120),
        evidence: [{ source: 'diary', quote: oneLine(body, 80) }],
        tags: [label],
        importance: 3,
        valence: 0,
        visibility: tag === 'priv' ? 'private' : 'public',
        source_ref: file,
        last_used_at: '',
        uses: 0,
      });
    }
  }
  return out;
}

/**
 * 一次性迁移：dm 消息 + 两本日记 → episodes；facts → profile。
 * 幂等：meta.migratedAt 存在就直接返回。
 */
export function migrateMemoryLayers({ home, nick = '', log = () => {}, now = new Date() } = {}) {
  const paths = memoryPaths(home);
  const existing = readJson(paths.meta, null);
  if (existing?.migratedAt) {
    return { ok: true, skipped: true, meta: existing };
  }
  const dm = nick ? loadDmMemory(home, nick) : null;
  const episodes = [
    ...chatEpisodes(dm, now),
    ...diaryEpisodes(home, now),
  ];
  const facts = (dm?.facts || []).slice(0, 20).map((text, i) => ({
    id: `f_${String(i + 1).padStart(3, '0')}`,
    text: oneLine(text, 80),
    category: 'fact',
    confidence: 0.8,
    first_seen: nowIso(now).slice(0, 10),
    last_seen: nowIso(now).slice(0, 10),
    evidence_ids: [],
    pinned: false,
    superseded_by: '',
  }));
  const profile = {
    version: MEMORY_VERSION,
    updatedAt: nowIso(now),
    facts,
    relationship: { stage: '', milestones: [] },
  };
  const arcs = { version: MEMORY_VERSION, updatedAt: nowIso(now), arcs: [] };
  const index = buildIndex(episodes, now);
  const meta = {
    version: MEMORY_VERSION,
    migratedAt: nowIso(now),
    lastConsolidatedAt: nowIso(now),   // 迁移只负责历史；Phase 2 从这里开始吃新素材
    lastConsolidateAttemptAt: '',
    source: {
      dmMessages: dm?.messages?.length || 0,
      diaryEpisodes: episodes.filter((e) => e.kind === 'diary').length,
    },
  };
  writeJson(paths.profile, profile);
  writeJsonl(paths.episodes, episodes);
  writeJson(paths.arcs, arcs);
  writeJson(paths.index, index);
  writeJson(paths.meta, meta);
  log(`[memory] 迁移完成：${episodes.length} 条情节，${facts.length} 条事实`);
  return { ok: true, skipped: false, episodes: episodes.length, facts: facts.length, meta };
}

/** 首次使用前确保迁移跑过；失败不挡回复。 */
export function ensureMemoryLayers({ home, nick = '', log = () => {}, now = new Date() } = {}) {
  const paths = memoryPaths(home);
  const meta = readJson(paths.meta, null);
  if (meta?.migratedAt) {
    // 迁移时没写固化基线：用迁移时间兜底，Phase 2 只处理迁移之后的新素材
    if (!meta.lastConsolidatedAt) {
      meta.lastConsolidatedAt = meta.migratedAt;
      writeJson(paths.meta, meta);
    }
    return { ok: true, migrated: false, meta };
  }
  try {
    const r = migrateMemoryLayers({ home, nick, log, now });
    return { ok: true, migrated: true, meta: r.meta };
  } catch (e) {
    log(`[memory] 迁移失败（不影响回复）: ${e?.message ?? e}`);
    return { ok: false, migrated: false, error: String(e?.message ?? e) };
  }
}

/** 读整个记忆库（Phase 2 固化用）。 */
export function readMemoryStore(home) {
  const paths = memoryPaths(home);
  return {
    paths,
    profile: readJson(paths.profile, {
      version: MEMORY_VERSION,
      facts: [],
      pending: [],
      relationship: { stage: '', milestones: [] },
    }),
    episodes: readJsonl(paths.episodes),
    arcs: readJson(paths.arcs, { version: MEMORY_VERSION, arcs: [] }),
    meta: readJson(paths.meta, null),
  };
}

/** 原子写整个记忆库并重建索引。 */
export function writeMemoryStore(home, { profile, episodes, arcs, meta }, now = new Date()) {
  const paths = memoryPaths(home);
  const index = buildIndex(episodes, now);
  writeJson(paths.profile, profile);
  writeJsonl(paths.episodes, episodes);
  writeJson(paths.arcs, arcs);
  writeJson(paths.index, index);
  writeJson(paths.meta, meta);
  return { paths, index };
}

/** 只更新 meta（固化失败/尝试时间用），不动其它文件。 */
export function writeMeta(home, meta) {
  writeJson(memoryPaths(home).meta, meta);
}

/**
 * 生成提示词里的长期记忆块。预算按字符算（中文约 1.6 字/token）。
 * 档案优先，其次关系里程碑，最后相关回忆；放不下就截断，不硬塞。
 */
export function buildMemoryContext({
  home, nick = '', query = '', budgetChars = 1000, now = new Date(), limit = 4,
  includePrivate = false,
} = {}) {
  const paths = memoryPaths(home);
  try {
    ensureMemoryLayers({ home, nick, now });
  } catch { /* 迁移失败也继续用已有文件 */ }

  const profile = readJson(paths.profile, { facts: [], relationship: {} });
  const episodes = readJsonl(paths.episodes);
  const index = readJson(paths.index, null) || buildIndex(episodes, now);
  const arcsDoc = readJson(paths.arcs, { arcs: [] });
  const arcList = (Array.isArray(arcsDoc.arcs) ? arcsDoc.arcs : [])
    .filter((a) => a && a.title && a.summary && !a.deleted
      && (includePrivate || a.visibility !== 'private'))
    .sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0))
    .slice(0, 2);
  const facts = (Array.isArray(profile.facts) ? profile.facts : [])
    .filter((f) => f && f.text && !f.superseded_by && !f.deleted
      && (includePrivate || f.visibility !== 'private'))
    .sort((a, b) => (Number(b.pinned) || 0) - (Number(a.pinned) || 0)
      || (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    .slice(0, 8);
  const milestones = (profile.relationship?.milestones || [])
    .filter((m) => m?.text)
    .slice(-2);
  const used = selectEpisodes({ episodes, index, query, now, limit, includePrivate });

  const sections = [];
  if (facts.length) {
    sections.push({ title: '【主人档案】', lines: facts.map((f) => `・${oneLine(f.text, 80)}`) });
  }
  if (milestones.length) {
    sections.push({
      title: '【我们之间】',
      lines: milestones.map((m) => `・${fmtDate(m.at)} ${oneLine(m.text, 80)}`),
    });
  }
  if (arcList.length) {
    sections.push({
      title: '【最近这几周】',
      lines: arcList.map((a) => `・${oneLine(a.period, 24)} ${oneLine(a.title, 16)}：${oneLine(a.summary, 80)}`),
    });
  }
  if (used.length) {
    sections.push({ title: '【相关回忆】', lines: used.map(formatEpisode) });
  }

  const out = [];
  let chars = 0;
  for (const sec of sections) {
    if (chars + sec.title.length + 2 > budgetChars) break;
    out.push(sec.title);
    chars += sec.title.length + 1;
    for (const line of sec.lines) {
      if (chars + line.length + 1 > budgetChars) break;
      out.push(line);
      chars += line.length + 1;
    }
    out.push('');
    chars += 1;
  }
  const text = out.join('\n').trim();
  return {
    text,
    used: used.map((e) => e.id),
    stats: {
      profile: facts.length,
      arcs: arcList.length,
      episodes: episodes.length,
      used: used.length,
      chars,
    },
  };
}

/** 把长期记忆块挂到 dmContext 上；读取失败返回原 mem。 */
export function withMemoryLayers({
  home, nick = '', query = '', mem = null, log = () => {}, budgetChars = 1000,
  includePrivate = false,
} = {}) {
  try {
    const ctx = buildMemoryContext({ home, nick, query, budgetChars, includePrivate });
    if (!ctx.text) return mem;
    if (ctx.used.length) log(`[memory] 注入 ${ctx.used.length} 条情节（${ctx.stats.chars} 字）`);
    return { ...(mem || {}), layers: ctx.text, layersMeta: ctx.stats };
  } catch (e) {
    log(`[memory] 分层记忆读取失败（不影响回复）: ${e?.message ?? e}`);
    return mem;
  }
}

/** 面板/状态用的只读统计，不触发迁移。 */
export function memoryLayersStats(home) {
  const paths = memoryPaths(home);
  const profile = readJson(paths.profile, { facts: [], pending: [] });
  const episodes = readJsonl(paths.episodes);
  const arcs = readJson(paths.arcs, { arcs: [] });
  const index = readJson(paths.index, null);
  const meta = readJson(paths.meta, null);
  let bytes = 0;
  for (const f of [paths.profile, paths.episodes, paths.arcs, paths.index, paths.meta]) {
    try { bytes += fs.statSync(f).size; } catch { /* 文件还没生成 */ }
  }
  return {
    version: MEMORY_VERSION,
    profile: (profile.facts || []).filter((f) => f && !f.superseded_by && !f.deleted).length,
    pending: (profile.pending || []).length,
    episodes: episodes.length,
    arcs: (arcs.arcs || []).length,
    terms: index ? Object.keys(index.terms || {}).length : 0,
    migratedAt: meta?.migratedAt || '',
    lastConsolidatedAt: meta?.lastConsolidatedAt || '',
    lastConsolidation: meta?.lastConsolidation || null,
    bytes,
  };
}

/** 文本相似度（二元组 Jaccard），用于偏好初始化去重。 */
function similarText(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter) >= 0.8;
}

const publicFact = (f) => ({
  id: f.id,
  text: oneLine(f.text, 120),
  category: f.category || 'fact',
  confidence: Number(f.confidence) || 0,
  pinned: Boolean(f.pinned),
  private: f.visibility === 'private',
  source: f.source || 'consolidate',
  first_seen: f.first_seen || '',
  last_seen: f.last_seen || '',
});

const publicEpisode = (e) => ({
  id: e.id,
  ts: e.ts || '',
  kind: e.kind || 'chat',
  summary: oneLine(e.summary, 120),
  tags: (e.tags || []).slice(0, 3),
  importance: Number(e.importance) || 2,
  private: e.visibility === 'private',
});

const publicArc = (a) => ({
  id: a.id,
  period: oneLine(a.period, 24),
  title: oneLine(a.title, 24),
  summary: oneLine(a.summary, 120),
  episodeCount: Array.isArray(a.episode_ids) ? a.episode_ids.length : 0,
  private: a.visibility === 'private',
});

/**
 * 面板「记忆」卡的数据：统计 + 置顶/高置信事实 + 待确认 + 最近情节。
 * 只返回摘要与日期，不返回 evidence 原话；私人条目带 private 标记。
 */
export function memoryOverview({ home, limit = 5 } = {}) {
  const store = readMemoryStore(home);
  const facts = (store.profile?.facts || [])
    .filter((f) => f && f.text && !f.superseded_by && !f.deleted)
    .sort((a, b) => (Number(b.pinned) || 0) - (Number(a.pinned) || 0)
      || (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    .slice(0, 8)
    .map(publicFact);
  const pending = (store.profile?.pending || [])
    .filter((f) => f && f.text)
    .slice(0, 10)
    .map(publicFact);
  const episodes = [...(store.episodes || [])]
    .sort((a, b) => (Date.parse(b.ts || '') || 0) - (Date.parse(a.ts || '') || 0))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)))
    .map(publicEpisode);
  const arcs = [...(store.arcs?.arcs || [])]
    .filter((a) => a && a.title && a.summary && !a.deleted)
    .sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0))
    .slice(0, 3)
    .map(publicArc);
  return {
    stats: memoryLayersStats(home),
    facts,
    pending,
    episodes,
    arcs,
    lastConsolidation: store.meta?.lastConsolidation || null,
  };
}

/**
 * 本机搜索：事实按词覆盖率，情节走倒排索引；默认不返回私人条目。
 * 只返回摘要/日期/分数，不返回 evidence 原文。
 */
export function searchMemory({ home, q = '', limit = 8, includePrivate = false } = {}) {
  const paths = memoryPaths(home);
  const profile = readJson(paths.profile, { facts: [], pending: [] });
  const episodes = readJsonl(paths.episodes);
  const index = readJson(paths.index, null) || buildIndex(episodes);
  const query = oneLine(q, 60);
  const qTokens = new Set(tokenize(query));
  const max = Math.max(1, Math.min(20, Number(limit) || 8));

  const facts = (profile.facts || [])
    .filter((f) => f && f.text && !f.superseded_by && !f.deleted
      && (includePrivate || f.visibility !== 'private'))
    .map((f) => {
      if (!qTokens.size) return { f, score: 0 };
      const ft = new Set(tokenize(f.text));
      let inter = 0;
      for (const t of qTokens) if (ft.has(t)) inter += 1;
      return { f, score: inter / qTokens.size };
    })
    .filter((x) => !qTokens.size || x.score > 0)
    .sort((a, b) => b.score - a.score
      || (Number(b.f.pinned) || 0) - (Number(a.f.pinned) || 0)
      || (Number(b.f.confidence) || 0) - (Number(a.f.confidence) || 0))
    .slice(0, 6)
    .map(({ f, score }) => ({ ...publicFact(f), score }));

  const rel = new Map(searchIndex(index, query).map((x) => [x.id, x.relevance]));
  const eps = episodes
    .filter((e) => e && e.summary && (includePrivate || e.visibility !== 'private'))
    .map((e) => ({
      e,
      score: qTokens.size ? (rel.get(e.id) || 0) : (Date.parse(e.ts || '') || 0),
    }))
    .filter((x) => !qTokens.size || x.score > 0)
    .sort((a, b) => b.score - a.score
      || (Number(b.e.importance) || 0) - (Number(a.e.importance) || 0))
    .slice(0, max)
    .map(({ e, score }) => ({ ...publicEpisode(e), score: qTokens.size ? score : 0 }));

  return { query, facts, episodes: eps };
}

/** 置顶/取消置顶一条事实；找不到或已删除返回 null。 */
export function pinMemoryFact({ home, id, pinned = true, now = new Date() } = {}) {
  const store = readMemoryStore(home);
  const facts = store.profile?.facts;
  if (!Array.isArray(facts)) return null;
  const f = facts.find((x) => x && x.id === id && !x.deleted);
  if (!f) return null;
  f.pinned = Boolean(pinned);
  f.updatedAt = nowIso(now);
  store.profile.updatedAt = nowIso(now);
  writeMemoryStore(home, {
    profile: store.profile,
    episodes: store.episodes,
    arcs: store.arcs,
    meta: store.meta || {},
  }, now);
  return publicFact(f);
}

/**
 * 删除一条记忆：事实软删（保留记录便于排障），情节从 jsonl 移除并重建索引。
 * 私信/日记原文不动。
 */
export function deleteMemoryItem({ home, id, now = new Date() } = {}) {
  const store = readMemoryStore(home);
  const stamp = nowIso(now);
  let kind = '';
  if (String(id || '').startsWith('f_')) {
    const f = (store.profile?.facts || []).find((x) => x && x.id === id && !x.deleted);
    if (!f) return null;
    f.deleted = true;
    f.deletedAt = stamp;
    kind = 'fact';
  } else {
    const before = store.episodes || [];
    const after = before.filter((e) => e && e.id !== id);
    if (after.length === before.length) return null;
    store.episodes = after;
    kind = 'episode';
  }
  store.profile.updatedAt = stamp;
  writeMemoryStore(home, {
    profile: store.profile,
    episodes: store.episodes,
    arcs: store.arcs,
    meta: store.meta || {},
  }, now);
  return { ok: true, kind, id };
}

/** 待确认事实：accept 进档案（confidence 提到 0.8），dismiss 丢弃。 */
export function resolvePendingFact({ home, id, action, now = new Date() } = {}) {
  if (action !== 'accept' && action !== 'dismiss') return null;
  const store = readMemoryStore(home);
  const profile = store.profile || {};
  const pending = Array.isArray(profile.pending) ? profile.pending : [];
  const idx = pending.findIndex((x) => x && x.id === id);
  if (idx < 0) return null;
  const [item] = pending.splice(idx, 1);
  profile.pending = pending;
  let accepted = null;
  if (action === 'accept') {
    const facts = Array.isArray(profile.facts) ? profile.facts : [];
    const dup = facts.find((f) => f && f.text && !f.deleted && similarText(f.text, item.text));
    if (dup) {
      dup.last_seen = nowIso(now).slice(0, 10);
      dup.confidence = Math.max(Number(dup.confidence) || 0, 0.8);
      accepted = publicFact(dup);
    } else {
      let newId = item.id.replace(/^p_/, 'f_');
      for (let n = 2; facts.some((f) => f && f.id === newId); n += 1) {
        newId = `${item.id.replace(/^p_/, 'f_')}_${n}`;
      }
      const fact = {
        id: newId,
        text: item.text,
        category: item.category || 'fact',
        confidence: Math.max(0.8, Number(item.confidence) || 0.8),
        first_seen: item.first_seen || nowIso(now).slice(0, 10),
        last_seen: nowIso(now).slice(0, 10),
        evidence: item.evidence || '',
        evidence_ids: [],
        pinned: false,
        superseded_by: '',
        visibility: item.visibility || 'public',
        source: 'pending',
      };
      facts.push(fact);
      profile.facts = facts;
      accepted = publicFact(fact);
    }
  }
  profile.updatedAt = nowIso(now);
  writeMemoryStore(home, {
    profile,
    episodes: store.episodes,
    arcs: store.arcs,
    meta: store.meta || {},
  }, now);
  return { ok: true, action, fact: accepted };
}

/**
 * 把配置里的喜好/雷点初始化成置顶事实（出处是主人配置，不算模型编造）。
 * 幂等：已有相同事实（Jaccard ≥0.8）就跳过；没有改动不写盘。
 */
export function seedPreferenceFacts({ home, cfg = {}, now = new Date() } = {}) {
  const store = readMemoryStore(home);
  if (!store.meta?.migratedAt) return { ok: false, added: 0, reason: 'not-migrated' };
  const profile = store.profile || {};
  const facts = Array.isArray(profile.facts) ? profile.facts : [];
  const pending = Array.isArray(profile.pending) ? profile.pending : [];
  const wanted = [];
  const likes = Array.isArray(cfg?.preferences?.like) ? cfg.preferences.like : [];
  const dislikes = Array.isArray(cfg?.preferences?.dislike) ? cfg.preferences.dislike : [];
  for (const item of likes) {
    const text = oneLine(`主人喜欢${item}`, 80);
    if (text.length > 4) wanted.push({ text, category: 'preference' });
  }
  for (const item of dislikes) {
    const text = oneLine(`主人不喜欢${item}`, 80);
    if (text.length > 5) wanted.push({ text, category: 'boundary' });
  }
  const stamp = nowIso(now).slice(0, 10);
  let added = 0;
  for (const w of wanted) {
    const dup = [...facts, ...pending].some((f) => f && f.text && !f.deleted
      && similarText(f.text, w.text));
    if (dup) continue;
    facts.push({
      id: `f_cfg_${stamp.replace(/-/g, '')}_${String(added + 1).padStart(2, '0')}`,
      text: w.text,
      category: w.category,
      confidence: 1,
      first_seen: stamp,
      last_seen: stamp,
      evidence: '主人配置',
      evidence_ids: [],
      pinned: true,
      superseded_by: '',
      visibility: 'public',
      source: 'config',
    });
    added += 1;
  }
  if (!added) return { ok: true, added: 0 };
  profile.facts = facts;
  profile.updatedAt = nowIso(now);
  writeMemoryStore(home, {
    profile,
    episodes: store.episodes,
    arcs: store.arcs,
    meta: store.meta,
  }, now);
  return { ok: true, added };
}
