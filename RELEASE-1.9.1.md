# v1.9.1 — 读私信空输出兜底 + 分享回读配对

> 两个小修：`read` 偶发「exit 0 但 stdout 空」不再丢一轮；分享卡片按 aweme 回读，不再被假正文骗。

## 修复

- **`read` 偶发空输出（~1/8）**
  - 复现：8 连跑 1 次 `status=0`、stdout/stderr 全空、耗时 31s（正常 16s）。
  - 证据：带 `DOUYIN_IM_TRACE` 时 Python 明确执行了 `emit` 和 `exit0`，
    说明 JSON 丢在 Node/Windows 管道侧，不是脚本没跑。
  - 修法：
    1. `emit` 同时把同一份 JSON **原子写**到 `DOUYIN_IM_OUT_FILE`；
    2. 调度器 `checkDm`、值班 `checkDm`、`douyin.mjs read-dm` 三处
       stdout 空就读回退文件；
    3. 两边都空就地重试一次（读操作幂等）。
    另加 `PYTHONUNBUFFERED=1` 排除缓冲因素。
- **分享卡片回读配对**
  - 卡片没有正文；以前 `douyin.mjs share` 往标记里写假正文
    「视频分享 &lt;id&gt;」，tick 按正文核对永远对不上，可能重复分享。
  - 现在标记只记 `video: aweme`；调度器与值班 tick 都按「我发的卡片
    item_id」确认（`meCardIds`），成功日志写「分享卡片 &lt;id&gt;，回读确认」。

## 验证

- `read` / `read-dm` / `--dry-tick` 真机全通；回退文件内容与 stdout 一致。
- `npm test`：Python 32 + JS 72 全绿（新增值班 tick 分享卡片回读用例）。
- 发版审计 34 项通过。

## 兼容

- 不改变任何发送语义与安全闸；只是把「读丢了」的情况补回来。
