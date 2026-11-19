# 一条飞书消息的完整旅程

> 目标:搞清楚"某人在飞书里 @ 机器人说了一句话",到"PR 被合并、结果发回飞书"之间,系统做了什么、读了哪份提示词、代码在哪。
>
> 所有路径相对本文件(`learnings/`),源码在 `../src/`。

## 0. 先认人:两个角色、两个 Session

系统只跑两种 Session,它们的区别是**提示词不同**、**工具不同**:

| 角色 | 谁 | Session 预设 | 能做什么 | 不能做什么 |
|---|---|---|---|---|
| **主控** orchestrator | 主 Session,进程启动时就存在 | `dsh-superagent-router`(在 `../cordis.patch.yml` 里定义) | 评估候选、路由、交付通知、发飞书 | 读代码细节、改代码、自己解决问题 |
| **worker** | 每个工单一个,按需创建 | `dsh-superagent-worker` | 调查、改码、跑测试、开 PR、报告 | 决定要不要接活、发飞书通知 |

主控的能力边界不是"靠自觉",是**物理限制**:它的工具被 `restrict` 到
`skill / bash / read / read_image / job_output / job_list / job_kill` + 自己的 `orchestrator_*`,
**没有 write / edit**(见 `../src/app/sessions.ts:263`)。
这与 `../prompts/shared.md` 里"主控不许自己动手"的规矩是配套的——提示词和代码互相兜底。

---

## 1. 取到消息(没有模型参与)

飞书 Source 通过 `lark-cli`(**bot 身份**)做三件事:消费事件、恢复历史、轮询订阅的话题。
三种入口共用一套读位点,`POLL_HORIZON_MS` 决定回溯窗口。

- 源码:`../src/sources/feishu.ts`(kind + 插件入口 `./feishu-watch`)、`../src/sources/feishu-loops.ts`、`../src/sources/poll.ts`
- CLI 传输:`../src/infra/commands.ts` 的 `lark`,始终 `--as bot`(不可用时**不允许**切换成用户身份,见 `../prompts/cli.md` 第 8 行)
- 提示词:无

## 2. 消息 → Trigger

把飞书消息翻译成领域对象 `Trigger`:id、线程键、发送者、文本、图片 id、`meta`。
**live 事件、历史分页、话题分页走同一条规则**,保证同一条消息在三种入口得到同一个 Trigger id(否则去重会失效)。

- 源码:`../src/sources/feishu-trigger.ts`
- 提示词:无

## 3. 闸门:这条消息配不配被处理(仍无模型参与)

`gate(trigger, thread, tickets)` 判定两件事:**强度**和**依据**。

| 依据 `via` | 什么情况 | 强度 | 后续 |
|---|---|---|---|
| `addressed` | 白名单发送者 @ 了 agent | `explicit` | 直接给主控路由,**不做评估** |
| `followup` | 消息落在一个已有工单的线程上 | — | **不评估**,直接扇出给那个工单的 worker |
| `admission` | 准入表某格(如 issue 区、评论区的默认行为) | `inferred` | 作为**主动候选**进评估 |
| `bot` | 白名单机器人的消息 | `inferred` | 同上 |

- 源码:`../src/policy.ts`(`settingsPolicy().gate`)、准入表取值 `../src/admission.ts`
- 不通过 → Trigger 记为 `filtered` 并到此结束,**一次模型调用都不会发生**。这是省钱的第一道闸。
- 提示词:无

## 4. Intake:去重、扇出、排队

四个动作,一个事务:

1. 按 Trigger id **只存一次**(重复投递 → `duplicate`)
2. 记 `disposition`(它去过哪些工单、被谁交还、被谁确认)
3. **扇出**给该线程上已订阅的工单;若是人的消息,可能**立刻恢复**一个已结束的工单
4. 否则在**主线程**上排队,等下一次评估

- 源码:`../src/core/intake.ts`(类 `Intake`)、`../src/core/engine.ts`(`receive`)
- 提示词:无
- 记:这就是 learnings demo-01 讲的"同 id 去重、到达中的触发合并成下一批"的真实实现

## 5. 合成一批 + 定时起评估

同一线程排队中的多个 Trigger **合并成一个 Eval**(一个"批次"),并设 `deadline`。
`passes` 每 **2 秒**跑一轮:先跑到期的 effects,再 `Engine.evaluateDue()` 启动到期 Eval;
超时重排两次,第三次记 `unavailable`(评估失败,不是规则不匹配)。

- 源码:`../src/core/evals.ts`、`../src/app/passes.ts`、`../src/core/engine.ts`(`evaluateDue`)
- 提示词:无
- 暂停(paused)期间不产生新的 Eval,已有 deadline 会整体后移

## 6. 候选卡投进主 Session

`MasterAssessor.request` 先排一个 `assessment` effect;effect 执行时生成**候选卡**,并把它送进主 Session 的
**下一个回合**(不是立刻打断),然后告诉 Engine 已送达(`candidateDelivered`),超时才从这一刻开始计。

卡片里有什么:来源引用、本批触发、该线程已有工单(含已结束)、该触发已投递过的工单(`delivered_to`)、
消息里提到的 PR/Issue 对应工单(`referenced_tickets`)、以及 `handed_back` 标记。

- 源码:`../src/app/assessment.ts`(`MasterAssessor`)、`../src/app/cards.ts` + `../src/app/links.ts`(`candidateCard`)、`../src/app/notices.ts`、`../src/app/delivery.ts`、`../src/app/effects.ts`(kind `assessment`)
- 提示词:下一步就是,主控的系统提示已在内存里

## 7. 主控的提示词在这里拼好 ⭐

主 Session 每次请求前现场拼装,`order: 9999`、`complete: true`(**独占**系统提示,不叠加别的插件段落)。

- 注入点:`../src/app/sessions.ts:244` 的 `systemPrompt.section(...)`
- 拼装函数:`../src/app/prompts.ts` 的 `promptParts()`
- 文本来源:`../src/app/context.ts`(→ `promptFile()` 读 `../prompts/*.md`)

**主控的拼接顺序(12 段)**

```
 1  shared.md                       两个角色的分工契约
 2  orchestrator.md                 主控人设
 3  team/communication.md           ← 团队可编辑
 4  team/scope.md                   ← 团队可编辑
 5  team/delivery.md                ← 团队可编辑
 6  subscriptions.md                ## subscriptions
 7  replies.md                      ## replies
 8  dispatch.md                     ## dispatch(只有主控有)
 9  admission.md                    主动候选评估(只有主控有)
10  handoff.md + handoff-orchestrator.md
11  (生成)执行环境段                execution-environment.ts 提供变量
12  (生成)Policy 段                 永远最后,order 9999
```

- 同时:`restrict` 工具集(见第 0 节),并加一个 `tools.guard`:主控若跑起 router preset 之外的东西会被拒

## 8. 评估主动候选(`admission.md` 生效)

三个工具接力:

1. `orchestrator_eval` —— 拿"窗口":线程前几页 + 触发前后各 5 条(长文按字符截断并标总长)+ 其余消息的存根
2. `orchestrator_eval_read` —— 按 id 补读某条消息 / 线程后续页 / 仓库文件 / **图片**
3. `orchestrator_eval_decide` —— 提交 `direction`(三个布尔 + 证据)+ **每条启用规则**一条 `rule_assessments` + `scope` + `worktree_name`

窗口构建:`../src/sources/admission-context.ts`;图片:`../src/sources/feishu-read.ts` + `feishu-image.ts`
判定转换:`../src/policy.ts` 的 `assessmentOutcome`(要求:每条启用规则都有判断、方向已定、有匹配规则、有意图证据;
非 auto 模式下的 accept 只记一条 "would accept",真去问人)

- 提示词:**`../prompts/admission.md`(68 行,只给主控)**
- 注意:**明确请求(`explicit`)不走这一步**,直接进第 9 步

## 9. 路由决策(`dispatch.md` 生效)

`orchestrator_route`,每个候选一条 item:`accept` / `attach` / `stop` / `ignore`。

`accept` 是**一个原子事务**:建 Ticket + 写 Mandate(授权)+ 建第一个 Assignment + 订阅线程 + 排确认语,
要么全成要么全回滚(learnings demo-03 的 `atomic()` 就是这个)。

- 源码:`../src/app/tools/main.ts` → `../src/core/engine.ts`(`decide` / `attach`);规则在 `../src/core/evals.ts`
- 提示词:**`../prompts/dispatch.md`**(怎么路由)、**`../prompts/replies.md`**(确认语能不能发、多长)

## 10. 建工单、起 worker Session

`DshExecutor.prepare(ticket, outcome)` 给出:短名、目录(`--directory` 根下)、assignment 文本;
`launch` effect 起 Session,Session 名由工单 id 派生;`WorkerSlots` 卡并发(人消息可多占一个槽,唤醒优先于新起)。

- 源码:`../src/executor/dsh.ts`、`../src/core/tickets.ts`、`../src/app/effects.ts`(kind `launch`)

## 11. worker 的提示词 ⭐

同一个 `promptParts()`,但角色是 `worker`,顺序不同:

```
 1  shared.md
 2  worker.md                        worker 人设
 3-5 team/communication · scope · delivery   ← 同样三份,worker 也读
 6  subscriptions.md
 7  replies.md
 8  work.md                          ## work(只有 worker 有)
 9  handoff.md + handoff-worker.md
10  (生成)执行环境段(仓库、目录、$DSH_SUPERAGENT_* 变量)
11  mandateInstructions(ticket.mandate)   ← 该工单的授权边界,最后追加
```

**差异**:worker **没有** `admission.md`,**没有** Policy 段(那是主控判断"要不要接活"用的)。

**技能单独注册**(不在系统提示里,模型按需 `skill` 加载):

- `dsh-superagent-feishu` = 飞书技能 + `cli.md`
- `dsh-superagent-github` = GitHub 技能 + `cli.md`
- `dsh-superagent-project` = 项目技能(只给 worker)

源码:`../src/app/sessions.ts:323`(`scope.skills.register`)、`../src/app/skill-files.ts`(打包文件加载)

## 12. 干活、报告、交付

```
worker: orchestrator_ack(开工前确认)
      → 调查 / 改码 / 跑检查 / 开 PR
      → orchestrator_report(progress|ready|blocked|failed|dropped,
                           需要人决策时带 human_action 提问)
                    ↓
Engine.report → Assignments 记录
                    ↓ 需要人决策时
Engine.reply(purpose=attention) → Replies
                    ↓
Outbox.send:一个事务里存 receipt + 排 reply effect
                    ↓
reportRelay(notices.ts)把报告/问题送进主 Session 回合
                    ↓
主控:orchestrator_reply(purpose=result|attention|answer)
                    ↓
reply effect → SourceRegistry.send → feishu-channel.ts(返回 sent / gone)
```

- 源码:`../src/app/tools/executor.ts`、`../src/core/assignments.ts`、`../src/core/replies.ts`、`../src/app/outbox.ts`、`../src/app/notices.ts`、`../src/sources/feishu-channel.ts`
- 提示词:`../prompts/dispatch.md`(何时交付)、**`../prompts/team/communication.md`**(能不能发、一句话怎么写)、`../prompts/handoff.md` + `handoff-worker.md`(提问怎么传)
- 排队与丢弃:来源关着 → 消息等待重试;对话没了或不再监听 → `gone`,**不换目的地重发**(`replies.md` 明确禁止)

## 13. 之后的消息(订阅生效)

- 订阅线程上的新消息 → 扇出到工单 → `delivery` effect → 进 worker Session,**不再走评估**
- 人说"停" → `stopTicket`(撤回 Mandate,工单保持结束)
- worker 判断"这不属于我的工单" → `handback` → 重新排队评估

- 源码:`../src/core/intake.ts`、`../src/core/tickets.ts`、`../src/core/assignments.ts`
- 提示词:`../prompts/subscriptions.md`、`../prompts/work.md`(第 8–9 行专门讲这件事)

---

## 速查表:消息走到哪一步,读哪份提示词

| 阶段 | 谁在思考 | 生效的提示词 | 关键源码 |
|---|---|---|---|
| 收消息 / 过滤 | 无人 | — | `sources/feishu*.ts`、`policy.ts` |
| 候选评估 | 主控 | `admission.md` + `orchestrator.md` + Policy 段 | `app/assessment.ts`、`sources/admission-context.ts` |
| 路由分派 | 主控 | `dispatch.md`、`replies.md` | `app/tools/main.ts`、`core/evals.ts` |
| 干活 | worker | `work.md`、`team/scope.md`、`team/delivery.md` + mandate | `executor/dsh.ts`、`app/tools/executor.ts` |
| 交付 | 主控 + worker | `team/communication.md`、`replies.md`、`handoff*.md` | `app/outbox.ts`、`sources/feishu-channel.ts` |
| 后续消息 | worker | `subscriptions.md`、`work.md` | `core/intake.ts`、`core/tickets.ts` |

## 三个常见误解

1. **"主控会自己看代码判断"** —— 不会。它只有 `read`,而且 `shared.md`/`admission.md` 反复禁止它用代码判断;
   技术判断留给 worker。
2. **"提示词是启动时读一次"** —— 不是。每次模型请求都按**当前提示词版本**重新拼(`prompts.ts` 的 `compose`),
   所以面板上改完提示词,下一个回合就生效,不用重启。
3. **"消息来了就直接派 worker"** —— 不。先过闸门(第 3 步),再过评估(第 8 步),最后才路由(第 9 步)。
   闸门和过滤都不花模型钱。

## 想亲眼确认

```powershell
# 1) 当前配置 + 两个角色拼好的完整提示词(模型真正拿到的文本)
curl -H 'x-orchestrator-request: 1' http://127.0.0.1:<port>/orchestrator/api/prompts

# 2) 只做拼装预览(不保存)
curl -X POST -H 'x-orchestrator-request: 1' -H 'content-type: application/json' `
  -d '{}' http://127.0.0.1:<port>/orchestrator/api/prompts/preview
```

- 路由定义:`../src/app/http.ts:122`(`promptsView`)、`../src/app/http.ts:212`(`prompts/preview`)
- 面板等价位置:**Prompts → Full prompt** 标签
