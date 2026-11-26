/**
 * tools/release-pack.test.mjs —— 打包：文件清单/版本/sha256/敏感路径不出包。
 *
 * 不上传网络，只跑 `--no-upload`。
 * 运行：node tools/release-pack.test.mjs
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tool = path.join(root, 'tools', 'release-pack.mjs');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pack-'));
let pass = 0;
const ok = (name) => { pass += 1; console.log(`[PASS] ${name}`); };

try {
  const stdout = execFileSync(process.execPath, [tool, '--no-upload', '--out', out], {
    cwd: root, encoding: 'utf8',
  });
  const tarball = path.join(out, `dsh-douyin-whale-${pkg.version}.tgz`);
  assert.ok(fs.existsSync(tarball), `tarball 存在：${path.basename(tarball)}`);
  assert.match(stdout, /--no-upload：跳过 GitHub Release 上传/);

  const shaFile = `${tarball}.sha256`;
  assert.ok(fs.existsSync(shaFile), 'sha256 文件存在');
  const shaText = fs.readFileSync(shaFile, 'utf8').trim();
  const actual = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  assert.equal(shaText.split(/\s+/)[0], actual, 'sha256 与包内容一致');
  assert.match(shaText, new RegExp(`dsh-douyin-whale-${pkg.version.replace(/\./g, '\\.')}\\.tgz$`));

  const list = execFileSync('tar', ['-tzf', path.basename(tarball)], { cwd: out, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((s) => s.replace(/^package\//, ''));
  assert.ok(list.includes('package.json'));
  assert.ok(list.includes('lib/memory_layers.js'), '运行时模块在包里');
  assert.ok(list.includes('client.js'), '面板半端在包里');
  assert.ok(list.includes('docs/UPGRADE.md'), '运维手册在包里');
  assert.ok(list.includes('tools/release-pack.mjs'), '工具自身在包里');
  const leaked = list.filter((f) => /^(data|memory)\/|cookie.*\.json|credential|storage_state|whale-chat|(^|\/)dm-.*\.json/i.test(f));
  assert.deepEqual(leaked, [], `包内不能有敏感文件，实际：${leaked.join(', ')}`);
  ok(`打包白名单（${list.length} 个文件，无敏感路径）`);

  const packed = JSON.parse(execFileSync('tar', ['-xzOf', path.basename(tarball), 'package/package.json'], {
    cwd: out, encoding: 'utf8',
  }));
  assert.equal(packed.version, pkg.version, '包内版本与仓库一致');
  ok('包内 package.json 版本一致');
} finally {
  try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nALL PASSED (${pass})`);
