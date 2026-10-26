/**
 * tools/run-py.mjs —— npm scripts 里用 .venv 的 Python，不依赖全局 python。
 *
 * 为什么需要：npm 在 Windows 上用 cmd.exe 跑脚本，`.venv/Scripts/python.exe`
 * 这种正斜杠路径 cmd 不认；而这台机器的全局 `python` 又不在 PATH。
 * 用 Node 选对解释器再转发参数，Windows / Linux 通吃。
 *
 * 用法：node tools/run-py.mjs -m pytest -q tests/test_safety.py
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  '.venv/Scripts/python.exe', // Windows venv
  '.venv/bin/python',         // POSIX venv
];
const py = candidates
  .map((c) => path.join(ROOT, c))
  .find((p) => existsSync(p)) || 'python';

const args = process.argv.slice(2);
if (args.includes('--which')) {
  console.log(py);
  process.exit(0);
}
const r = spawnSync(py, args, { stdio: 'inherit', cwd: ROOT });
process.exit(r.status ?? 1);
