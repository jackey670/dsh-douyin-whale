# v1.9.3 — 回合主循环合并（架构合并收官）

> 调度器和值班大脑的 tick 主体收进一个共享引擎，改一处两边生效。

## 变更

- **`lib/whale_round.js` — `runWatchRound` 引擎**
  - 队列合并 → 挑最早 → 下载贴图 → 建提示词 → 写标记 → 投递 → 等空闲 →
    回读确认 → 推进状态，全部共享。
  - 调度器只剩：重入守卫、时段/开关检查、brain 适配器（`wakeAgent`）、
    唤醒失败文案、response 登录检测。
  - 值班大脑只剩：登录冷却、brain 适配器（`dutyAgent.send/awaitIdle`）、
    空转日志 + 主动分享轮。
  - 纯注入：`state = { read, update }`、`ops = { mergeQueue, pendingOf,
    bumpAttempt, capRepliedIds, maxAttempts }`，两边模块语义已验证等价。
- **`lib/dm_reader.js`**：两份 checkDm 合一（文件回退 + 本轮重试 + `{__error}`）。
- **修复**：`scheduler/state.mjs` 丢 `shares` 字段——调度器每次写状态都会把
  插件累计的分享计数清零；现在透传、跨天清零。
- **行为统一**（3 处）：
  1. fiber 读不到发送方时，两条路径都在**投递前** bail（调度器以前白烧一轮）；
  2. 调度器「未确认到私信」日志升级为详细判据格式；
  3. 观看窗口空数组 = 全天开放（原来调度器视为全天空窗）。

## 验证

- 新增引擎单测 8 项 + state shares 断言；旧 tick 测试 12 项全数保留并通过。
- 真机：`--dry-tick` / `--watch-now` / 引擎空转路径正常。
- `npm test`：Python 32 + JS 94 全绿；发版审计 34 项通过。

## 兼容

- 不改发送语义与安全闸；`whale_tick` / scheduler 对外导出全部保留。
