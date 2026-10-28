#!/usr/bin/env node
/**
 * tools/whitebox-probe.mjs —— 白框取证探针
 *
 * 用与 scheduler.mjs 完全相同的参数跑一次 ZCode 唤醒，前后各拍一次
 * 「可见窗口 + 进程（含父进程）」快照，把差异写进 ~/.dsh/whitebox-probe.log。
 *
 * 什么时候跑：在 **ZCode 桌面窗口关闭** 的状态下跑一次——
 *   npm run probe:whitebox
 * 如果唤醒期间冒出新的 ZCode 窗口，日志会记下它的 PID、进程名、标题和父进程，
 * 白框的来源就定了；如果什么都没冒，说明已被 `--no-browser` 修掉。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOME = process.env.USERPROFILE || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const LOG_FILE = path.join(DSH_HOME, 'whitebox-probe.log');
const PROBE_DIR = path.join(HOME, '.zcode-probe-cwd');

const ZCODE_CLI = process.env.ZCODE_CLI || path.join(
  process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
  'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs',
);
const ZCODE_BUILTIN_PROVIDER = (() => {
  try {
    const p = path.resolve(path.dirname(ZCODE_CLI), '..', 'config', 'provider', 'zcode-builtin.json');
    return fs.existsSync(p) ? p : '';
  } catch { return '' }
})();

const lines = [];
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  lines.push(line);
  console.log(line);
};

/** 可见顶层窗口："pid|进程名|标题" */
function visibleWindows() {
  const ps = 'Get-Process | Where-Object {$_.MainWindowHandle -ne 0} '
    + '| ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)" }';
  try {
    const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    return (out.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return [] }
}

/** node/zcode 相关进程："pid|ppid|进程名|命令行前 200 字" */
function procSnapshot() {
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\' or Name=\'ZCode.exe\' or Name=\'zcode-agent.exe\'" '
    + '| ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }';
  try {
    const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    return (out.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.slice(0, 260));
  } catch { return [] }
}

const diff = (a, b) => b.filter((x) => !a.includes(x));

function main() {
  log(`=== whitebox probe 开始（ZCode CLI: ${ZCODE_CLI}）===`);
  const windowsBefore = visibleWindows();
  const zcodeWinBefore = windowsBefore.filter((w) => /\|ZCode(\.exe)?\|/i.test(w));
  const procsBefore = procSnapshot();
  log(`唤醒前：可见窗口 ${windowsBefore.length} 个（ZCode 窗口 ${zcodeWinBefore.length} 个）`
    + `，node/zcode 进程 ${procsBefore.length} 个`);
  if (zcodeWinBefore.length) log(`唤醒前 ZCode 窗口：${zcodeWinBefore.join(' ; ')}`);

  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const args = [
    ZCODE_CLI, '-p', '只回复 OK 两个字', '--cwd', PROBE_DIR,
    '--json', '--no-color', '--mode', 'yolo', '--surface', 'terminal', '--no-browser',
  ];
  log(`唤醒参数：node ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: PROBE_DIR,
    encoding: 'utf8',
    timeout: 150_000,
    windowsHide: true,
    env: {
      ...process.env,
      DOUYIN_HEADLESS: '1',
      ...(ZCODE_BUILTIN_PROVIDER ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: ZCODE_BUILTIN_PROVIDER } : {}),
    },
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  const replied = /"response"\s*:\s*"[^"]*OK/.test(r.stdout || '');
  log(`唤醒结束：exit=${r.status} 耗时=${secs}s ${replied ? '回复含 OK' : `输出尾部=${((r.stdout || '') + (r.stderr || '')).slice(-200).replace(/\n/g, ' ')}`}`);

  const windowsAfter = visibleWindows();
  const newWindows = diff(windowsBefore, windowsAfter);
  const procsAfter = procSnapshot();
  const newProcs = diff(procsBefore, procsAfter);

  log(`唤醒后：可见窗口 ${windowsAfter.length} 个，新增 ${newWindows.length} 个`);
  if (newWindows.length) {
    log('⚠️ 新增窗口：');
    for (const w of newWindows) log(`  + ${w}`);
  }
  log(`唤醒后 node/zcode 进程 ${procsAfter.length} 个，新增 ${newProcs.length} 个`);
  if (newProcs.length) {
    for (const p of newProcs) log(`  + ${p}`);
  }

  const verdict = newWindows.some((w) => /\|ZCode(\.exe)?\|/i.test(w))
    ? 'REPRODUCED：唤醒冒出了新的 ZCode 窗口'
    : (r.status === 0 ? 'CLEAN：无新窗口，唤醒正常完成' : 'INCONCLUSIVE：唤醒失败，无新窗口');
  log(`结论：${verdict}`);
  log('=== whitebox probe 结束 ===');

  fs.mkdirSync(DSH_HOME, { recursive: true });
  fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf8');
  console.log(`\n日志已写入：${LOG_FILE}`);
  console.log(verdict);
  return newWindows.some((w) => /\|ZCode(\.exe)?\|/i.test(w)) ? 2 : 0;
}

try { process.exitCode = main(); } catch (e) {
  log(`探针异常：${e.message}`);
  try { fs.mkdirSync(DSH_HOME, { recursive: true }); fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf8'); } catch {}
  process.exitCode = 1;
}
