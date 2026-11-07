# v1.11.0 — 调度器也能主动刷视频了

> 主动分享轮从值班大脑移植到调度器路径，两条路径都有「空闲时刷视频」。

## 新增

- **调度器主动分享 `maybeShareShell`**
  - 队列空闲时按 `proactiveShare.probability`（默认 0.08）唤醒 agent：
    `trending` / `search` 挑一条 → `share --send` 发原生卡片。
  - 回读按「我发的卡片 item_id === 标记里的 aweme」确认才计数。
- **`shouldProactiveShare`（lib/whale_round.js）**：五道闸统一成纯函数——
  开关 → 手动跳过 → 概率 → 每日上限 → 最小间隔
  （`proactiveShare.minIntervalMinutes`，默认 120 分钟）。
  调度器版每次尝试（无论成败）都落 `state.lastShareAt`，
  空队列的唤醒烧不穿 token。
- **`buildProactiveShareMessage({ mode })`**（lib/whale_prompt.js）：
  tools / shell 两种模式共用一份文案骨架；`scheduler/prompt.mjs` 出
  `buildSharePrompt` 薄封装。
- `scheduler/state.mjs` 透传 `lastShareAt`；`config.example.json` 补
  `meme` / `proactiveShare` 两节（含 minIntervalMinutes）。

## 验证

- 引擎闸门单测 + 两种模式分享提示词单测 + state 透传断言。
- `npm test`：Python 32 + JS 103 全绿；发版审计 34 项通过。

## 兼容

- 值班路径的分享轮行为不变（无最小间隔闸，按原概率/上限跑）；
  `proactiveShare` 未配置时调度器按默认值（0.08 / 3 条 / 120 分钟）走，
  `enabled: false` 可整体关闭。
