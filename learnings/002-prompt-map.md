# 提示词地图:15 份文件怎么变成两个角色的大脑

> 配套阅读:[001-feishu-message-journey.md](001-feishu-message-journey.md)(消息走完链路时,哪一步读哪份)
>
> 英文原文:`../prompts/` 中文翻译(仅供阅读,运行时不加载):`../prompts_cn/`

## 1. 两套顺序,一套代码

同一段拼装逻辑,只按角色取不同段(`../src/app/prompts.ts` 的 `promptParts`)。

| # | 主控 orchestrator | worker | 说明 |
|---|---|---|---|
| 1 | `shared.md` | `shared.md` | 分工契约,两角色都有 |
| 2 | `orchestrator.md` | `worker.md` | 人设 |
| 3 | `team/communication.md` | 同左 | 团队可编辑 |
| 4 | `team/scope.md` | 同左 | 团队可编辑 |
| 5 | `team/delivery.md` | 同左 | 团队可编辑 |
| 6 | `subscriptions.md` | 同左 | `## subscriptions` |
| 7 | `replies.md` | 同左 | `## replies` |
| 8 | `dispatch.md` | `work.md` | **分岔点** |
| 9 | `admission.md` | — | 只有主控评估候选 |
| 10 | `handoff.md` + `handoff-orchestrator.md` | `handoff.md` + `handoff-worker.md` | 交班 |
| 11 | (生成)执行环境段 | 同左 | 变量来自 `execution-environment.ts` |
| 12 | (生成)Policy 段 | — | 只有主控;永远最后,`order: 9999` |
| 13 | — | `mandateInstructions(ticket)` | 该工单的授权边界,追加在最后 |

关键差异,记住这三条就够:

- **只有主控读** `admission.md` 和 Policy 段 —— 因为"要不要接活"是它的职责
- **只有 worker 读** `work.md` 和 mandate —— 因为"这活能干到哪"由工单授权决定
- 中间三份 `team/*` **两边都读** —— 团队规矩对评估和干活同时生效

## 2. 15 个文件 × 覆盖键 × 行数

覆盖键(`PartKey`)是面板上改这一段时用的名字,定义在 `../src/app/prompts.ts:24`。

| 文件 | 覆盖键 | 角色 | 行数 | 可否团队覆盖 |
|---|---|---|---|---|
| `shared.md` | `runtime/shared` | 双 | 7 | ✅ |
| `orchestrator.md` | `runtime/orchestrator` | 主控 | 16 | ✅ |
| `worker.md` | `runtime/worker` | worker | 7 | ✅ |
| `subscriptions.md` | `runtime/subscriptions` | 双 | 13 | ✅ |
| `replies.md` | `runtime/replies` | 双 | 35 | ✅ |
| `dispatch.md` | `runtime/dispatch` | 主控 | 59 | ✅ |
| `work.md` | `runtime/work` | worker | 49 | ✅ |
| `admission.md` | `runtime/admission` | 主控 | 68 | ✅ |
| `handoff.md` | 拼进下面两个 | — | 6 | 随下面的键 |
| `handoff-orchestrator.md` | `runtime/handoff/orchestrator` | 主控 | 4 | ✅ |
| `handoff-worker.md` | `runtime/handoff/worker` | worker | 7 | ✅ |
| `team/communication.md` | 团队区 `communication` | 双 | 97 | ✅(面板直接改) |
| `team/scope.md` | 团队区 `scope` | 双 | 22 | ✅ |
| `team/delivery.md` | 团队区 `delivery` | 双 | 28 | ✅ |
| `cli.md` | 拼进两个 Source 技能 | 双 | 17 | 随技能 |

另外三个"生成段"没有对应文件,模板写在代码里:

| 覆盖键 | 模板位置 | 占位符 |
|---|---|---|
| `runtime/environment` | `prompts.ts` 的 `ENVIRONMENT_HEADING` | `{variables}` |
| `runtime/policy` | `prompts.ts` 的 `POLICY_HEAD` | `{version}` `{mode}` `{rules}` |
| `runtime/policy/none` | 同上 | `{version}` `{mode}` |

## 3. 技能是另一条路:不进系统提示

`cli.md` 和两个 Source 技能**不拼进系统提示**,它们注册成 DSH 技能,模型需要时用 `skill` 工具加载。

| 技能名 | 组成 | 谁有 |
|---|---|---|
| `dsh-superagent-feishu` | `../skills/dsh-superagent-feishu/SKILL.md` + `## CLI usage` + `cli.md` | 双 |
| `dsh-superagent-github` | `../skills/dsh-superagent-github/SKILL.md` + `## CLI usage` + `cli.md` | 双 |
| `dsh-superagent-project` | `../skills/dsh-superagent-project/SKILL.md` | worker |

- 拼接处:`../src/app/prompts.ts:68-70`
- 注册处:`../src/app/sessions.ts:323`(`SKILL_PREFIX = 'dsh-superagent-'`)
- `feishu/github/project` 是**保留名**,自定义技能不能占用(`prompts.ts:21`)

这样设计的好处:**系统提示不背手册**。飞书分页、lark-cli 子命令这些细节只在真的要用时才进上下文。

## 4. 注入点与生命周期

```
每次模型请求
  → sessions.ts:244  systemPrompt.section({ name:'dsh-superagent-policy', order:9999,
                                           interpolate:false, complete:master })
  → prompts.compose(config, role, environment?, policy?)
  → 取当前提示词版本 → 拼装 → 加头 "[dsh-superagent prompt revision N]"
```

四个细节值得知道:

- **`order: 9999`**:Policy 段永远在最后(注释写明 "nothing follows"),它的改动不影响前面的段
- **`complete: true`(仅主控)**:独占系统提示,不再叠加别的插件的段落
- **`interpolate: false`**:禁止 DSH 变量插值,防止团队写的 `${{ ... }}` 被当表达式求值
- **每次请求重拼**:所以面板改完提示词,**下一回合就生效**,不用重启

## 5. 版本化与"团队可编辑"到底改的是什么

提示词配置(`PromptConfig`)长这样:

```ts
{
  communication: string,   // 团队区:## Communication
  scope: string,           // 团队区:## Ticket scope
  delivery: string,        // 团队区:## Delivery requirements
  skills: { [name]: string },                 // 自定义技能
  overrides?: { [partKey]: { text, base } },  // 覆盖内置段
}
```

- **三份 `team/*`**:面板直接编辑,存成新版本(revision)
- **其它内置段**:不动源码,用 `overrides[partKey].text` 覆盖;`base` 记录它当初是从哪段默认文本改的,
  升级后能提示"默认文本变了"
- **保存位置**:`KV.prompts.version:<revision>`,指针在 `KV.prompts.revision`(`../src/kv.ts`)

## 6. 排版规矩(改文本前必看)

- **源码一句一行**,是为了 diff 可读;`promptFile()` 会把**同一段落内的换行合并成空格**,只保留空行分段
  (`../src/app/skill-files.ts:29`)
- 所以:想在提示词里换行 → **空一行**;单换行会被吃掉
- 段落里出现 `{name}` 这种花括号,只有在生成段的模板里有意义,普通段落里是字面量

## 7. 修改建议(按风险从低到高)

| 想做什么 | 怎么做 | 风险 |
|---|---|---|
| 改"什么时候许发 IM"、"多大算小改动"、"PR 要不要 Before/After" | 面板 Prompts → 团队区三段 | 低,立即生效 |
| 改某个内置段(比如加一条硬规矩) | 面板 → 该段的 override | 中,记得 `base` 保留以便升级对比 |
| 加一个团队专属技能 | 面板 → 技能 | 低,占用 `dsh-superagent-<name>` |
| 直接改 `../prompts/*.md` | 只在对整个部署有意义的改动时做,且要考虑所有团队 | 高,影响所有安装 |
| 改 `../src/app/context.ts` 的拼接顺序 | 基本不要做,顺序有语义(尤其 Policy 必须在最后) | 很高 |

## 8. 三个最容易踩的坑

1. **中文翻译不能直接替换英文原文**:工具名、状态词(`ready`/`blocked`/`progress`)、`rule_assessments` 的字段名
   都是英文契约,翻成中文会直接调用失败。`../prompts_cn/` 只用于阅读。
2. **改提示词不等于改行为**:真正的硬边界在代码里(工具白名单、`restrict`、`guard`、闸门、mandate)。
   提示词是"软约束",别指望它替代权限。
3. **看不到效果时先确认读了哪一版**:系统提示开头有 `[dsh-superagent prompt revision N]`,
   worker Session 的 `promptVersion` 也能查 —— 有时是版本没生效,而不是提示词没写对。
