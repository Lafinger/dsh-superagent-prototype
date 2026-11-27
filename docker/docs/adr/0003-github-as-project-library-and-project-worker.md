# 以 GitHub 仓库为项目资料库：用项目推进 worker 取代代码修复 worker

项目里已有的「项目资料库 + 根据资料库推进项目」能力，原先是另一套工作台/协作服务（`dsh-project-workbench`、`dsh-collaboration-acp-server`）里的工具与成员 Agent。评估后**放弃把那套 Agent 抽离**（它与 ACP/钉钉身份/自然语言授权/成员会话强耦合，业务工具又与 `dsh-project-workbench` 同域重复，还锁在 DSH 0.2.0-rc.2 / Node≥24）。

现在决定：**不再区分「项目推进 worker」与「代码修复 worker」两种类型，用单一 Project Worker 统一承接所有 Ticket。** 具体做法：在 bundle 的 `cordis.patch.yml` **删除原 `dsh-superagent-worker-preset` 行、新增 `dsh-superagent-worker-project-preset`**（preset 配置 id 为 `dsh-superagent-worker-project`），并把 `src/app/sessions.ts:48` 的 `WORKER_PRESET` 常量改为 `dsh-superagent-worker-project`（守卫 `:127` 与建会话 `:145` 因而自动跟随）。Project Worker 以 **GitHub 仓库代替项目资料库**、依据仓库推进项目（起草方案与任务、提交成果 PR），并在需要本人决策处停下。

采用**混合映射**：仓库文件/Release 当带版本的资料；Issue 当方案与任务、PR 当成果；PR review/merge 与 issue 关闭是**人的决策**，worker 绝不代替。MVP 只做「资料 / 方案 / 任务 / 成果 / 评审」五件。worker 的提示词（`promptFile('worker')`）直接改写为项目推进版；细粒度 GitHub 操作放随 `tool-skill` 加载的 skill。

## Considered Options
- **两种 worker 并存 + 路由**（放弃，即上一版设计）：需维护两套提示词与 `workerKind`/label 路由，复杂度不换收益；用户决定统一为一类。
- **抽离协作服务的成员 Agent**（放弃）：耦合重、版本不匹配、语义错位。
- **纯文件驱动**（仓库目录即所有实体）：无法承载评审/验收/待办这类人决策。
- **纯 Issue/PR 驱动**：丢掉「资料库带版本」的语义。

## Consequences
- **不再保留「随手改代码 / 快速修复」的独立能力**（用户已明确）：一切以「项目推进」流程承载——读仓库→方案→任务→成果 PR→人评审。原先「飞书 → 改 README 错字 → PR」不再作为一条独立路径。
- **删除旧 preset 的代价**：此前用 `dsh-superagent-worker` 创建的会话/ticket，在 resume 时会报 `agent-preset/not-found`（上游明确删 preset 会 resume 失败）。上线前须**清理旧 worker 会话/旧 ticket**（例如重置 profile 的 `sessions` 目录、关闭旧工单；当前部署中已有工单 `a9edbcf…`）。
- **改动面收敛**：只需改 `sessions.ts:48` 常量值、改写 worker 提示词、在 `cordis.patch.yml` 增删一行 preset、新增一个 skill（该 skill 需在 `skill-files.ts`/`context.ts`/`prompts.ts`/`sessions.ts` 少量接线，才能作为打包内置 skill 注册生效）；**不再需要** `workerKind`、路由、assessment 改 schema，也**无需改 `WORK_TOOLS`**（复用现有 fs/shell/web/todo/skill，GitHub 操作走 `shell + gh`）。
- 项目推进的每一步都以 GitHub issue/PR/评论留痕，`trace` 可回溯；人始终掌握方案确认、评审与合并，worker 的「完成」= 推进到人决策边界。
