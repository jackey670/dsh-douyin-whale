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

/** 查询命中度：按 idf 加权的覆盖率，0–1。 */
export function searchIndex(index, query) {
  const q = tokenize(query);
  if (!q.length || !index?.terms) return [];
  const total = Math.max(1, Number(index.docCount) || 1);
  const idf = (t) => Math.log(1 + total / Math.max(1, (index.terms[t] || []).length));
  const denom = q.reduce((s, t) => s + idf(t), 0) || 1;
  const scores = new Map();
  for (const t of q) {
    const w = idf(t);
    for (const id of index.terms[t] || []) {
      scores.set(id, (scores.get(id) || 0) + w);
    }
  }
  return [...scores.entries()]
    .map(([id, s]) => ({ id, relevance: s / denom }))
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
    lastConsolidatedAt: '',
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
  if (meta?.migratedAt) return { ok: true, migrated: false, meta };
  try {
    const r = migrateMemoryLayers({ home, nick, log, now });
    return { ok: true, migrated: true, meta: r.meta };
  } catch (e) {
    log(`[memory] 迁移失败（不影响回复）: ${e?.message ?? e}`);
    return { ok: false, migrated: false, error: String(e?.message ?? e) };
  }
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
  const facts = (Array.isArray(profile.facts) ? profile.facts : [])
    .filter((f) => f && f.text && !f.superseded_by)
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
  const profile = readJson(paths.profile, { facts: [] });
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
    profile: (profile.facts || []).filter((f) => f && !f.superseded_by).length,
    episodes: episodes.length,
    arcs: (arcs.arcs || []).length,
    terms: index ? Object.keys(index.terms || {}).length : 0,
    migratedAt: meta?.migratedAt || '',
    lastConsolidatedAt: meta?.lastConsolidatedAt || '',
    bytes,
  };
}
