# 设计：GitHub 资料库 + 统一的 Project Worker

> 状态：设计稿（未改代码，待评审）。配套决策见 [ADR 0003](adr/0003-github-as-project-library-and-project-worker.md)。
> 本稿已按最新决定修订：**取消「Project Worker / Code Worker」两类并存**，改为 **Project Worker 统一取代 Code Worker**；`cordis.patch.yml` 删除旧 `dsh-superagent-worker-preset`、新增 `dsh-superagent-worker-project-preset`；不再保留“快速改代码”能力。
> 2026-11-05 更新（ADR 0004）：Project Worker 角色改为**协调者**——只归档资料、出计划、跟踪产品/前端各自提交的成果，**不执行、不验收、不合并**；下文“推进 / 提交成果 PR”的措辞按此更新理解。
> 2026-11-06 更新（ADR 0005）：岗位不再写死，改由项目仓库的 `settings/team.yml` 定义；协调者读它决定岗位/人员/@ 谁/谁审批合并。

## 1. 目标

在 dsh-superagent 原有框架内，把 Worker 统一为一种 **Project Worker**（agent preset `dsh-superagent-worker-project`），它以 **GitHub 仓库代替项目资料库**，依据仓库**推进项目**：读仓库 → 起草方案 → 拆任务 → 交成果 → **停在人工评审/合并**。**所有 Ticket 都由它承接**；原「代码修复 worker」被取代、其 preset 行删除。

## 2. 术语（见 GLOSSARY.md）

- **Project Worker**：现在唯一的 Worker；**协调者**——归档资料、为产品/前端出计划并跟踪其各自提交的成果，止于人工评审/合并；不执行、不验收。
- **GitHub 资料库**：以仓库承载项目资料与版本；文件/Release 是资料，Issue/PR 是方案、任务与成果。

> 原术语 `worker kind`（代码修复 / 项目推进）**已废弃并删除**——只有一种 worker，无需 kind。

## 3. 实体 → GitHub 落地（混合映射，MVP=五件）

| workbench 实体 | GitHub 落地 | 版本/状态 | MVP |
|---|---|---|---|
| 资料（带版本） | 仓库文件 `materials/<角色>/…`；大交付物=Release 资产 | 版本=commit / tag | ✅ |
| 方案（plan） | Issue + label `plan`；阶段用 Milestone | 人确认后生效 | ✅ |
| 任务（task） | Issue + label `task`，关联方案 issue（tasklist） | open/closed | ✅ |
| 成果（result） | PR（落 `results/` 或代码），一次提交=一个 PR | 版本=PR commit | ✅ |
| 评审/验收 | PR **review**（approve / request changes）+ merge / issue close | **人执行** | ✅ |
| 分析（只读建议） | `analysis/` markdown 或 issue 评论 | 只读 | 二期 |
| 进展 / 待办 / 追溯 | issue/PR 评论 / Project 看板「待办」列 / issue·PR 时间线+git | — | 二期 |

单仓库单项目（MVP）。这里的 `plan`/`task` label 是 worker **写**到 issue 上的标记（`gh issue create --label`），不依赖 Source 读取 labels。

## 4. agent preset（替换，不是新增并存）

在 `dsh-superagent-prototype/cordis.patch.yml`：

1. **删除** `- id: dsh-superagent-worker-preset`（其 `config.id: dsh-superagent-worker`）整块；
2. **新增** 下面这块（结构照抄原 worker preset 的工具片段，仅换 id/展示名/persona）：

```yaml
- id: dsh-superagent-worker-project-preset
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: dsh-superagent-worker-project
    name: dsh-superagent 项目推进执行器
    description: 以 GitHub 仓库为项目资料库、依据仓库推进项目的 worker；评审与合并留给人。
    order: 90
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: You are a project-advancing agent powered by the {{model}} model. You treat the GitHub repository as the project's material library and advance the project through issues and pull requests; you never make the human's own review/acceptance/merge decisions.
      - id: agent-instructions
        name: '@deepseek-ai/dsh-agent-instructions'
        config: { maxBytes: 65536 }
      - id: time-context
        name: '@deepseek-ai/dsh-time-context'
      # shell / tool-bash / tool-fs / tool-fs-search / tool-jobs /
      # skill-filesystem / tool-skill / compaction / tool-todo / tool-web：
      # 直接照抄原 worker preset 的对应片段。
```

> preset 只能引用**已存在的 DSH 插件/工具**。GitHub 操作全部走 `shell + gh`（镜像已装 `gh`、有 `GH_TOKEN`），**MVP 不新增工具插件、不改 `WORK_TOOLS`**。

## 5. 最小改动面（源码）

| 文件 | 改动 | 作用 |
|---|---|---|
| `src/app/sessions.ts:48` | `WORKER_PRESET = 'dsh-superagent-worker-project'`（改常量值） | 守卫 `:127` 与建会话 `:145` 自动跟随，全量切到新 preset |
| worker 提示词（`promptFile('worker')` 指向的文件） | 改写为项目推进版（见 §7/§8：流程 + 硬性“止于人工评审/合并” + 回报格式） | 让 worker 行为变为项目推进；role 仍是 worker，无需改选择逻辑 |
| `cordis.patch.yml` | 删旧 `dsh-superagent-worker-preset`，加新 `dsh-superagent-worker-project-preset` | 注册唯一 worker |
| `skills/dsh-superagent-project/SKILL.md` | 新增打包 skill（frontmatter `name`/`description` + 正文） | 固化领域流程 |
| `src/app/skill-files.ts` | `bundledSkills` 增加 `project: load('project')` | 打包读取新 skill |
| `src/app/context.ts` | 导出 `projectSkill = bundledSkills.project.content` | 供 prompt 组装 |
| `src/app/prompts.ts` | `PART_KEYS`/`builtInParts` 加 `skill/project`；`composeSkill` 与 `skills()` 纳入 `project`；`SkillNameSchema` 禁同名团队 skill | 让 skill 真正注册进每个 Session |
| `src/app/sessions.ts:320` | `bundled` 判定纳入 `project` | 让 skill 的 `resourceBase` 指向打包目录 |

> **不需要**：`workerKind`、Ticket/Mandate 改字段、assessment 选 kind、label/文本路由、`WORK_TOOLS` 修改。
> **上线迁移**：删除旧 preset 后，旧 worker 会话 resume 会 `agent-preset/not-found` → 上线前清理旧 `sessions`（或关闭旧 ticket；当前部署有 `a9edbcf…`）。

## 6. 路由

**不适用**：只有一种 worker，所有 Ticket（不论来源飞书还是 GitHub）都走 Project Worker。原“双 worker 按 kind 路由”的设计已删除。

## 7. Skill 大纲（`skills/dsh-superagent-project/SKILL.md`，经 `skill-files.ts`→`prompts.ts` 注册为内置 skill）

- 目录/标记约定：`materials/`、`analysis/`、`results/`；issue label `plan`/`task`；Milestone=阶段。
- 读上下文：`gh issue list/view`、`gh pr list/view`、读仓库文件，先建立项目现状。
- 起草 `plan` issue 模板：背景 / 目标 / 范围 / 任务拆解 / 风险 / 待决事项 / 验收标准。
- 拆 `task` issues 并关联方案（tasklist / 子 issue）。
- 交成果 PR：分支命名、PR 模板、关联 task、落 `results/` 或代码。
- **何时停**：方案确认、评审、验收、合并**一律留给人**；禁自 `gh pr merge` / `gh pr review --approve` / `gh issue close`（除非人已明确批准）。
- 回报格式：回飞书线程/issue 评论的结构化摘要（做了什么、产物链接、下一步等谁）。
- 反例：不代人确认、不伪造评审、不改无关文件、不重复建 issue。

## 8. worker 提示词要点 + 一轮步骤

提示词要写清：你是项目推进执行器，仓库即资料库；按 §8 流程推进；**凡方案确认/评审/验收/合并一律停下等人**；不臆造、不越权。

一轮步骤：
1. 读仓库（`materials/`、plan/task issues、results/）；
2. 分析（只读）给缺口与建议；
3. 起草方案：创建 `plan` issue；
4. 拆任务：创建 `task` issues 并关联；
5. **停**：报告 `waiting + human_action` 回报“方案已提交待确认”（飞书线程 + issue 链接）；
6. 人确认后（在该 thread / issue 回复，复用现有 **follow-up** 触发续跑同一 Ticket）；
7. 交成果 PR（落 `results/`，关联 task）；
8. **停**：回报“PR 待评审/合并”；
9. 人 merge 后：关闭对应 task、评论更新进展。

**完成判定**：worker 的“完成”= 推进到**一个人决策边界**（方案待确认 / PR 待评审）即本轮完成并回报，**不是**“项目结束”。绝不自动 merge/approve/close。

## 9. 验收 demo 与通过标准

**场景**：测试仓库（如新建 `Lafinger/dsh-project-demo`）+ 飞书群 @机器人：`推进项目：为仓库建立 CHANGELOG，并拆成任务`。

**期望链路**：ticket → Project Worker → 读仓库 → 建 `plan` issue → 建 `task` issue → 飞书回报“方案待确认”；人回复确认 → 开 PR 落 CHANGELOG → 回报“PR 待评审”；人 merge → 收尾。

**通过标准**：
1. 全链路在 GitHub 留下 issue / PR / 时间线；
2. worker **全程未自动** merge / approve / close；
3. 飞书收到“方案待确认”“PR 待评审”两次关键回报；
4. `trace`（issue/PR 时间线 + git history）可回溯每一步。

## 10. 风险与未决

- **删旧 preset 的迁移**：旧会话/ticket resume 会 `not-found`；上线前必须清理旧 `sessions` / 关闭旧 ticket。
- **能力收窄**：不再支持“随手改代码/快速修复”；简单代码改动只能作为某项目的“成果 PR”落到项目流程里。
- **gh 能力边界**：`GH_TOKEN` 需 `repo`（含 Issues/PR）；Release 资产上传、分支保护、审批要求视仓库设置。
- **大文件/Release**：资料库若放二进制，走 Release 资产而非 git 大文件。
- **单项目/仓库**：MVP 假设一仓库一项目；多项目需目录命名空间或 Milestone 区分。
- **并发与重复**：同一请求重复触发可能重复建单，需幂等键（issue 号 + 阶段）。
- **安全**：worker 以容器内 `gh` 身份操作仓库，须限定到测试仓库、最小 token 权限。
