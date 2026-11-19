# dsh-superagent 学习笔记

这里放"读源码读出来的东西",面向只想知道**一条消息是怎么变成一次代码提交**的人。
不属于产品文档(`../docs/`),也不参与构建,删了不影响运行。

## 文件

| 文件 | 内容 |
|---|---|
| [001-feishu-message-journey.md](001-feishu-message-journey.md) | 从飞书收到第一条消息,到 PR 合并、通知发回飞书的**完整 13 步**,每步标注源码位置和当时生效的提示词 |
| [002-prompt-map.md](002-prompt-map.md) | 15 份提示词 × 两个角色的拼装顺序、注入点、可覆盖方式 |

## 30 秒版

```
飞书消息
  → feishu-loops 轮询/事件            sources/feishu-loops.ts
  → 转成 Trigger                      sources/feishu-trigger.ts
  → 闸门判定强度(explicit/inferred)   policy.ts          ← 不通过就到此为止,不花模型钱
  → Intake 去重/扇出/排队             core/intake.ts
  → Evals 同线程合并成一批            core/evals.ts
  → passes 每 2 秒起到期 Eval         app/passes.ts
  → 候选卡进主 Session                app/assessment.ts  ← 从这里开始用提示词
  → 主控评估/路由                     prompts/admission.md + dispatch.md
  → accept:建工单+授权+分配(原子)     core/engine.ts
  → 起 worker Session                 executor/dsh.ts   ← 换一套 worker 提示词
  → 干活、绑 PR、报告                 prompts/work.md + team/*
  → 交付:Outbox → 飞书 Channel        app/outbox.ts
```

## 最值得先读的三个文件

1. `../src/core/engine.ts` —— 所有状态的唯一写入者,方法名就是领域动作(`decide`、`attach`、`report`)
2. `../src/app/prompts.ts` —— 提示词怎么拼(`promptParts`),两个角色的顺序差异一目了然
3. `../src/app/sessions.ts` —— 提示词、技能、工具怎么挂到具体 Session 上(`decorate` 方法)

## 配套阅读

- [001 领域模型](../docs/001-domain.md):Trigger / Thread / Eval / Ticket / Assignment 的定义
- [002 授权](../docs/002-authorization.md):闸门与准入表
- [003 执行](../docs/003-execution.md):工单阶段表
- [004 提示词](../docs/004-prompts.md):提示词版本与覆盖机制
- [007 架构](../docs/007-architecture.md):模块索引(本文的源码路径都能在那里查到职责)
