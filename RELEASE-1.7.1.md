# v1.7.1 — 接入 humanizer 去 AI 腔

> 把 humanizer 技能（维基百科「Signs of AI writing」规则集）织进大肥鱼的说话系统。

## 变更

- **AI 腔雷区**（对中文短句私信最致命的结构模式）：
  「不是 X，而是 Y」句式、破折号连句、金句收尾、三连排比、
  「说实话/讲真/其实吧」开场、句句等长。
- 三处说话面同步：
  - `lib/persona.js` `styleHint()`——每轮从雷区池**随机带一条**（轮换点名，
    固定大段会被模型当耳旁风）；调度器与值班大脑共用。
  - `lib/duty_agent.js` 系统提示——【AI 腔雷区】常驻小节（全量禁止）。
  - `scheduler/agent/AGENTS.md`——同款常驻小节（ZCode 调度器路径）。

## 验证

- `npm test` 全绿：Python 29 + JS 70 项。
- 发版审计通过。
