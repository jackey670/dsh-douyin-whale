# v1.5.1

> 面板表情包配置 + GitHub 发布补齐 + DSH 0.2.2 验证记录。

## 这版做了什么

- **面板**：设置卡新增「表情包概率（%）」「表情每日上限」两项（对应
  `meme.probability` / `meme.maxPerDay`，后端钳制 1.5.0 已有，这次补 UI）；
  状态卡「今天」附带当天表情数。PANEL_BUILD 7。
- **测试**：`panel_api.test` 补 meme 节钳制断言（概率钳到 [0,1]、上限钳到 [0,30]、
  未知字段整包 400）。

## 运维记录（同日）

- **GitHub 发布补齐**：main 同步至 `503d615`；补 tag `v1.4.2`、`v1.5.0` 和对应
  GitHub Release（gh CLI，直连抖动时走 clash 7897 代理）。
- **DSH 宿主**：0.2.2-alpha.2 从 npx 缓存直启验证——插件 **API 路由全通**
  （status/duty-selftest/config 均正常），但第三方插件 client 面板 404
  （`dsh-client-runtime` 被 0.2.2 移除；换 `dsh-client-modules` 等新 inject 清单仍 404，
  疑似要走插件管理器安装路径，本机 symlink 权限挡住 `dsh plugin add`）。
  **决定：主力宿主暂留 0.1.5-rc.1**（面板完整可用），0.2.2 用
  `~/.dsh/start-dsh.cmd 022` 备用直启；备份在 `~/.dsh/backup-20261030/`（388KB）。
- 调度器已恢复常驻（重启机器后第一件事）。

## 验证

- `npm test` 全绿：Python 29 项 + JS 68 项。
- 发版审计 34 项通过。
