# v1.4.0

> 发布版第一刀：**DSH 插件模式闭环**——面板、值班大脑、登录引导都进了插件，
> 发布版不再依赖 ZCode。本地独立调度器（ZCode 版）保留，两种模式二选一跑。

## 这版能干什么

- **设置页面板**：DSH 设置里多一页「大肥鱼」——运行状态、内容队列
  （旧→新，已回复/待回复徽标）、配置（主人昵称/检查间隔/每日上限/观看时段）、
  一键启停调度器、运行日志 tail、登录引导。整页包 error boundary。
- **值班大脑**：插件里养一条常驻 DSH agent 会话（`douyin-whale-duty-v1`），
  定时看主人私信 → 挑最早未回复的视频 → 抽帧看图 → 写两本日记 → 私信回复。
  模型和上下文由宿主管，**不再 shell 出 zcode.cjs**。
- **登录引导**：面板一键出二维码（无头截图，手机扫图片即可），状态实时轮询；
  出现滑块/短信验证时面板明示「只能人工完成」。
- **原生分享卡片**：`douyin.mjs share --aweme <id> --to <昵称>` 走抖音自己的
  「分享给朋友」，文本链接点不开、还会被吞的问题就此终结。发完回读确认。
- **本地发送闸**：两次真实发送最少隔 30 秒；失败冷却 2 分钟、风控冷却 10 分钟；
  冷却期内连浏览器都不开。面板可见。
- **每人一份本地记忆**：合并去重、80 条上限，回复只带最近 10 行 + 长期事实，
  不把整段历史塞进提示词。
- **内容队列持久化**：按 item_id 记队列，私信页把老卡片挤出 DOM 也不再漏视频。

## 修掉的 bug

| 现象 | 原因 |
|---|---|
| 发完一条私信就掉登录 | 每次从 storage_state 新建 context 被当成「新设备登录」⇒ 改持久化 profile |
| agent 跑完却没回私信，也被记成已回复 | 「跑完了」≠「发出了」⇒ 回读确认改成「我发的、内容匹配的消息 +1」 |
| 老视频被永久跳过 | 私信页只渲染十来条，新消息把老卡片挤出 DOM ⇒ 队列按 id 持久化 |
| 检查间隔配置不生效 | 调度器写死 60 秒 tick ⇒ 按 `watch.intervalMinutes` 自调度 |
| 一分钟连发多条触发风控 | 同上 |
| Windows 上面板/调度器抢浏览器 | fcntl 不存在，锁是空跑 ⇒ O_EXCL 锁文件 + PID + 过期清理 |
| `--watch-now` 必崩 | 调用了不存在的 `checkDmForVideos()` |
| 消息顺序忽对忽错 | `parsedContent` 无时间戳；改用几何位置判方向 + 过滤系统消息 |
| readConfig 丢自定义键 | 合并只走默认键 ⇒ 补「默认外键保留」 |

## ⚠️ 要知道的限制

- **图文**（`aweType=0` 带 itemId）：抽帧只支持视频，图文自动跳过并记日志。
- **自动恢复登录**：抖音在服务端作废会话时必须人工扫码；出现**滑块/短信验证
  只能人工完成**——插件不会也不会尝试绕过验证码。
- **网页端发群消息**（继承自上游）：服务端收下但群里其他人可能收不到（回执 7523）。
- **React fiber 是内部 API**：抖音前端大改版时消息解析可能失效，失效时会
  保守地不标记已回复（宁可重试也不漏）。

## 怎么装 / 升级

```bash
# 全新装（需先装 DSH 宿主 + Python 3.10+ / Node 22+ / Edge，ffmpeg 可选）
git clone https://github.com/jackey670/dsh-douyin-whale.git
cd dsh-douyin-whale
python -m venv .venv && .venv/Scripts/python -m pip install -r python/requirements.txt
# 登录（有头窗口，扫码；有滑块就在窗口里过）
.venv/Scripts/python tools/export_login_state.py
# 装进 DSH
dsh plugin --profile web add link:<这个目录>

# 已装过的
git -C <你的插件目录> pull
npm test        # 63 项离线断言，先验再跑
```

## 两种运行模式（二选一）

| | DSH 插件模式（发布版） | 独立调度器（本地保留） |
|---|---|---|
| 大脑 | 宿主值班会话 `agent.followup` | shell 出 `zcode.cjs -p` |
| 控制 | 设置页面板 | 命令行 / VBS |
| 依赖 | DSH 宿主 | ZCode CLI |
| 启动 | 装进 DSH 即常驻 | `cscript //nologo start-whale.vbs` |

⚠️ 两者写同一份 `~/.dsh` 状态文件，**不要同时跑**。

## 审计

```bash
node tools/release-audit.mjs 1.4.0   # 版本一致/白名单/凭证/语法/测试 全查
npm test                             # 63 项离线断言
```
