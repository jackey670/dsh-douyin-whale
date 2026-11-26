#!/usr/bin/env node
/**
 * tools/release-pack.mjs —— 把当前版本打成交付 tarball，挂到对应的 GitHub Release。
 *
 * 用法：
 *   node tools/release-pack.mjs                    # npm pack + gh release upload
 *   node tools/release-pack.mjs --no-upload        # 只打包，不上传
 *   node tools/release-pack.mjs --tag v1.16.1      # 指定要挂的 release（默认 v<version>）
 *   node tools/release-pack.mjs --out data/tmp     # 打包输出目录（默认 data/tmp）
 *
 * 产出：
 *   <out>/dsh-douyin-whale-<version>.tgz
 *   <out>/dsh-douyin-whale-<version>.tgz.sha256
 *
 * 说明：npm pack 只按 package.json 的 files 白名单收文件，data/、cookies、
 * 任何 *credentials* 都不会进包。上传用 gh CLI，凭据由 gh 自己管，本工具不碰。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, fallback = '') => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const version = pkg.version;
const tag = opt('--tag', `v${version}`);
const outDir = path.resolve(root, opt('--out', 'data/tmp'));
const upload = !flag('--no-upload');
const isWin = process.platform === 'win32';
// npm 在 Windows 上是 .cmd，Node 不允许直接 spawn（EINVAL）；走 cmd /c 而不是
// shell:true，后者会把参数拼成字符串并发 DEP0190 警告。
const npmArgs = ['pack', '--json', '--pack-destination', outDir];
const npmSpawn = isWin
  ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...npmArgs]]
  : ['npm', npmArgs];

fs.mkdirSync(outDir, { recursive: true });
console.log(`打包 dsh-douyin-whale@${version} → ${outDir}`);
const pack = spawnSync(npmSpawn[0], npmSpawn[1], {
  cwd: root,
  encoding: 'utf8',
});
if (pack.status !== 0) {
  console.error(pack.stderr || pack.stdout || `npm pack 退出码 ${pack.status}`);
  process.exit(1);
}
let info;
try {
  [info] = JSON.parse(pack.stdout);
} catch {
  console.error(`npm pack 输出无法解析：\n${pack.stdout}`);
  process.exit(1);
}
const tarball = path.join(outDir, info.filename);
if (!fs.existsSync(tarball)) {
  console.error(`npm pack 说生成了 ${info.filename}，但文件不存在`);
  process.exit(1);
}

const sha = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
const shaFile = `${tarball}.sha256`;
fs.writeFileSync(shaFile, `${sha}  ${info.filename}\n`, 'utf8');
console.log(`tarball：${info.filename}（${Math.round(info.size / 1024)} KB，${info.entryCount} 个文件）`);
console.log(`sha256 ：${sha}`);

if (!upload) {
  console.log('--no-upload：跳过 GitHub Release 上传');
  process.exit(0);
}

const view = spawnSync('gh', ['release', 'view', tag, '--json', 'tagName'], {
  cwd: root, encoding: 'utf8',
});
if (view.status !== 0) {
  console.error(`GitHub Release ${tag} 不存在。先发版（tag + gh release create），再回来传包。`);
  console.error((view.stderr || '').trim());
  process.exit(2);
}
const up = spawnSync('gh', ['release', 'upload', tag, tarball, shaFile, '--clobber'], {
  cwd: root, encoding: 'utf8',
});
if (up.status !== 0) {
  console.error(up.stderr || up.stdout || `gh release upload 退出码 ${up.status}`);
  process.exit(up.status ?? 1);
}

const m = String(pkg.repository?.url || '').match(/github\.com[/:]([^/]+)\/([^/.]+)/);
const where = m ? `https://github.com/${m[1]}/${m[2]}/releases/tag/${tag}` : `release ${tag}`;
console.log(`已上传 tarball + sha256 → ${where}`);
