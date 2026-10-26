#!/usr/bin/env node
/**
 * tools/make-release.mjs —— 打发布版：版本号 + CHANGELOG 1.4.0 条目。
 * 一次性脚本，跑完即删也行。
 */
import fs from 'node:fs';

const pj = 'package.json';
const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
j.version = '1.4.0';
fs.writeFileSync(pj, JSON.stringify(j, null, 2) + '\n');

let c = fs.readFileSync('CHANGELOG.md', 'utf8');
const entry = `# Changelog

## 1.4.0 — 2026-10-27

发布版第一刀：**DSH 插件模式闭环**（面板 + 值班大脑 + 登录引导），本地独立调度器（ZCode 版）保留。

### 新增

- **设置页面板**（\`client.js\`，宿主注入的 React，无构建步骤）：运行状态、内容队列
  （旧→新，带已回复/待回复标记）、配置（主人昵称/间隔/上限/时段）、启停调度器、
  登录引导、日志 tail。整页包 error boundary，任何一块抛错只塌这一页。
- **值班大脑**（\`lib/duty_agent.js\` + \`lib/whale_tick.js\`）：DSH 宿主的常驻
  agent 会话替代 zcode.cjs 外挂——get(live) → resume → create 三步链、
  per-agent 人设、subagent 化不进侧栏；tick 保留回读确认才标记已回复、
  队列持久化、观看时段、图文跳过。宿主没有 agents 能力时整块降级为日志。
- **登录引导**：面板一键出二维码（无头截图给人扫），状态文件轮询；
  出现滑块/短信验证时面板明示「只能人工完成」。
- **原生分享卡片**（\`douyin.mjs share\`）：走抖音自己的「分享给朋友」，
  鼠标轨迹 hover 展开面板，发完回读确认。
- **本地发送闸**：两次真实发送最少隔 30 秒；失败冷却 2 分钟、风控冷却 10 分钟；
  冷却期内连浏览器都不开。面板可见，\`gate --clear\` 可手动解除。
- **每人一份本地记忆**（\`scheduler/memory.mjs\`）：合并去重、80 条上限，
  回复时只带最近 10 行 + 长期事实。
- **内容队列持久化**：私信页只渲染十来条，老卡片会被挤出 DOM；按 item_id
  记队列，处理不再依赖卡片还在页面上。
- **面板离线验证**：\`npm run preview\` 伪造宿主三件套本地跑面板，
  \`tools/panel-preview/\` 全套。

### 修复

| 现象 | 原因 |
|---|---|
| 发完一条私信就掉登录 | 每次从 storage_state 新建 context 被当成「新设备登录」；改持久化 profile |
| agent 跑完却没回私信，也被记成已回复 | 回读确认改成「我发的、内容匹配的消息 +1」，零宽字符删除而非替换 |
| 老视频被永久跳过 | 私信页只渲染十来条，新消息把老卡片挤出 DOM；队列按 id 持久化 |
| 检查间隔配置不生效 | 调度器写死 60 秒 tick；改成按 \`watch.intervalMinutes\` 自调度 |
| Windows 上锁不生效 | fcntl 不存在；改 O_EXCL 锁文件 + PID + 过期清理 |
| 一分钟连发多条 | \`intervalMinutes\` 只用于显示；改为真正按配置间隔 |
| \`--watch-now\` 必崩 | 调用了不存在的 \`checkDmForVideos()\` |
| 面板/调度器抢浏览器 | Windows 无 fcntl，锁是空跑；补 O_EXCL 跨平台锁 |
| readConfig 丢自定义键 | 合并只走默认键；补「默认外键保留」 |

### 已知限制

- **图文**（aweType=0 带 itemId）：抽帧只支持视频，图文自动跳过并记日志。
- **自动恢复登录**：抖音在服务端作废会话时必须人工扫码；出现滑块/短信验证
  只能人工完成——插件不会也不会尝试绕过验证码。
- **网页端发群消息**（继承自上游）：服务端收下但群里其他人可能收不到（回执 7523）。

### 升级

\`\`\`bash
git -C <你的插件目录> pull
# 依赖没变过就不用重装；新增 JS 测试在 lib/*.test.mjs，npm test 一键跑
\`\`\`

## 2026-10-25 的四个待修 bug，已在 1.4.0 全部解决
`;
if (!c.startsWith('# Changelog\n\n## 待修')) {
  // 已改过就只换版本号
  console.log('CHANGELOG 头部不是待修段，仅更新 package.json');
  process.exit(0);
}
c = entry + c.slice('# Changelog\n\n## 待修（2026-10-25）\n\n'.length);
fs.writeFileSync('CHANGELOG.md', c);
console.log('version=1.4.0, CHANGELOG updated');
