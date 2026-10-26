#!/usr/bin/env node
/**
 * tools/release-audit.mjs —— 发版前的机械检查（对齐 dsh-douyin-scroll 的
 * release-audit 思路：能机器查的绝不靠人眼）。
 *
 * 检查项：
 *   ① package.json / CHANGELOG / RELEASE-*.md 三方版本一致
 *   ② files 白名单覆盖所有运行时文件（client.js / scheduler / start-whale）
 *   ③ dsh.client 段存在（面板能被注入的前提）
 *   ④ 测试文件都在（lib/*.test.mjs + tests/）
 *   ⑤ 工作区干净、无 cookie/storage_state 进 git
 *   ⑥ 语法全过（node --check 全量）
 *
 * 用法：node tools/release-audit.mjs [版本号]
 * 退出码 0 = 通过；非 0 = 有问题（逐条打印）。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = process.argv[2] || pkg.version;
const problems = [];
const oks = [];
const ok = (m) => oks.push(m);
const bad = (m) => problems.push(m);

// ① 三方版本一致
if (pkg.version !== version) bad(`package.json 版本 ${pkg.version} ≠ 目标 ${version}`);
else ok(`package.json 版本 = ${version}`);
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
if (!changelog.includes(`## ${version}`)) bad(`CHANGELOG 没有 ${version} 小节`);
else ok(`CHANGELOG 有 ${version} 小节`);
const releaseDoc = `RELEASE-${version}.md`;
if (!fs.existsSync(releaseDoc)) bad(`缺少 ${releaseDoc}`);
else ok(`${releaseDoc} 存在`);

// ② files 白名单
const need = ['client.js', 'douyin.mjs', 'index.js',
  'scheduler/scheduler.mjs', 'scheduler/memory.mjs',
  'scheduler/tools-deny.txt', 'scheduler/agent/AGENTS.md',
  'start-whale.cmd', 'start-whale.vbs', 'python/douyin_im.py',
  'python/douyin_http.py', 'tools/login_headless.py', 'tools/export_login_state.py'];
const whitelisted = (f) => (pkg.files ?? []).some((pat) => {
  // glob → 正则：** 递归、* 单段，其余字面（scheduler/*.mjs 要能覆盖子路径）
  const rx = new RegExp('^' + pat
    .replace(/[.+^{}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*/g, '[^/]*') + '$');
  return rx.test(f);
});
for (const f of need) {
  if (!fs.existsSync(f)) bad(`文件不存在: ${f}`);
  else if (!whitelisted(f)) bad(`files 白名单没覆盖: ${f}`);
  else ok(`files 覆盖 ${f}`);
}

// ③ dsh.client
if (pkg.dsh?.client?.platform === 'web' && (pkg.dsh.client.inject ?? []).length) {
  ok(`dsh.client 注入 ${pkg.dsh.client.inject.length} 个包`);
} else bad('package.json 缺 dsh.client 段（面板不会被注入）');

// ④ 测试文件
const testFiles = ['tests/test_safety.py', 'tests/test_readback.py', 'tests/test_send_gate.py',
  'tests/test_fixture.py', 'scheduler/memory.test.mjs', 'lib/panel.test.mjs',
  'lib/panel_api.test.mjs', 'lib/duty_agent.test.mjs', 'lib/whale_tick.test.mjs'];
for (const f of testFiles) {
  if (fs.existsSync(f)) ok(`测试在 ${f}`);
  else bad(`测试缺失: ${f}`);
}

// ⑤ git 工作区 + 凭证不入库
let status = '';
try { status = execSync('git status --porcelain', { encoding: 'utf8' }); } catch { /* */ }
if (status.trim()) bad(`工作区不干净：\n${status.slice(0, 300)}`);
else ok('工作区干净');
const tracked = (() => {
  try { return execSync('git ls-files', { encoding: 'utf8' }).split('\n'); } catch { return []; }
})();
for (const f of tracked) {
  if (/cookie|storage_state/i.test(f) && !f.endsWith('.example') && !f.endsWith('-GUIDE.md')) {
    bad(`凭证文件被 git 跟踪: ${f}`);
  }
}
if (!problems.some((p) => p.includes('凭证'))) ok('无凭证文件被 git 跟踪');

// ⑥ 语法全过
for (const cmd of ['npm run check', 'npm test']) {
  try {
    execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
    ok(`${cmd} 通过`);
  } catch (e) {
    bad(`${cmd} 失败：${String(e.stderr ?? e.message).slice(0, 300)}`);
  }
}

console.log(oks.map((m) => `[OK]   ${m}`).join('\n'));
if (problems.length) {
  console.error('\n' + problems.map((m) => `[FAIL] ${m}`).join('\n'));
  console.error(`\n发版审计未通过：${problems.length} 项`);
  process.exit(1);
}
console.log(`\n发版审计通过（${oks.length} 项），version=${version}`);
