#!/usr/bin/env node
/**
 * tools/memory-export.mjs —— 大肥鱼记忆导出/备份到私有 GitCode 仓库。
 *
 * 记忆含私人对话/日记，只能进私有仓库（默认 dsh-douyin-whale-memory），
 * 永远不要推到公开的 dsh-douyin-whale 或 GitHub。
 *
 * 用法：
 *   node tools/memory-export.mjs --export [--home <dir>] [--out <dir>]
 *   node tools/memory-export.mjs --push   [--home <dir>] [--repo <url>] [--out <dir>]
 *   node tools/memory-export.mjs --verify [--repo <url>] [--json]
 *
 *   --export  导出 memory/ + 两本日记 + whale-mood.json 到 staging，生成 manifest + README
 *   --push    导出后克隆远端私有仓（不存在则 init），整树替换后 commit + push（保留历史）
 *   --verify  克隆远端，按 manifest 逐文件比对 sha256/bytes
 *
 * 退出码：0 正常；1 校验失败/推送失败；2 用法/文件错误。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOME = path.join(os.homedir(), '.dsh');
export const DEFAULT_REPO = 'https://gitcode.com/uzibuxing/dsh-douyin-whale-memory.git';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

/** 导出清单：相对 ~/.dsh 的路径；不存在的文件跳过（新机可能还没有 mood）。 */
const EXPORT_FILES = [
  'memory/profile.json',
  'memory/episodes.jsonl',
  'memory/arcs.json',
  'memory/index.json',
  'memory/meta.json',
  // 共现边是「用出来的」关联，重建不了；轨迹用于星图回放
  'memory/links.jsonl',
  'memory/traces.jsonl',
  'memory/dm-*.json',
  'whale-diary.md',
  'whale-diary-private.md',
  'whale-mood.json',
];
/** 记忆目录里不进迁移包的运行时文件。 */
const MEMORY_EXCLUDE = new Set(['consolidate.lock', 'session-epochs.json']);
const isExcluded = (rel) => {
  const name = path.basename(rel);
  return MEMORY_EXCLUDE.has(name) || name.endsWith('.tmp') || name.endsWith('.lock');
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const maskRel = (rel) => rel.replace(/dm-.*\.json$/, 'dm-<redacted>.json');

/** 展开 exportList：存在的文件 → [{ src, rel }]，不存在跳过。 */
export function exportList(home) {
  const root = path.resolve(home || DEFAULT_HOME);
  const out = [];
  for (const pattern of EXPORT_FILES) {
    if (pattern.includes('*')) {
      const dir = path.join(root, path.dirname(pattern));
      const prefix = path.basename(pattern).replace('*.json', '');
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        const rel = path.join(path.dirname(pattern), name).split(path.sep).join('/');
        if (!name.startsWith(prefix) || !name.endsWith('.json') || isExcluded(rel)) continue;
        const src = path.join(root, rel);
        if (fs.statSync(src).isFile()) out.push({ src, rel });
      }
    } else {
      const rel = pattern;
      if (isExcluded(rel)) continue;
      const src = path.join(root, rel);
      if (fs.existsSync(src) && fs.statSync(src).isFile()) out.push({ src, rel });
    }
  }
  return out;
}

/** 汇总计数（只读条数，不读内容到输出）。 */
function collectCounts(staging) {
  const readJson = (rel) => {
    try { return JSON.parse(fs.readFileSync(path.join(staging, rel), 'utf8')); } catch { return null; }
  };
  const profile = readJson('memory/profile.json') || {};
  const arcs = readJson('memory/arcs.json') || {};
  let episodes = 0;
  try {
    episodes = fs.readFileSync(path.join(staging, 'memory/episodes.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).length;
  } catch { /* 没有 episodes 文件 */ }
  let dmMessages = 0;
  for (const { rel } of exportList(staging).filter((f) => f.rel.startsWith('memory/dm-'))) {
    const dm = readJson(rel);
    dmMessages += Array.isArray(dm?.messages) ? dm.messages.length : 0;
  }
  return {
    episodes,
    facts: (profile.facts || []).filter((f) => f && !f.deleted && !f.superseded_by).length,
    arcs: (arcs.arcs || []).length,
    dmMessages,
  };
}

function writeReadme(staging) {
  fs.writeFileSync(path.join(staging, 'README.md'), [
    '# 大肥鱼记忆迁移包（私有）',
    '',
    '> 这个仓库只用于把记忆迁移到常驻机器。',
    '> 含私人对话、私人日记和情绪状态，**禁止公开、禁止转发**。',
    '',
    '## 怎么恢复',
    '',
    '1. 先在目标机备份 `~/.dsh/memory/` 和两本日记。',
    '2. 把本仓库的 `memory/` 目录内容复制到目标机 `~/.dsh/memory/`。',
    '3. 把 `whale-diary.md`、`whale-diary-private.md`、`whale-mood.json` 复制到目标机 `~/.dsh/`。',
    '4. 不要复制 `session-epochs.json`（本包也没有）：新机的值班会话应从 `douyin-whale-duty-v2` 重新开始。',
    '5. 重启 DSH 宿主或调度器，检查面板「记忆」卡的数量是否一致。',
    '',
    '## 校验',
    '',
    '`manifest.json` 里有每个文件的 sha256 和字节数，恢复后可逐个比对；',
    '开发机上跑 `node tools/memory-export.mjs --verify` 一键核对。',
    '',
    '## 注意',
    '',
    '- 本包不含 cookie、登录态、配置里的 API key。',
    '- `index.json` 可由 `episodes.jsonl` 重建，保留只是为了恢复后立即可检索。',
    '- `links.jsonl` 是「一起被想起」学出来的共现边，`traces.jsonl` 是最近想起轨迹；两者都不可重建，一并迁移。',
  ].join('\n') + '\n', 'utf8');
}

/** 导出：清空/新建 staging，复制文件，写 manifest/README。 */
export function stageExport({ home, out } = {}) {
  const root = path.resolve(home || DEFAULT_HOME);
  if (!fs.existsSync(root)) throw new Error(`home 不存在: ${root}`);
  const staging = path.resolve(out || fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memory-export-')));
  if (out && fs.existsSync(path.join(staging, '.git'))) {
    throw new Error(`--out 指向的是 git 仓库，拒绝清空: ${staging}`);
  }
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const rows = [];
  for (const { src, rel } of exportList(root)) {
    const dest = path.join(staging, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = fs.readFileSync(src);
    fs.writeFileSync(dest, buf);
    rows.push({ path: rel, bytes: buf.length, sha256: sha256(buf) });
  }
  if (!rows.length) throw new Error('没有可导出的记忆文件（home 里是空的？）');
  const manifest = {
    // 不放时间戳：内容没变时重复 --push 不产生空 commit
    private: true,
    source: 'memory-export',
    note: '含私人对话/日记；仅用于迁移，禁止公开',
    counts: collectCounts(staging),
    files: rows,
  };
  fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeReadme(staging);
  fs.writeFileSync(path.join(staging, '.gitattributes'),
    '# 记忆迁移包必须逐字节保真：禁止 Git 做换行转换，否则 manifest 的 sha256 会对不上。\n* -text\n', 'utf8');
  return { staging, manifest };
}

function git(cwd, args, { allowRetryIdentity = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
  } catch (e) {
    const stderr = String(e?.stderr ?? '');
    if (allowRetryIdentity && /identity|user\.name|user\.email/i.test(stderr)) {
      return execFileSync('git', [
        '-c', 'user.name=whale-export', '-c', 'user.email=whale-export@local', ...args,
      ], { cwd, encoding: 'utf8', timeout: 120_000 });
    }
    throw e;
  }
}

/** 把 staging 的受管文件克隆进 worktree（保留 .git），返回被替换/删除的旧文件数。 */
function replaceTree(worktree, staging) {
  const keep = new Set(['.git']);
  let removed = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(worktree, full);
      if (keep.has(rel) || keep.has(rel.split(path.sep)[0])) continue;
      if (entry.isDirectory()) walk(full);
      else { fs.rmSync(full); removed += 1; }
    }
  };
  walk(worktree);
  for (const { src, rel } of exportList(staging)) {
    const dest = path.join(worktree, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  for (const file of ['manifest.json', 'README.md', '.gitattributes']) {
    fs.copyFileSync(path.join(staging, file), path.join(worktree, file));
  }
  return removed;
}

/** 导出并推送到私有仓库；远端保留 commit 历史，整树替换。 */
export function pushExport({ home, repo = DEFAULT_REPO, out } = {}) {
  const { staging, manifest } = stageExport({ home, out });
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memory-push-'));
  let cloned = false;
  try {
    try {
      git(worktree, ['clone', '--depth', '50', repo, '.']);
      cloned = true;
    } catch { /* 空仓库/本地不存在 → init */ }
    if (!cloned) {
      git(worktree, ['init', '-b', 'master']);
      git(worktree, ['remote', 'add', 'origin', repo]);
    }
    // 远端默认分支可能不是 master：统一把本地 master 对齐到当前 HEAD 再推
    try { git(worktree, ['checkout', '-B', 'master']); } catch { /* 空仓库 unborn HEAD 也允许 */ }
    const removed = replaceTree(worktree, staging);
    git(worktree, ['add', '-A']);
    const status = git(worktree, ['status', '--porcelain']);
    if (!status.trim()) {
      return { ok: true, unchanged: true, repo, manifest, removed };
    }
    git(worktree, ['commit', '-m', `chore: 大肥鱼记忆迁移包 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`], { allowRetryIdentity: true });
    try {
      git(worktree, ['push', '-u', 'origin', 'HEAD:master']);
    } catch (e) {
      const msg = String(e?.stderr ?? e?.message ?? e);
      if (/fetch first|non-fast-forward|behind/i.test(msg)) {
        // 远端有分歧历史：迁移包以最新导出为准，强推覆盖（旧历史丢弃）
        git(worktree, ['push', '--force', '-u', 'origin', 'HEAD:master']);
      } else {
        throw e;
      }
    }
    return { ok: true, repo, manifest, removed };
  } catch (e) {
    return {
      ok: false,
      repo,
      staging,
      error: String(e?.stderr ?? e?.message ?? e).slice(-400),
    };
  } finally {
    // staging 含私人内容：显式 --out 才保留，否则用完即删
    if (!out) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

/** 按 manifest 比对一个目录（clone 结果或 staging）。 */
export function compareManifest(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const bad = [];
  const missing = [];
  for (const row of manifest.files || []) {
    const file = path.join(dir, row.path);
    if (!fs.existsSync(file)) { missing.push(row.path); continue; }
    const buf = fs.readFileSync(file);
    if (buf.length !== row.bytes || sha256(buf) !== row.sha256) bad.push(row.path);
  }
  return { files: (manifest.files || []).length, bad, missing, counts: manifest.counts || null };
}

/** 克隆远端并校验。 */
export function verifyRepo({ repo = DEFAULT_REPO } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memory-verify-'));
  try {
    git(tmp, ['clone', '--depth', '1', repo, 'check']);
    const result = compareManifest(path.join(tmp, 'check'));
    return { ok: result.bad.length === 0 && result.missing.length === 0, repo, ...result };
  } catch (e) {
    return { ok: false, repo, error: String(e?.stderr ?? e?.message ?? e).slice(-400) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function printSummary(title, obj) {
  console.log(`=== ${title} ===`);
  for (const [k, v] of Object.entries(obj)) console.log(`${k.padEnd(10)}: ${v}`);
}

function main() {
  const home = opt('--home', DEFAULT_HOME);
  const out = opt('--out');
  const repo = opt('--repo', DEFAULT_REPO);
  const asJson = flag('--json');

  if (!flag('--export') && !flag('--push') && !flag('--verify')) {
    console.error('用法: node tools/memory-export.mjs --export|--push|--verify [--home <dir>] [--out <dir>] [--repo <url>] [--json]');
    return 2;
  }

  if (flag('--verify')) {
    const r = verifyRepo({ repo });
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else {
      printSummary('记忆仓库校验', {
        repo: r.repo,
        文件数: r.files ?? 0,
        不匹配: (r.bad ?? []).length,
        缺失: (r.missing ?? []).length,
        结果: r.ok ? 'PASS' : `FAIL ${r.error ?? ''}`,
      });
      for (const p of [...(r.bad ?? []), ...(r.missing ?? [])]) console.log(`  ✗ ${p}`);
    }
    return r.ok ? 0 : 1;
  }

  if (flag('--push')) {
    const r = pushExport({ home, repo, out });
    if (asJson) {
      console.log(JSON.stringify({ ...r, manifest: r.manifest ? { counts: r.manifest.counts, files: r.manifest.files.length } : undefined }, null, 2));
    } else if (r.ok) {
      printSummary('记忆导出并推送', {
        仓库: r.repo.replace(/^https:\/\/[^/]*@/, ''),
        文件数: r.manifest.files.length,
        清理旧文件: r.removed ?? 0,
        变化: r.unchanged ? '无变化，未提交' : '已提交并推送',
        计数: JSON.stringify(r.manifest.counts),
      });
    } else {
      console.error(`推送失败：${r.error}`);
      return 1;
    }
    return r.ok ? 0 : 1;
  }

  const { staging, manifest } = stageExport({ home, out });
  if (asJson) console.log(JSON.stringify({ staging, counts: manifest.counts, files: manifest.files.length }, null, 2));
  else {
    printSummary('记忆导出', {
      staging,
      文件数: manifest.files.length,
      计数: JSON.stringify(manifest.counts),
      提示: '--push 推到私有仓库；staging 含私人内容，用完即删',
    });
    for (const row of manifest.files) console.log(`  · ${maskRel(row.path)}（${row.bytes} B）`);
  }
  return 0;
}

// 直接执行才进 main；被测试 import 时不跑（argv[1] 是测试文件）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main() ?? 0;
}
