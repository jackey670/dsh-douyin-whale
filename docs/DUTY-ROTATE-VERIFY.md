# 值班会话轮换真机验证清单（DSH NEXT）

> 状态：v1.14.4 交付轮换，真实宿主验证按本文执行；每次大改 `duty_agent/session_rotate` 后重跑一遍。
> v1.16.1 起补了 R8 提前收轮 / 忙轮跳过 / 侧栏显隐的观察项（§2 的 10–12），下次切机必须一起验。
> 前置：本机 DSH NEXT 已装 dsh-douyin-whale（见 `~/.dsh/profiles/desktop/cordis.patch.yml`）。
> 安全：**两机不能同时跑同一抖音账号**——开本机值班前必须先停笔记本生产。

## 0. 前置检查

- [ ] 笔记本生产已停：笔记本上 `node scheduler/scheduler.mjs --stop`（若 DSH 值班开着也要停）
- [ ] 本机独立调度器未运行：`node scheduler/scheduler.mjs --status` → 运行中=否
- [ ] wb2api 网关在跑（7863 端口可达），`WB2_API_KEY` 用户环境变量已设置

## 1. 打开值班（本机）

1. 编辑 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 douyin-whale 行：`whaleEnabled: true`
2. 给 GUI 进程补发送闸环境变量（重启后生效）：
   `setx DOUYIN_IM_ALLOW_SEND 1`
   （不想真实发私信就跳过这步——值班会照常读私信、跑任务，但发送走 dry-run）
3. 完全退出并重启 DSH NEXT
4. 插件日志确认：`<repo>/data/logs/douyin-YYYY-MM-DD.log` 出现
   `duty timer_started`（而不是 `disabled`）

## 2. 观察点（每项记录结果）

| # | 观察点 | 位置 | 预期 |
|---|---|---|---|
| 1 | 值班 tick 正常 | 插件日志 | 读私信/任务分发无报错 |
| 2 | `session-epochs.json` 生成 | `~/.dsh/memory/` | 首轮任务投递后出现，`epoch:1, sessionId:douyin-whale-duty-v2` |
| 3 | 面板占用率 | 设置 → 大肥鱼刷抖音 → 运行状态「值班大脑」 | `e1 · N%`，数值随对话/轮次上涨 |
| 4 | contextInfo 数据源 | 插件日志或 `/status.duty` | `source` 为 `usage`（拿到 assistant usage）而非 `chars` |
| 5 | 触发轮换 | 插件日志 | 占用 ≥ 阈值时出现 `轮换 douyin-whale-duty-v2 → douyin-whale-duty-e2` |
| 6 | 轮换前固化/反思 | 插件日志 | `轮换前固化：+N 事实` / `轮换前反思：N 条叙事线`（无素材时记 not-enough，正常） |
| 7 | 轮换后状态 | `session-epochs.json` | `epoch:2, sessionId:…-e2`，history 里有 v2 |
| 8 | 新会话收到简报 | DSH NEXT 会话页 | e2 会话首条消息是【交接简报】；旧 v2 会话仍在磁盘 |
| 9 | 轮换后首轮任务 | 插件日志 + 抖音回读 | 新会话投递任务、回复送达、回读确认正常 |
| 10 | 提前收轮（R8） | 插件日志 + `~/.dsh/memory/reply-marker.json` | dm_send 确认后几秒内出现 `确认发送提前收轮`；回合不再等满 15 分钟；marker 变 `sealed_until` 而不是被删 |
| 11 | 忙轮跳过（R8） | 插件日志 | 上一轮未结束时新 tick 记 `上一轮还在跑，本轮跳过（不排队）`，队列条数不变 |
| 12 | 侧栏显隐（v1.14.7+） | DSH NEXT 侧栏 | 默认看不到值班会话；面板勾「值班会话在侧栏可见」保存后，**下一次轮换**的新会话才出现 |
| 13 | 分享降级（R9，可选） | 插件日志 + 抖音 | 开了 `proactiveShare.linkFallback` 且分享面板没目标时，退化成一条带 `douyin.com/video/<id>` 链接的文字私信；没开则诚实放弃 |

**快速触发轮换**：等自然占用到 70% 太慢，把 `~/.dsh/douyin-whale.config.json` 里
`duty.rotate.contextRatio` 调小（如 `0.001`）即可——tick 每轮重读配置，**不用重启**；
验完改回 `0.7`。宿主不报窗口时占用率用 `duty.rotate.contextWindowFallback`（默认 1M）兜底。

## 3. 已知风险点（出现即修）

| 现象 | 嫌疑 | 修法 |
|---|---|---|
| 面板占用一直 0%、`window=0` | 首轮模型请求前宿主不报 contextWindow | 已加 `duty.rotate.contextWindowFallback`（默认 1M）；宿主上报后以宿主为准 |
| 轮换/回合 1 秒就收、回读必失败 | send 进正在 running 的会话只是排队，awaitIdle 误读上一轮空闲 | 已修（消息数基线 + sawRunning，v1.14.5） |
| dm-check `PermissionError` | 360 拦 venv python 写 %TEMP% | 启动器 TEMP/TMP 指到仓库 `data\tmp`；根治：360 白名单放行 `.venv\Scripts\python.exe` |
| 轮换失败 create 报已存在 | `e{N}` 被占 | rotate 会向后试两格；仍失败看日志里的 lastError |
| 简报没进新会话 | `agent.send(msg,'next-turn',false)` 签名不符 | rotate 已回退 followup；确认新会话首条消息 |
| 值班模型 401 | `WB2_API_KEY` 没进 GUI 进程 | setx 后必须完全重启 DSH NEXT |
| 回合 900s 超时但已回复 | GLM max-effort 在 dm_send 后还在生成收尾 | 已改进（v1.14.9：确认发送后提前收轮 + 封存 marker 防重发）；下次切机按 §2-10 复核 |
| 提前收轮后同一条回复发两遍 | 模型尾部还在生成、又发一次 | 已修：提前收轮把 marker 写成 `sealed_until`（默认 15 分钟），三个发送闸都看 `markerBlocksSend` |
| 分享轮从未发出 | 分享面板只列「最近分享过的人」 | v1.15.3 起可开 `proactiveShare.linkFallback` 降级发一条带视频链接的文字；没开仍诚实放弃（宁缺毋滥） |

## 4. 收尾回滚

1. desktop patch：`whaleEnabled: false`（`contextRatio` 改回 `0.7`）
2. `setx DOUYIN_IM_ALLOW_SEND` 按需删除（`setx DOUYIN_IM_ALLOW_SEND ""` 或注册表删除）
3. 重启 DSH NEXT，插件日志确认回到 `duty disabled`
4. 笔记本恢复生产

## 5. 验证记录

| 日期 | 结果 | 备注 |
|---|---|---|
| 2026-11-22 | 全部通过（1–9 见下） | v1.14.5，DSH NEXT 2.0.24-next / dsh 0.2.2-rc.5，wb2 = cn:deepseek-v4.1-flash（reasoningEffort max） |

**逐项结果（对应 §2 表格编号）：**

| # | 结果 | 证据（当日插件日志节选，UTC） |
|---|---|---|
| 1 | ✅ | `09:02:30 timer_started`；tick 正常读私信/分发 |
| 2 | ✅ | 07:53 首轮任务后生成 `{epoch:1, sessionId:'douyin-whale-duty-v2'}` |
| 3 | ✅ | `/status.duty`：`e2 · ratio 0.012`（占用随回合上涨） |
| 4 | ✅ | `used=7505/window=0 turns=9 source=usage` —— usage 读到了，但 **window 要到首轮模型请求后才由宿主上报** |
| 5 | ✅ | `09:08:20 轮换 douyin-whale-duty-v2 → douyin-whale-duty-e2（usage，用量 7505/?）`；触发用的是 `contextWindowFallback`（1M）× 临时阈值 0.001 |
| 6 | ⏭️ | 无可固化/反思素材（此前测试轮已消费），静默跳过继续轮换——设计行为；单测覆盖编排 |
| 7 | ✅ | `session-epochs.json` → `epoch:2, sessionId:…-e2`，history 有 v2 |
| 8 | ✅（机制） | 简报按 `send(msg,'next-turn',false)` 排队进 e2（面板自检 `值班会话已就绪`）；e2 侧栏会话存在，旧 v2 磁盘保留 |
| 9 | ✅ | 真实私信进队 → e2 接活（frames/diary 工具 → dm_send）→ `已确认送达（回复 31 字）`，无重发 |

**当天发现与修复（进 CHANGELOG）：**

1. **awaitIdle 排队竞态**（已修）：send 进正在 running 的会话只是排队，旧逻辑立刻读到上一轮的空闲 → 1 秒就收轮、回读必失败。改为「消息数基线 + sawRunning」判定。
2. **contextWindow 首轮前拿不到**（已修）：rc.5 的 `requestContext().contextWindow` 在首轮模型请求落盘前是 0 → 占用率恒 0。加 `duty.rotate.contextWindowFallback`（默认 1M），宿主上报后以宿主为准。
3. **360 拦 venv python 写 %TEMP%**（绕行）：dm-check `PermissionError` → 启动器把 TEMP/TMP 指到仓库 `data\tmp`；根治需在 360 白名单放行 `.venv\Scripts\python.exe`。
4. **GLM max-effort 收尾太长**（挂起）：dm_send 已发出后模型还在生成，回合以 900s 超时收尾；回读机制兜住了「已送达、不重发」。改进候选：发出后提前收轮。
5. **douyin_dm_share 分享面板限制**（挂起）：面板只列「最近分享过的人」，主人不在列表 → 分享轮诚实放弃（宁缺毋滥）。改进候选：分享目标保活/降级路径。
6. **双开风险**：验证期间发现独立调度器残留进程（07:34 启动）→ 已停。插件值班与独立调度器写同一份状态，**不能同时开**。
