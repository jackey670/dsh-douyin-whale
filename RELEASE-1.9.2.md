# v1.9.2 — 两条路径共用回读与提示词

> 架构合并第一步：调度器和值班大脑不再各写一份「怎么算送达」「怎么派活」。

## 变更

- **共享回读 `lib/whale_readback.js`**
  - `meTextSet` / `meMediaCount` / `meCardIds` / `judgeDelivery` / `deliverySummary`
    全部收成纯函数。
  - 文字（新正文）、原生表情（媒体条数 +1）、分享卡片（item_id）三种送达形态
    一次判定；fiber 读不到时保守不确认。
  - `scheduler.mjs` 与 `whale_tick.js` 的 tick 都改用 `judgeDelivery`，日志措辞也统一。
- **共享提示词 `lib/whale_prompt.js`**
  - `buildWhaleTaskMessage({ mode })`：`tools` = 值班大脑（插件工具），
    `shell` = 独立调度器（Bash/Read + 日记）。
  - `scheduler/prompt.mjs` 与 `whale_tick.js` 的 `buildTaskMessage` 变成薄封装；
    以后加回复方式（比如再一种卡片）只改一处。
  - 文案与旧版逐字对比：text/sticker/note 完全一致；video 仅把「frames 失败」
    统一成「抽帧失败」。

## 验证

- 新增 13 个单测（回读 7 + 提示词 6），全量 `npm test` Python 32 + JS 85 全绿。
- 真机：调度器重启后第一轮用新共享代码投递并回读确认（24 字）。
- 发版审计 34 项通过。

## 兼容

- 不改任何发送/回读语义与安全闸；这是纯内部重构。
- v1.9.3 计划（D3）：把「一轮 tick」的主循环也抽成共享引擎，brain 用适配器接
  调度器唤醒 / 值班会话。
