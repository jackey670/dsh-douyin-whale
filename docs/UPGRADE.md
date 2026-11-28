# 升级 / 回滚运维手册（生产机）

> 适用：常驻跑生产的机器（当前是闲置笔记本）。开发机只开发，不跑生产。
> **铁律：两台机器不能同时跑同一个抖音账号。** 升级/切机前先确认另一边已经停。

## 0. 一句话流程

```bash
# 升级前：停值班 → 导出记忆 → 换版本 → 重启 → 自检
node scheduler/scheduler.mjs --stop          # 独立调度器
pwsh -File scripts/dev-duty.ps1 -Off        # 本机值班（笔记本没有这个脚本就手动改 patch）
npm run memory:export -- --push             # 记忆推到私有仓（第一次要先配好仓库）
git fetch --tags && git checkout v1.21.0    # 换到目标版本
# 完全退出并重启 DSH NEXT，然后按 §4 自检
```

## 1. 升级前（5 分钟）

1. **停掉所有会自动发消息的东西**：面板「停调度器」或 `node scheduler/scheduler.mjs --stop`；
   DSH 值班用 `scripts/dev-duty.ps1 -Off`，或者把 `~/.dsh/profiles/desktop/cordis.patch.yml`
   里 douyin-whale 那行的 `whaleEnabled` 改成 `false`，然后完全退出 DSH NEXT。
2. **记录当前版本**：面板右上角 `vX.Y.Z·bN`，或 `git describe --tags`。
3. **导出记忆**（登录态和记忆都在 `~/.dsh`，升级一般不动它，但先留一份）：

   ```bash
   node tools/memory-export.mjs --export     # 导出到目录，先看清单
   node tools/memory-export.mjs --push       # 推到私有仓 dsh-douyin-whale-memory
   node tools/memory-export.mjs --verify     # 校验远端与本地一致
   ```

   记忆里有私人对话/日记，**只能进私有仓**，别推到公开仓库。

## 2. 升级方式 A：checkout（笔记本现状，推荐）

```bash
cd <repo>
git fetch --tags
git checkout v1.21.0          # 目标版本 tag
git status                    # 确认没有本地改动被带过去
```

- 依赖没变就不用动 `.venv`；`package.json` 没有运行时 npm 依赖，不用 `npm install`。
- 完全退出并重启 DSH NEXT（不是只关窗口——托盘/后台进程也要退）。
- 面板打开，右上角显示 `v1.21.0·b31` 即换版成功。

## 3. 升级方式 B：打包 tarball（不想 clone / 市场装法）

Release 页有 `dsh-douyin-whale-<版本>.tgz` 和 `.sha256`：

```bash
curl -LO https://github.com/jackey670/dsh-douyin-whale/releases/download/v1.21.0/dsh-douyin-whale-1.21.0.tgz
sha256sum -c dsh-douyin-whale-1.21.0.tgz.sha256     # Windows: certutil -hashfile <文件> SHA256
dsh plugin --profile desktop add file:$PWD/dsh-douyin-whale-1.21.0.tgz
```

打包安装的三处不同：

- `dataDir` 是 `~/.dsh/douyin-whale`（不是仓库里的 `data/`），登录态/队列/日志/记忆都在那；
- 包里不带 `.venv`，`pythonPath`（插件配置）或 `DOUYIN_PYTHON` 要指向一个有
  `python/requirements.txt` 依赖的解释器；
- 升级就是再 `add` 一次新 tarball；`~/.dsh/douyin-whale` 不动。

## 4. 升级后自检清单

- [ ] 面板版本号 = 目标版本，`bN` 是这次发布注明的 build
- [ ] 「运行状态」显示调度器在跑/未跑符合预期
- [ ] 「记忆体检」六项里没有意外新增的「索引失配」（有就点「重建索引」）
- [ ] 搜一条最近的回忆，能命中且「看原话」能展开
- [ ] 值班：等一轮轮换（或面板「测试值班会话」），日志出现新会话 id，没有重复发送
- [ ] 发送闸：不想真发就确认 `DOUYIN_IM_ALLOW_SEND` 没设；要真发就设了并且**重启过** DSH
- [ ] `data/logs/douyin-<日期>.log` 里没有连续报错/风控提示

出问题先看日志，再按 §5 回滚；不要在生产机上现场改代码。

## 5. 回滚

```bash
cd <repo>
git checkout v1.16.0          # 上一个稳定 tag
git status
# 完全退出并重启 DSH NEXT
```

- **记忆格式向后兼容**：目前各版本对 `memory/*` 只增字段、不改语义，回滚不需要动记忆。
  以后如果真有 breaking 改动，会在 CHANGELOG 顶部单独标注。
- 打包装法回滚：`dsh plugin --profile desktop add file:<旧版本.tgz>`。
- 回滚后仍要按 §4 自检，尤其是值班轮换和发送闸。

## 6. 记忆恢复（升级把数据弄丢时）

`memory-export --export` 的目录里是这些文件（相对 `~/.dsh`）：

```
memory/profile.json      memory/episodes.jsonl   memory/arcs.json
memory/index.json        memory/meta.json        memory/dm-*.json
whale-diary.md           whale-diary-private.md  whale-mood.json
```

恢复步骤：

1. 先停调度器/值班，把现有 `~/.dsh/memory` 整个备份一份；
2. 把导出目录里的文件按上面的相对路径拷回 `~/.dsh`；
3. 面板「记忆体检」→「重建索引」（`index.json` 也可以不拷，重建即可）；
4. 搜几条确认，再开调度器。

## 7. 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| 面板一直「加载中…」，按钮全灰 | DSH 后端没起来或路由没挂：完全重启 DSH NEXT；看 `data/logs` |
| 值班不干活、日志没有新会话 | `whaleEnabled` 没生效：改的是另一个 profile，或没完全退出重启 |
| 私信 dry-run 不真发 | `DOUYIN_IM_ALLOW_SEND` 是进程环境变量，`setx` 之后要重启 DSH |
| 测试/跑脚本报 TEMP 权限 | 360 拦了 venv 写 `%TEMP%`：用 `~/.dsh/start-dsh-next.cmd` 启动（它把 TEMP 指到仓库 `data\tmp`） |
| 掉登录 | 正常现象，重新扫码；别删 `im-profile`，删了会被当成新设备 |
| 两台机器都收到私信 | 两边都在跑同一账号——立刻停一边，这是硬性限制 |
