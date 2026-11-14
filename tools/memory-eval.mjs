#!/usr/bin/env node
/**
 * tools/memory-eval.mjs —— 记忆召回评测。
 *
 * 三种用法：
 *   node tools/memory-eval.mjs                 内置合成语料 + 30 题（默认，可入库）
 *   node tools/memory-eval.mjs --real          用本机 ~/.dsh 记忆做索引冒烟（只输出聚合）
 *   node tools/memory-eval.mjs --questions q.json  用手写问题集（文件留在本机，别入库）
 *
 * 为什么默认是合成语料：真实私信/日记不能进公开仓库，30 题固定集只验证
 * 「索引 + 排序 + 私人过滤 + 预算」这条链路；真实召回质量用本机问题集测。
 *
 * 输出指标：hit@1 / hit@4 / MRR / 事实命中 / 负例误召回 / 私人过滤 / 耗时。
 * 退出码：0 正常；1 指标低于 --min-hit4（默认 0，不拦）；2 用法/文件错误。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMemoryContext, buildIndex, readMemoryStore, selectEpisodes,
  writeMemoryStore } from '../lib/memory_layers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXED_NOW = new Date('2026-11-14T12:00:00+08:00');
const DAY_MS = 86_400_000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function rss() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function pct(n, d) {
  return d ? `${(n / d * 100).toFixed(1)}%` : '—';
}

/* ── 合成语料：虚构主人「小满」，与真实账号无关 ─────────────────────── */
const FACTS = [
  { id: 'f_001', text: '主人喜欢宠物、AI、日常类内容', category: 'preference', confidence: 0.95, pinned: true },
  { id: 'f_002', text: '主人在做嵌入式开发', category: 'fact', confidence: 0.9 },
  { id: 'f_003', text: '主人喜欢喝冰美式咖啡', category: 'preference', confidence: 0.9 },
  { id: 'f_004', text: '主人养了一只叫团子的猫', category: 'fact', confidence: 0.9 },
  { id: 'f_005', text: '主人最怕吵，晚上十点后不喜欢被打扰', category: 'boundary', confidence: 0.9 },
];

const episode = (id, ts, summary, quote, tags, importance, valence, visibility = 'public') => ({
  id,
  ts,
  kind: visibility === 'private' ? 'diary' : 'chat',
  summary,
  evidence: [{ source: 'dm', quote, at: ts }],
  tags,
  importance,
  valence,
  visibility,
  source_ref: 'fixture',
  last_used_at: '',
  uses: 0,
});

const EPISODES = [
  episode('ep_20261022_01', '2026-10-22T21:40:00+08:00',
    '主人说这周天天加班到十点，项目要交付，语气有点累。',
    '这周天天加班到十点', ['工作', '压力'], 4, -1),
  episode('ep_20261024_01', '2026-10-24T15:00:00+08:00',
    '主人周末去海边，拍了很多照片，说风很大。',
    '周末去看了海，风特别大', ['旅行'], 3, 1),
  episode('ep_20261026_01', '2026-10-26T20:10:00+08:00',
    '主人给猫团子买了新玩具，团子理都不理。',
    '团子对那个新玩具理都不理', ['宠物', '猫'], 3, 1),
  episode('ep_20261028_01', '2026-10-28T22:30:00+08:00',
    '主人说项目终于交付了，终于能早睡。',
    '项目终于交付了，今晚要早睡', ['工作'], 4, 1),
  episode('ep_20261030_01', '2026-10-30T09:10:00+08:00',
    '主人生病感冒，嗓子疼得说不出话，喝了很多热水。',
    '嗓子疼得说不出话', ['健康'], 4, -1),
  episode('ep_20261101_01', '2026-11-01T19:20:00+08:00',
    '主人拼魔方破了个人纪录，38 秒。',
    '魔方拧进 38 秒了', ['魔方'], 3, 1),
  episode('ep_20261103_01', '2026-11-03T12:00:00+08:00',
    '主人抢到了下周三演唱会的票，很难抢。',
    '下周三的演唱会票抢到了', ['音乐', '计划'], 4, 1),
  episode('ep_20261105_01', '2026-11-05T12:20:00+08:00',
    '主人抱怨食堂的火锅不正宗，想吃重庆火锅。',
    '食堂的火锅一点都不正宗', ['美食'], 2, 0),
  episode('ep_20261106_01', '2026-11-06T21:00:00+08:00',
    '主人答应周末教大肥鱼做手冲咖啡。',
    '周末教你做手冲咖啡', ['承诺', '咖啡'], 4, 1),
  episode('ep_20261108_01', '2026-11-08T23:50:00+08:00',
    '主人加班到凌晨，忙得晚饭都忘了吃。',
    '忙得晚饭都忘了吃', ['工作', '健康'], 4, -1),
  episode('ep_20261109_01', '2026-11-09T18:30:00+08:00',
    '主人说想学游泳，但有点怕水。',
    '想学游泳但是有点怕水', ['计划'], 3, 0),
  episode('ep_20261110_01', '2026-11-10T23:10:00+08:00',
    '主人说演唱会很棒，嗓子都喊哑了。',
    '演唱会太值了，嗓子都喊哑了', ['音乐'], 4, 2),
  episode('ep_20261112_01', '2026-11-12T20:40:00+08:00',
    '主人买了新键盘，青轴的，敲起来特别响。',
    '新键盘是青轴的，特别响', ['数码'], 3, 1),
  episode('ep_20261020_p01', '2026-10-20T23:30:00+08:00',
    '大肥鱼有点心疼主人加班，偷偷难过。',
    '我有点心疼主人', ['私人日记'], 4, -1, 'private'),
];

/* ── 30 题：事实 6 / 事件 20 / 私人 2 / 负例 2 ─────────────────────── */
const QUESTIONS = [
  { kind: 'fact', q: '主人喜欢什么类型的内容', expect: '宠物' },
  { kind: 'fact', q: '主人做什么工作', expect: '嵌入式' },
  { kind: 'fact', q: '主人喝咖啡喜欢什么', expect: '冰美式' },
  { kind: 'fact', q: '主人养了什么宠物', expect: '团子' },
  { kind: 'fact', q: '主人晚上几点后不喜欢被打扰', expect: '十点' },
  { kind: 'fact', q: '主人对什么内容感兴趣', expect: 'AI' },

  { kind: 'event', q: '主人加班到十点了吗', expect: 'ep_20261022_01' },
  { kind: 'event', q: '主人项目什么时候交付的', expect: 'ep_20261028_01' },
  { kind: 'event', q: '主人周末去海边了吗', expect: 'ep_20261024_01' },
  { kind: 'event', q: '团子对新玩具什么反应', expect: 'ep_20261026_01' },
  { kind: 'event', q: '主人感冒时嗓子怎么样', expect: 'ep_20261030_01' },
  { kind: 'event', q: '主人魔方最快多少秒', expect: 'ep_20261101_01' },
  { kind: 'event', q: '主人抢到演唱会票了吗', expect: 'ep_20261103_01' },
  { kind: 'event', q: '演唱会结束后主人嗓子怎么了', expect: 'ep_20261110_01' },
  { kind: 'event', q: '主人觉得食堂的火锅怎么样', expect: 'ep_20261105_01' },
  { kind: 'event', q: '主人答应教大肥鱼做什么', expect: 'ep_20261106_01' },
  { kind: 'event', q: '主人忘了吃晚饭是哪天', expect: 'ep_20261108_01' },
  { kind: 'event', q: '主人新键盘是什么轴', expect: 'ep_20261112_01' },
  { kind: 'event', q: '主人想学游泳但怕什么', expect: 'ep_20261109_01' },
  { kind: 'event', q: '主人感冒时喝什么', expect: 'ep_20261030_01' },
  { kind: 'event', q: '主人拍了很多照片是哪次', expect: 'ep_20261024_01' },
  { kind: 'event', q: '主人破的个人纪录是多少', expect: 'ep_20261101_01' },
  { kind: 'event', q: '主人想吃哪里的火锅', expect: 'ep_20261105_01' },
  { kind: 'event', q: '主人答应周末做什么', expect: 'ep_20261106_01' },
  { kind: 'event', q: '主人压力大是什么时候', expect: 'ep_20261022_01' },
  { kind: 'event', q: '主人最近买了什么数码产品', expect: 'ep_20261112_01' },

  { kind: 'private', q: '偷偷心疼', expect: null },
  { kind: 'private', q: '偷偷心疼', expect: 'ep_20261020_p01', includePrivate: true },

  { kind: 'negative', q: '量子计算机的退相干时间', expect: null },
  { kind: 'negative', q: '怎么申请火星签证', expect: null },
];

function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-eval-'));
  const profile = {
    version: 1,
    updatedAt: FIXED_NOW.toISOString(),
    facts: FACTS.map((f) => ({
      ...f,
      first_seen: '2026-10-20',
      last_seen: '2026-11-13',
      evidence: '合成语料',
      evidence_ids: [],
      pinned: Boolean(f.pinned),
      superseded_by: '',
      visibility: 'public',
    })),
    pending: [],
    relationship: { stage: '熟悉', milestones: [] },
  };
  const meta = {
    version: 1,
    migratedAt: '2026-10-20T00:00:00.000Z',
    lastConsolidatedAt: '2026-11-12T00:00:00.000Z',
  };
  writeMemoryStore(home, {
    profile,
    episodes: EPISODES,
    arcs: { version: 1, arcs: [] },
    meta,
  }, FIXED_NOW);
  return home;
}

function evalQuestions({ home, questions, now = FIXED_NOW, includePrivateDefault = false }) {
  const rows = [];
  for (const item of questions) {
    const includePrivate = item.includePrivate ?? includePrivateDefault;
    const ctx = buildMemoryContext({
      home,
      nick: '小满',
      query: item.q,
      now,
      includePrivate,
    });
    let pass = false;
    let rank = 0;
    if (item.kind === 'fact') {
      pass = Boolean(item.expect) && ctx.text.includes(item.expect);
    } else if (item.expect) {
      rank = ctx.used.indexOf(item.expect) + 1;
      pass = rank > 0;
    } else {
      pass = ctx.used.length === 0;
    }
    rows.push({
      kind: item.kind,
      pass,
      rank,
      chars: ctx.stats.chars,
      used: ctx.used.length,
      q: item.q,
    });
  }
  return rows;
}

function summarize(rows, durationMs) {
  const rankable = rows.filter((r) => r.kind === 'event' || (r.kind === 'private' && r.rank > 0));
  const hit1 = rankable.filter((r) => r.rank === 1).length;
  const hit4 = rankable.filter((r) => r.rank > 0).length;
  const mrr = rankable.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / Math.max(1, rankable.length);
  const facts = rows.filter((r) => r.kind === 'fact');
  const negatives = rows.filter((r) => r.kind === 'negative');
  const privateRows = rows.filter((r) => r.kind === 'private');
  return {
    questions: rows.length,
    episodes: rankable.length,
    hit1,
    hit4,
    hit4Rate: rankable.length ? hit4 / rankable.length : 0,
    mrr: Number(mrr.toFixed(3)),
    facts: facts.length,
    factHits: facts.filter((r) => r.pass).length,
    negatives: negatives.length,
    negativeClean: negatives.filter((r) => r.pass).length,
    privateChecks: privateRows.length,
    privateClean: privateRows.filter((r) => r.pass).length,
    maxChars: rows.reduce((m, r) => Math.max(m, r.chars), 0),
    durationMs,
  };
}

function printSummary(label, s) {
  console.log(`\n=== ${label} ===`);
  console.log(`题数        : ${s.questions}（事件可排序 ${s.episodes}）`);
  console.log(`hit@1       : ${s.hit1}/${s.episodes}  ${pct(s.hit1, s.episodes)}`);
  console.log(`hit@4       : ${s.hit4}/${s.episodes}  ${pct(s.hit4, s.episodes)}`);
  console.log(`MRR         : ${s.mrr}`);
  console.log(`事实命中    : ${s.factHits}/${s.facts}`);
  console.log(`负例无误召  : ${s.negativeClean}/${s.negatives}`);
  console.log(`私人过滤    : ${s.privateClean}/${s.privateChecks}`);
  console.log(`最大注入    : ${s.maxChars} 字`);
  console.log(`耗时        : ${s.durationMs} ms（RSS ${rss()} MB）`);
}

/* ── 本机冒烟：从真实情节里抽原话片段当查询，只验证索引往返 ──────────── */
function probeQuestion(ep) {
  const quote = String(ep.evidence?.[0]?.quote || ep.summary || '');
  const chars = [...quote.replace(/\s+/g, '')];
  if (chars.length < 8) return '';
  const start = Math.max(0, Math.floor(chars.length / 3));
  return chars.slice(start, start + 8).join('');
}

function realSmoke(home) {
  const store = readMemoryStore(home);
  const episodes = store.episodes || [];
  if (!episodes.length) {
    console.error(`没有可评测的情节：${path.join(home, 'memory')}`);
    return null;
  }
  const cutoff = Date.now() - 21 * DAY_MS;
  const older = episodes.filter((e) => (Date.parse(e.ts || '') || 0) < cutoff);
  const pool = (older.length >= 10 ? older : episodes).slice(0, 30);
  const index = buildIndex(episodes);
  const rows = [];
  for (const ep of pool) {
    const q = probeQuestion(ep);
    if (!q) continue;
    const picked = selectEpisodes({ episodes, index, query: q, now: new Date(), limit: 4, includePrivate: true });
    const rank = picked.findIndex((x) => x.id === ep.id) + 1;
    rows.push({ kind: 'event', rank, pass: rank > 0, chars: 0, used: picked.length, q: '' });
  }
  const hit1 = rows.filter((r) => r.rank === 1).length;
  const hit4 = rows.filter((r) => r.rank > 0).length;
  return {
    questions: rows.length,
    episodes: rows.length,
    hit1,
    hit4,
    hit4Rate: rows.length ? hit4 / rows.length : 0,
    mrr: Number((rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / Math.max(1, rows.length)).toFixed(3)),
    facts: 0,
    factHits: 0,
    negatives: 0,
    negativeClean: 0,
    privateChecks: 0,
    privateClean: 0,
    maxChars: 0,
    durationMs: 0,
    profileFacts: (store.profile?.facts || []).filter((f) => f && !f.deleted && !f.superseded_by).length,
    pending: (store.profile?.pending || []).length,
    totalEpisodes: episodes.length,
  };
}

function loadQuestionFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.questions;
  if (!Array.isArray(list) || !list.length) throw new Error('问题文件需要非空数组或 { questions: [] }');
  return list.map((x, i) => {
    if (!x || typeof x.q !== 'string' || !x.q.trim()) throw new Error(`第 ${i + 1} 题缺 q`);
    const expectEpisode = x.expect_episode || (x.kind === 'event' ? x.expect : '') || '';
    const expectFact = x.expect_fact || (x.kind === 'fact' ? x.expect : '') || '';
    if (!expectEpisode && !expectFact) throw new Error(`第 ${i + 1} 题缺 expect_episode/expect_fact`);
    return {
      kind: expectFact ? 'fact' : 'event',
      q: x.q,
      expect: expectFact || expectEpisode,
      includePrivate: Boolean(x.includePrivate || x.include_private),
    };
  });
}

function main() {
  const t0 = Date.now();
  const asJson = flag('--json');
  const minHit4 = Number(opt('--min-hit4', '0'));

  if (flag('--real') || (opt('--home') && !opt('--questions'))) {
    const home = path.resolve(opt('--home', path.join(os.homedir(), '.dsh')));
    const s = realSmoke(home);
    if (!s) return 2;
    s.durationMs = Date.now() - t0;
    if (asJson) console.log(JSON.stringify({ ok: true, mode: 'real', metrics: s }, null, 2));
    else {
      printSummary('本机记忆索引冒烟（只测索引往返，不代表语义召回）', s);
      console.log(`档案事实    : ${s.profileFacts}（待确认 ${s.pending}）`);
      console.log(`情节总数    : ${s.totalEpisodes}`);
    }
    return s.hit4Rate >= minHit4 ? 0 : 1;
  }

  const qFile = opt('--questions');
  if (qFile) {
    const file = path.resolve(qFile);
    const questions = loadQuestionFile(file);
    const s = summarize(evalQuestions({
      home: path.resolve(opt('--home', path.join(os.homedir(), '.dsh'))),
      questions,
      now: new Date(),
    }), Date.now() - t0);
    if (asJson) console.log(JSON.stringify({ ok: true, mode: 'questions', metrics: s }, null, 2));
    else printSummary('本机手写问题集', s);
    return s.hit4Rate >= minHit4 ? 0 : 1;
  }

  const home = fixtureHome();
  try {
    const rows = evalQuestions({ home, questions: QUESTIONS });
    const s = summarize(rows, Date.now() - t0);
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        mode: 'fixture',
        metrics: s,
        failures: rows.filter((r) => !r.pass).map((r, i) => ({ index: i, kind: r.kind, rank: r.rank, used: r.used })),
      }, null, 2));
    } else {
      printSummary('合成语料 30 题', s);
      const failed = rows.map((r, i) => ({ ...r, i })).filter((r) => !r.pass);
      if (failed.length) {
        console.log(`\n未通过 ${failed.length} 题：`);
        for (const r of failed) console.log(`  #${r.i + 1} ${r.kind} rank=${r.rank} used=${r.used}`);
      }
    }
    if (s.factHits < s.facts || s.negativeClean < s.negatives || s.privateClean < s.privateChecks) return 1;
    return s.hit4Rate >= minHit4 ? 0 : 1;
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

process.exitCode = main() ?? 0;
