# 上游与外部依赖调研笔记（2026-10-28）

> 结论先行：**三个上游都没有功能更新，无可借鉴的新东西**；协议逆向路线继续排除；
> 值得跟进的是 DSH 宿主本身（v0.2.2 的第三方插件热更新机制）。

## 血统链

| 仓库 | 角色 | 状态 |
|---|---|---|
| SakuraMat0u/dsh-douyin-toolkit | 根仓库（本仓库 LICENSE 保留其版权） | 2026-10-20 初始提交后无更新 |
| JianHeShui/dsh-douyin | 直接上游（本地首个 commit 与其初始 commit 相同） | fork 点之后仅 2 个非功能提交 |
| **jackey670/dsh-douyin-whale**（本仓库） | 大幅领先：面板 / 值班大脑 / 发送闸 / 调度器 / 表情包 | v1.5.0 |
| Youhai020616/douyin (dy-cli) | 协议客户端基座（本地克隆 `projects/dy-cli-src`） | 冻结在 2026-09-12，0.2.2 仍是最新 |

## 明确不可借鉴（红线）

| 东西 | 原因 |
|---|---|
| dy-cli `signature.py` 的签名执行、伪造 device_id/UA | a_bogus 签名逆向 + 指纹伪造；本仓库只用它的**纯参数模板**（`python/dy_query.py` 的 `get_base_params`），签名执行路径零引用，维持现状 |
| cv-cat/catbus、DouYin_Spider | 指纹伪装 + 验证码自动识别 |
| leslie10150/douyin（Xposed 群发私信） | 批量群发 |
| MediaCrawler 的代理池 / 多账号 / 批量采集 | 限流规避；其**只读解析**部分可继续当对照 |
| douyin-web-api-sdk（Java，60★，无 LICENSE） | 私信协议直连；只作「图片消息结构」知识参考，不可复制代码（无许可证），且协议路线与本项目 DOM 路线冲突 |

## 抖音私信 DOM 实测记录（本项目自己踩出来的，比上游有用）

- 消息 aweType：700/703 文字、800 视频卡片、0+itemId 图文、
  **501 收藏表情（personal_upload webp）**、**2702 聊天发送的图片**。
  501/2702 都没有 text/itemId，图片字段在 `parsedContent.url{uri,url_list,width,height}`。
- 发图链路：工具栏 `input.semi-upload-hidden-input`（accept jpg/jpeg/png/gif/mp4，multiple）
  → 弹「发送给 ××」模态框（`MsgInputSendFileModal*`，caption 是 `semi-input-textarea`，
  按钮「取消」/「发送 (N)」= `MsgInputSendFileModalbtnSure`）。
- **必须等预览图从本地 blob 换成 douyinpic CDN 地址后再点发送**，否则消息永远卡「发送中」、
  对方收不到（2026-10-29 实测）。
- caption 不随图走：发送后是「图（2702）+ 文字（独立消息）」两条。

## DSH 宿主（deepseek-ai/deepseek-harness）

- 2026-10 密集发版：v0.2.1-rc.x → **v0.2.2-alpha.2（10-28）**。
- 对本插件相关的新能力：**第三方插件包更新 + 热更新失败自动回滚**——发布时版本号必须
  单调递增、`files` 必须完整（发版审计已在管）；无 agents API 破坏性变更，代码不用改。
- 本地主力宿主还在 0.1.5-rc.1；升级前先备份 `~/.dsh`（另见 BACKLOG）。
