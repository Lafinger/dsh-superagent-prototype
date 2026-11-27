# 终态必须回帖 & 停止语义统一

## Context
计划阶段异常流程实测（A 改稿×2 → B 升级审批人 → C 审批人回「C」终止）发现：工单能正确 `ended`（outcome=stopped），但**审批人裁决后机器人没有说话**——线程里只剩用户自己发的「C」。原因：`SKILL.md` 只写了"mark blocked and stop"，没有要求把结论回报到线程；且"stop → blocked"与实际落成的 `stopped` 语义不一致。

## Decision
1. **终态必回帖**：任何导致工单结束的动作（完成/Stopped/Dropped/Blocked），都必须先在飞书线程发一条短消息，说明**裁决与结果状态**；禁止静默结束，禁止让线程停在你最后一次提问。
2. **停止语义统一为可执行的 `dropped`**：
   - 审批人/升级人明确「停止/终止」→ 协调者 `report dropped`（可执行），并在线程回帖；
   - 只有在"无人裁决/等待补料"时才 `blocked`；
   - 完成 → `ready`（并 close 自己创建的 plan/task issue）。
3. `worker.md` 增加压缩提示"escalate ... else end dropped or blocked; say the outcome in Feishu"，仍 < 1000 字并保留安全句。

## Consequences
- 用户侧每次结束都能看到明确结论，不再出现"发完裁决就静默"。
- `blocked`（等人/缺料）与 `dropped`（明确终止）语义清晰、可区分。
- 需保证回帖先于结束；回帖失败时不得静默结束（至少记录）。

## Verification
- 166 单元测试通过；`worker.md`=998 字。
- 待下一轮部署后，用同类"审批人终止"场景复测：线程应出现终止结论，ticket 落 `dropped/ended`。
