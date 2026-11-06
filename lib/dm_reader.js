/**
 * lib/dm_reader.js —— 两条运行路径共享的「读一次私信」。
 *
 * 直启 python/douyin_im.py read（不走 HTTP，零 token）。
 * 2026-11-03：read 偶发 exit 0 + stdout 空（Node/Win 管道丢失，~1/8）——
 * Python 同时把 JSON 原子写到 DOUYIN_IM_OUT_FILE；stdout 空就读文件，
 * 再空本轮重试一次（读操作幂等，重试安全）。
 *
 * 返回：
 *   成功           → dm 数据（douyin_im.py 的 data）
 *   结构化错误     → { __error: code, message }（调用方可据此进登录冷却）
 *   两次都空/异常  → null
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function readDm({
  ownerNick, py, root, dataDir, log = () => {}, limit = 40,
}) {
  const dyData = dataDir || path.join(root, 'data');
  const imScript = path.join(root, 'python', 'douyin_im.py');
  const outFile = path.join(os.tmpdir(), `dy-im-read-${process.pid}-${Date.now()}.json`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const r = spawnSync(py, [imScript, 'read', '--from', ownerNick, '--limit', String(limit)], {
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          DOUYIN_DATA_DIR: dyData,
          DOUYIN_HEADLESS: '1',
          DOUYIN_IM_OUT_FILE: outFile,
        },
        timeout: 180_000,
        encoding: 'utf8',
        windowsHide: true,
      });
      let text = (r.stdout ?? '').trim();
      if (!text) {
        try { text = readFileSync(outFile, 'utf8').trim(); } catch { text = ''; }
        if (text) log('[dm-check] stdout 为空，已从回退文件读取');
      }
      try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
      if (!text) {
        log(`[dm-check] 输出为空（attempt ${attempt}/2，status=${r.status}，signal=${r.signal}）`);
        continue;
      }
      const raw = text.split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}';
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log(`[dm-check] 输出不是 JSON（attempt ${attempt}/2，status=${r.status}，`
          + `stdout=${(r.stdout ?? '').length}B，stderr=${(r.stderr ?? '').slice(-160)}）`);
        if (attempt === 1) continue;
        return null;
      }
      if (!parsed.ok) {
        const stderrTail = (r.stderr ?? '').trim().slice(-160);
        log(`[dm-check] 读私信失败: ${parsed.error?.message ?? 'unknown'}`
          + `（status=${r.status}，stdout尾部=${(r.stdout ?? '').slice(-160)}`
          + (stderrTail ? `，stderr=${stderrTail}` : '') + '）');
        // 结构化错误给调用方判断要不要进「登录失效冷却」；null 只表示读不到。
        return {
          __error: String(parsed.error?.code || 'unknown'),
          message: String(parsed.error?.message || 'unknown'),
        };
      }
      return parsed.data;
    } catch (e) {
      log(`[dm-check] 异常: ${e.message}`);
      return null;
    }
  }
  return null;
}
