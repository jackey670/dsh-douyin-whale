#!/usr/bin/env node
/**
 * tools/release-notes.mjs —— 从 CHANGELOG.md 抽出指定版本的正文。
 *
 * 发版说明只维护在 CHANGELOG 里；仓库不再放 RELEASE-x.y.z.md。
 * 用法：
 *   node tools/release-notes.mjs 1.14.0 > /tmp/notes.md
 *   gh release create v1.14.0 --notes-file /tmp/notes.md
 */
import fs from 'node:fs';

const version = String(process.argv[2] || '').trim();
if (!version) {
  console.error('用法: node tools/release-notes.mjs <版本>');
  process.exit(1);
}

const file = new URL('../CHANGELOG.md', import.meta.url);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## ${version}`));
if (start < 0) {
  console.error(`CHANGELOG 没有 ${version} 小节`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^## \d/.test(lines[i])) { end = i; break; }
}
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG ${version} 小节是空的`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
