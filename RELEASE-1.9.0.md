# v1.9.0 — 原生表情面板直发

> 抖音自带表情（21 个）也能发了：看面板 → 按中文名选 → 点一下直接送达，回读确认。

## 新增

- **`emoji-list` / `emoji-send`**：打开聊天输入框的表情面板，列出账号自带的
  原生表情（中文标签 + 编号 + 带编号的面板截图，按行高截 3 张保证每行完整）。
  `emoji-send` 默认 dry-run 只截选中表情的预览——因为**点格子就是直接发送**，
  dry-run 绝不点；真发要 `--send` + `DOUYIN_IM_ALLOW_SEND=1`。
- **`douyin.mjs emoji list|send`**：调度器/命令行入口，和文字/贴图共用
  「一轮只发一条」标记（标记新增 `emoji` 字段）。
- **工具 `douyin_emoji_list` / `douyin_emoji_send`**（16→18）：面板截图经宿主
  attachments 服务作为 image 块进对话，值班模型看得到图标；发送后按回读
  确认才返回 `sent`。
- **纯表情回复回读**：表情没有正文，调度器和值班 tick 新增 `meMediaCount()`，
  标记 `emoji: true` 时按「我发的媒体条数 +1」确认；日志写
  「原生表情，媒体 N→M 条」。
- 提示词：值班系统提示和调度器 `AGENTS.md` 都写明「表情顶替文字，一轮只发
  一条」。

## 实测

- 面板结构：`.componentsemojiemojiPanel` > `.componentsemojitabPanel` >
  `.emojiEmojiItememojiItem`；21 个表情、5 列、可滚动。
- 点格子=直发（没有插入输入框这一步）；底部 tab 栏会盖住第三行，按坐标点会
  点到 tab——改用 `locator.click()` 自动滚动后正常。
- 发出去的表情：`aweType 507`、`kind: sticker`，`image_uri` 带
  `-ts-<hex 中文名>`；真机发出「晚上好」「比心」并回读确认。
- 全量 `npm test` 全绿。

## 兼容

- 不改变文字/贴图/分享的既有路径；原生表情只是新增的第三种回复方式。
- 安全闸不变：默认 dry-run、双闸真发、30 秒发送间隔、风控冷却、
  调度器一轮一条。
