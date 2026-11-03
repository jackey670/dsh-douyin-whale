# v1.8.0 — 值班大脑看懂视频画面

> `douyin_frames` 工具：抽帧图批量进模型对话。值班模式不再「按文案瞎猜画面」。

## 新增

- **`douyin_frames`**（15→16 工具）：下载视频 + ffmpeg 抽 4-6 帧，帧图经宿主
  attachments 服务作为 image 块批量带进对话；返回附带文案/作者供交叉核对。
- 共用助手 `attachLocalImage`：路径白名单（dataDir / 图库根）+ 魔数嗅探
  （扩展名不可信，抖音 CDN 下载件常名不符实）+ 空文件拒绝。sticker_look 与
  frames 同源。
- 值班视频任务消息改为「先抽帧看画面 → 就画面回」；抽帧失败回 FRAMES_FAILED，
  不发私信。

## 文档

- README 模型路由改为通用指引：装在 DSH 里用宿主已配置的模型；自定义则在宿主
  设置里声明自己的 OpenAI 兼容网关（provider 名/地址/key 均自选）。
  公开文档不再含任何本机网关痕迹。
- `input: [text, image]` 模态声明的要求保留并强调——缺了图会被请求投影层
  静默丢掉。

## 验证

- 工具级真机：真实视频 → 4 帧 JPEG 入库 → render 出 4 image + 1 text。
- `npm test` 全绿：Python 29 + JS 70 项。
- 发版审计通过。
