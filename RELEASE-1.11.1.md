# v1.11.1 — 值班会话 v2

> 真机回归抓到的最后一个问题：新能力（frames/emoji/日记）配旧会话历史跑不动，换新会话首轮即闭环。

## 变更

- 值班会话 id `douyin-whale-duty-v1` → `douyin-whale-duty-v2`。
- 真机对比（0.2.2-rc.1 宿主，同一条 sticker 任务）：
  - v1 恢复会话：16 秒、零工具调用、text 收尾 → no-send；
  - v2 新会话：sticker_look → meme_pick → dm_send（31 秒真实发送）→ 回读确认（23 字）。
- v1 会话文件留在宿主 sessions 目录不删；回滚 = 改回 sessionId 默认值。

## 兼容

- 无 API/配置变化；仅会话标识升级。
