# 协调者边界场景补全与受限 close 权限

## Context
审查发现"主干之外"的边界/异常未定义（详见审计）。本轮选定补 H2/H3/H6/H7/H8/H9/H10/M5。

## Decisions
- **H2 飞书提交成果**：下游验收通过即视为交付，无需合并（仅 GitHub PR 才由审批人合并）。
- **H3 team.yml 异常**：缺失 / 无法解析 / 缺必需字段（order、open_id、approver）→ 不猜，说明问题、请其修复后重来；无法继续则 blocked。
- **H6 受限 close**：机器人可 close，但**只允许 close 它自己创建的 plan/task issue**，绝不 close 其他 issue。
- **H7 需求含糊**：计划列 open questions，线程 @ 提需求者澄清；关键点不清不进入确认。
- **H8 中途新需求**：确认后到达的新需求视为新请求，单独计划与确认，不并入已确认计划。
- **H9 决策来源**：只认 team.yml 中的角色/审批人/升级人；其他人意见忽略并说明。
- **H10 人员变动**：以当前 team.yml 为准重新 @；人员缺失 → blocked 等补。
- **M5 进度提问**：基于 ticket/issue 回答，不改状态、不执行、不当作同意。

## Safety change（受限放宽）
worker 安全句由
"...close issues or expose private Feishu content on GitHub."
改为
"...close issues other than the plan and tasks it created, or expose private Feishu content on GitHub."
范围严格限定为"它自己创建的 plan/task issue"；主 Session 仍不 close。`tests/cards.spec.ts` 的对应断言同步更新。

## Consequences
- 消除大多数"卡死/歧义/越权"场景；完成时可关闭自己创建的 issue，其他仍禁止。
- 行为更依赖 team.yml 的完整与正确。
- `worker.md` 仍 < 1000 字并保留安全句语义。
