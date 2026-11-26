/**
 * lib/memory_lock.js —— 记忆库单写者锁。
 *
 * 独立成模块是为了打破循环依赖：memory_layers（存储）和 memory_consolidate
 * （固化）都要用这把锁，而 consolidate 又依赖 layers。
 *
 * 签名与原 memory_consolidate.acquireMemoryLock(home, now) 完全一致：
 * 传的是记忆根目录（~/.dsh），锁文件在 <home>/memory/consolidate.lock。
 *
 * 语义：
 *   · `wx` 独占创建；
 *   · 拿不到返回 null（不是抛错）——调用方自己决定是跳过还是回 409；
 *   · 持有者进程已死视为陈旧锁，清掉重试一次；
 *   · 同一进程内重复获取同样返回 null（没有可重入，别嵌套调用）。
 */
import fs from 'node:fs';
import path from 'node:path';

const nowIso = (now = new Date()) => new Date(now).toISOString();
const lockFile = (home) => path.join(home, 'memory', 'consolidate.lock');

/** @param {string} home 记忆根目录（~/.dsh）
 *  @returns {(() => void) | null} 释放函数，或 null 表示被占用 */
export function acquireMemoryLock(home, now = new Date()) {
  const file = lockFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso(now) }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch { /* ignore */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      let stale = false;
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const pid = Number(j.pid);
        if (!pid) stale = true;
        else {
          try { process.kill(pid, 0); } catch { stale = true; }
        }
      } catch {
        stale = true;
      }
      if (!stale) return null;
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
  return null;
}

/** 锁文件路径（面板 busy 判定、测试都用它）。 */
export function memoryLockPath(home) {
  return lockFile(home);
}
