# 人工终止由引擎事件回帖（修正 0009 的 worker 假设）

## Context
按 0009 让 worker "终止必回帖"后实测（极简便签，前端两次异议 → 审批人 Lafinger 回「C」）仍**无回帖**。定位：审批人「C」是由**主会话的评估器**判定为 `kind:'stop'`，在 `core/evals.ts:300` 直接 `tickets.end(ticketId,'human','stopped',...)`，**在 worker 回合之前**就结束工单（worker turn9 空响应）。worker 的 SKILL/提示词规则没有机会执行。结论：人工 stop 的"回帖"不能靠 worker，必须在**引擎的 `ticket.ended` 事件**上发出站通知。

## Decision
新增 `src/sources/stop-notices.ts` 的 `stopEndNotices(ticket, request)`：当 `ended.outcome === 'stopped'` 时，向该工单**非 GitHub 的 IM 渠道**（飞书线程）构造一条幂等 `OutboundMessage`（中文/英文随需求语言），文本含"本计划已按人工指示终止，工单已停止。"与 `ended.reason`。在 `app/runtime.ts` 的 `ticket.ended` 监听里，与 `pullEndNotices` 并列 `outbox.send`。GitHub 渠道跳过（时间线已有）。

## Consequences
- 审批人「终止/停止」、以及面板"停止"按钮（同为 `end('human','stopped')`）都会在飞书线程补一条终止通知，不再静默。
- 与 worker 的完成/丢弃回帖（0009 保留）不冲突：worker 的 `dropped/completed` 不触发 `stopped` 分支，避免重复。
- 停单与回帖解耦在引擎事件层，更可靠。

## Verification
- `tests/stop-notices.spec.ts`（新增）：非 stopped 静默、Feishu 渠道发中文通知跳过 GitHub、英文需求发英文。
- 关键套件 372+ 通过（仅 1 个 Windows 路径转义平台性失败）。
- 端到端：部署后对一张 Feishu 工单执行停止，验证线程出现"已按人工指示终止"通知。
