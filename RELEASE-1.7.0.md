# v1.7.0 — 值班大脑会刷视频了

> 队列空闲时低频挑一条主人可能感兴趣的视频，以原生卡片分享；附带值班看图
> （`douyin_sticker_look`）——值班模型第一次能看到主人发的表情。

## 新增

- **主动分享**：`proactiveShare`（enabled / probability 0.08/轮 / maxPerDay 3）——
  队列空闲按概率投「刷热榜/搜索 → 挑视频 → 分享」任务；原生卡片送达由 python
  侧回读（aweType 800 + 同 item_id）确认，tick 再按卡片 item_id 复核后才计数。
  手动 tick 不触发；每日上限独立于表情。
- **`douyin_dm_share`**（14→15 工具）：分享卡片工具，接入「一轮一条」标记。
- **`douyin_sticker_look`**：本地图 → 宿主 attachments 服务 → 工具结果 image 块
  → 模型可见。路径白名单 + 魔数嗅探（CDN 下载件扩展名常名不符实）。

## 配置要点

- pi-ai 自定义路由的模型条目必须声明 `input: [text, image]`——缺省=纯文本，
  工具结果里的图会被投影层静默丢弃（`~/.dsh/settings.yaml`；0.2.2 启动会导入
  该文件并改名 `.imported`）。
- 分享目标必须在抖音「最近分享过的人」面板里（首次需手动分享一次）。

## 真机验证（0.2.2 值班大脑 + wb2api）

- 看图：sticker_look 入库 74ms，模型引用图片内容。
- 主动分享：hot 1.8s + search 2.2s → 卡片 33s 送达 → 回读确认 → 计数。

## 验证

- `npm test` 全绿：Python 29 + JS 70 项。
- 发版审计通过。
