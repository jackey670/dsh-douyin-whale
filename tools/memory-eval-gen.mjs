#!/usr/bin/env node
/**
 * tools/memory-eval-gen.mjs —— 从本地真实记忆生成评测问题集（只在本机用）。
 *
 * 用法：
 *   node tools/memory-eval-gen.mjs                 # 读 ~/.dsh/memory，写 data/memory-eval-questions.json
 *   node tools/memory-eval-gen.mjs --home <dir>    # 指定记忆根目录（默认 dshHome）
 *   node tools/memory-eval-gen.mjs --out <file>    # 指定输出文件
 *   node tools/memory-eval-gen.mjs --events 26 --facts 5
 *
 * 生成规则：
 *   · 事件题：取公开情节的引文短语前 12 字，期望命中该情节；
 *   · 事实题：公开事实去掉「主人」前缀 + 「是什么情况？」，期望命中事实文本前 2 字；
 *   · 私人题：1 条默认不该召回（挑不撞公开情节的短语，期望 null），
 *             1 条显式 includePrivate 才命中（期望该情节 id）；
 *   · 负例：2 条无关技术问题，期望零命中。
 *
 * 隐私：题目来自真实记忆，**只写到 data/（已 gitignore），不回显正文、不入库**。
 * 产物交给 tools/memory-eval.mjs：
 *   node tools/memory-eval.mjs --questions data/memory-eval-questions.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome } from '../lib/whale_state.js';
import { searchMemory } from '../lib/memory_layers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, fallback = '') => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const num = (k, fallback) => {
  const n = Number(opt(k, ''));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const home = path.resolve(opt('--home', dshHome()));
const out = path.resolve(opt('--out', path.join(root, 'data', 'memory-eval-questions.json')));
const maxEvents = num('--events', 26);
const maxFacts = num('--facts', 5);

const epFile = path.join(home, 'memory', 'episodes.jsonl');
const profFile = path.join(home, 'memory', 'profile.json');
for (const f of [epFile, profFile]) {
  if (!fs.existsSync(f)) {
    console.error(`没有记忆文件：${f}\n先在面板里搜一次/聊几轮，或确认 --home 指对了。`);
    process.exit(1);
  }
}

const episodes = fs.readFileSync(epFile, 'utf8').trim().split('\n')
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
const profile = JSON.parse(fs.readFileSync(profFile, 'utf8'));

const clean = (s) => String(s || '').replace(/\s+/g, '');
const take = (s, n) => [...clean(s)].slice(0, n).join('');
const questions = [];

// 事件：取公开情节的引文短语当查询（近似「主人提到过…」）
const pub = episodes
  .filter((e) => e && e.visibility !== 'private' && e.summary)
  .sort((a, b) => (Date.parse(b.ts || '') || 0) - (Date.parse(a.ts || '') || 0));
for (const e of pub.slice(0, maxEvents)) {
  const text = take(e.evidence?.[0]?.quote || e.summary, 12);
  if (text.length >= 6) questions.push({ kind: 'event', q: text, expect: e.id });
}

// 事实：去掉「主人」前缀 + 疑问语气
for (const f of (profile.facts || [])
  .filter((x) => x && !x.deleted && x.visibility !== 'private')
  .slice(0, maxFacts)) {
  const key = clean(f.text).replace(/^主人/, '');
  if (key) {
    questions.push({
      kind: 'fact',
      q: `${key}是什么情况？`,
      expect: [...key].slice(0, 2).join(''),
    });
  }
}

// 私人：默认不该注入；显式 includePrivate 才命中。
// 默认检查要挑「不撞公开情节」的短语，否则命中的是公开条目，测不到过滤。
const priv = episodes.filter((e) => e && e.visibility === 'private' && e.summary).slice(0, 10);
let defaultProbe = null;
for (const e of priv) {
  const cand = take(e.evidence?.[0]?.quote || e.summary, 8);
  if (cand.length < 6) continue;
  const r = searchMemory({ home, q: cand, limit: 5, includePrivate: false });
  if (!(r.episodes || []).length) {
    defaultProbe = { kind: 'private', q: cand, expect: null };
    break;
  }
}
if (defaultProbe) questions.push(defaultProbe);
if (priv[1]) {
  questions.push({
    kind: 'private',
    q: take(priv[1].evidence?.[0]?.quote || priv[1].summary, 8),
    expect: priv[1].id,
    includePrivate: true,
  });
}

// 负例：跟记忆无关的技术问题，检索应零命中
questions.push({ kind: 'negative', q: '量子退火机的哈密顿量怎么写', expect: null });
questions.push({ kind: 'negative', q: '如何修理数控机床主轴', expect: null });

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({ questions }, null, 2)}\n`, 'utf8');
const kinds = questions.reduce((m, x) => { m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {});
console.log(`questions: ${questions.length} → ${out}`);
console.log(`kinds: ${JSON.stringify(kinds)}`);
console.log('题目正文含真实记忆，只在本机使用；data/ 已 gitignore。');
