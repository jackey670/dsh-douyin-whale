# v1.5.0

> 表情包收发 + 白框结案。大肥鱼现在能发自己的表情包、能看见主人发的表情包并回敬一张。

## 表情包怎么工作的

**发**（每轮约 30% 概率，每日上限 6 张，面板可调）：

1. 模型觉得该配图时先 `node douyin.mjs meme pick "<情绪>"` —— 从 dsh-meme 的图库
   （`~/.dsh/meme-packs`，大肥鱼包 24 张）按情绪桶/关键词挑一张，拿到绝对路径；
2. `send --text "<一句话>" --image <path> --send` —— Playwright 把文件塞进聊天页的
   隐藏上传 input，等「发送给」弹窗、把 caption 打进弹窗输入框、**等预览图换成 CDN
   地址（上传真正完成）**再点「发送 (N)」；
3. 回读确认：我发的媒体消息 +1 且没有「发送中」标记，caption 文本也要出现。

**收**：主人发来的收藏表情（aweType 501）和聊天图片（2702）解析为 `kind=sticker`
（带 CDN 直链和 image_id），按 image_id 入队；处理前自动把图下载到本地给模型看，
模型用 `meme pick` 挑一张情绪对得上的回敬。

**安全边界**：`--image` 路径白名单锁死 `~/.dsh/meme-packs`（+`DOUYIN_MEME_ROOTS`），
目录不存在时 fail-closed 一律拒发；扩展名/大小钳制；发送走同一套双闸
（`--send` + `DOUYIN_IM_ALLOW_SEND=1`）和风控冷却；一轮只发一条的标记把带图回复
记为 `image:true` 供每日计数。

## 白框结案

- 之前的「隔离 ZCode home」修复是**假的**：`ZCODE_HOME` 根本不是 ZCode CLI 读取的变量。
- 用 `tools/whitebox-probe.mjs`（`npm run probe:whitebox`）在 **ZCode 桌面窗口关闭**
  的状态下、以与调度器完全相同的参数实测唤醒：**无任何新窗口**（CLEAN）。
- 结论：白框来自旧版 `--surface desktop`（唤醒把桌面会话顶到前台）与凭据过期时的
  登录弹窗，分别被 `--surface terminal`（1.4.1 后）和本次的 `--no-browser` 修掉。
- 探针脚本保留：以后怀疑又冒窗，关掉桌面窗口跑一次就有取证日志
  （`~/.dsh/whitebox-probe.log`）；调度器每次唤醒前后也会快照可见窗口写进日志。

## 真账号验证（2026-10-29 凌晨）

- 表情包实发 3 张：第一张因「点发送早于上传完成」卡在发送中（由此发现并修复该 bug），
  修复后主人确认「这次看到图片了」；
- 队列连跑 8 轮 `--watch-now`：6 条文字 + 2 张主人发的表情包全部处理完，
  其中表情包回复带 caption（如「看你这小眼神，我当你认输了哦」）；
- 期间暴露并修复两个真 bug：多行 JSON 解析失败导致表情图下载失败；
  「无标记时任意新消息算送达」的回读假阳性。
- emoji 文字 dry-run 验证：😎🐳🦈 原样进入 Draft.js 编辑框。

## 上游结论

三个上游（SakuraMat0u / JianHeShui / dy-cli）全部无功能更新；协议逆向路线继续排除。
详见 `docs/UPSTREAM-NOTES.md`（含本次实测的 aweType 表和发图 DOM 链路记录，
比上游仓库有用）。

## 测试

`npm test` 全绿：Python 29 项 + JS 67 项（memory 8 / state 10 / send-gate 4 / meme 4 /
panel 9 / panel_api 15 / duty_agent 8 / whale_tick 9）。
