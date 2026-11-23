/** 工时数据装配 v2：读计划/任务 issue、结果 PR 与团队文件，产出 计划 → 角色 → 任务 的分层结构。 */
import { execFileSync } from 'node:child_process'
import type { Ticket, Trigger } from '../core/index.ts'
import { buildTasks, declaresPlan, hours, parseTaskMeta, renderMarkdown, type Coordination, type PlanIssue, type PlanTimesheet, type PullRequest, type RoleTimesheet, type TaskIssue } from '../sources/timesheet.ts'

/** 计划完成时回贴的评论标记，用于幂等。 */
export const TIMESHEET_MARK = '<!-- dsh-timesheet -->'

type Json = Record<string, unknown>

function run(cli: string, args: string[]): string {
  return execFileSync(cli, args, { encoding: 'utf8', maxBuffer: 32 << 20 })
}
function ghJson(cli: string, path: string, extra: string[] = []): unknown {
  return JSON.parse(run(cli, ['api', ...extra, path]))
}
/**
 * Every page of a list: `--paginate --slurp` hands back one JSON array of pages, flattened here.
 * Reading a single 100-entry page used to drop plans, tasks and pull requests from larger repositories.
 */
export function flattenPages(pages: unknown): unknown[] {
  return Array.isArray(pages) ? pages.flatMap(page => asArray(page)) : []
}
function ghJsonPages(cli: string, path: string): unknown[] {
  return flattenPages(ghJson(cli, path, ['--paginate', '--slurp']))
}
/** A plan number that does not exist makes gh exit non-zero with `gh: Not Found (HTTP 404)`; that is a 404, not a 500. */
export function isNotFound(error: unknown): boolean {
  const value = error as { stderr?: string | { toString(): string }; message?: string } | undefined
  const stderr = typeof value?.stderr === 'string' ? value.stderr : value?.stderr?.toString() ?? ''
  return /HTTP 404/.test(`${stderr}\n${value?.message ?? ''}`)
}
const asObject = (value: unknown): Json => (typeof value === 'object' && value !== null ? value as Json : {})
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
const labelName = (value: unknown): string => typeof value === 'string' ? value : asString(asObject(value).name)

/**
 * Reads one result PR out of an issues-list entry: the list already returns the body and
 * `pull_request.merged_at`, so no separate `pulls/{n}` request is needed.
 */
export function asPull(item: Json, number: number): PullRequest {
  const pull = asObject(item.pull_request)
  return {
    number,
    title: asString(item.title),
    body: asString(item.body),
    createdAt: asString(item.created_at),
    mergedAt: asString(pull.merged_at) || null,
  }
}

export interface TimesheetSource {
  cli: string
  repository: string
  tickets: Ticket[]
  triggerOf: (id: string) => Trigger | undefined
  /** The plan issue a ticket reported, with the requirement message time; read before any message-link match. */
  planLinkOf: (plan: number) => { at: string } | undefined
}

/** The plan issue itself; undefined when the number does not exist, so the route can answer 404. */
function planIssue(cli: string, repository: string, number: number): PlanIssue | undefined {
  let item: Json
  try {
    item = asObject(ghJson(cli, `repos/${repository}/issues/${number}`))
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  return {
    number,
    title: asString(item.title),
    body: asString(item.body),
    createdAt: asString(item.created_at),
    closedAt: asString(item.closed_at) || null,
  }
}

/** 管理岗（审批人）：来自 team.yml 的 approver 块。 */
export interface Approver { role: string; person: string }

/** team.yml 里的团队：审批人 + 岗位（key/name/order）。 */
export interface Team { approver?: Approver; roles: { key: string; name: string; order?: number }[] }

/** 从 team.yml 文本解析 approver 与 roles；解析不到的部分留空。 */
export function parseTeam(text: string): Team {
  const lines = text.split(/\r?\n/)
  const blockOf = (key: string): string[] => {
    const start = lines.findIndex(line => new RegExp(`^${key}:\\s*$`).test(line))
    if (start < 0) return []
    const block: string[] = []
    for (let index = start + 1; index < lines.length; index++) {
      const line = lines[index] ?? ''
      if (line.trim() && !/^\s/.test(line)) break
      if (line.trim() && !/^\s*#/.test(line)) block.push(line)
    }
    return block
  }
  const pick = (block: string[], key: string) => block
    .map(line => line.match(new RegExp(`^\\s*${key}:\\s*(.+)$`))?.[1]?.trim())
    .find(value => !!value)
  const approverBlock = blockOf('approver')
  const approverName = pick(approverBlock, 'name')
  const approverPerson = pick(approverBlock, 'feishu_name') ?? approverName
  const approver = approverName
    ? { role: approverName, person: approverPerson ?? '' }
    : undefined
  const roles: Team['roles'] = []
  for (const line of lines) {
    const key = line.match(/^\s*-\s*key:\s*(\S+)/)?.[1]
    if (key) roles.push({ key, name: '', })
  }
  // 名字与顺序在 key 之后的行里，按顺序补齐。
  let cursor = 0
  for (let index = 0; index < lines.length; index++) {
    const key = lines[index]?.match(/^\s*-\s*key:\s*(\S+)/)?.[1]
    if (!key) continue
    const name = lines.slice(index, index + 8).map(line => line.match(/^\s*name:\s*(.+)$/)?.[1]?.trim()).find(Boolean)
    const order = lines.slice(index, index + 8).map(line => line.match(/^\s*order:\s*(\d+)/)?.[1]).find(Boolean)
    if (roles[cursor]) roles[cursor] = { key, name: name ?? key, ...(order ? { order: Number(order) } : {}) }
    cursor++
  }
  return { ...(approver ? { approver } : {}), roles }
}

/** 读仓库里的 settings/team.yml；读不到时返回 undefined。 */
export function readTeam(cli: string, repository: string): Team | undefined {
  try {
    const body = asObject(ghJson(cli, `repos/${repository}/contents/settings/team.yml`))
    return parseTeam(Buffer.from(asString(body.content), 'base64').toString('utf8'))
  } catch {
    return undefined
  }
}

/** 每个计划的话题开始时刻：只认工单消息里出现的 `issues/<n>` 链接。 */
export function threadStartByPlan(plans: PlanIssue[], tickets: Ticket[], triggerOf: (id: string) => Trigger | undefined): Map<number, string> {
  const starts = new Map<number, string>()
  const origins = tickets
    .map(ticket => {
      const origin = typeof ticket.origin?.triggerId === 'string' ? triggerOf(ticket.origin.triggerId) : undefined
      if (!origin?.at) return undefined
      const texts = [origin.text ?? '']
      for (const input of ticket.inputs ?? []) {
        const triggerId = (input as { triggerId?: string }).triggerId
        const text = typeof triggerId === 'string' ? triggerOf(triggerId)?.text : undefined
        if (text) texts.push(text)
      }
      return { at: origin.at, texts }
    })
    .filter((item): item is { at: string; texts: string[] } => item !== undefined)
  for (const plan of plans) {
    const linked = origins
      .filter(origin => origin.texts.some(text => new RegExp(`/issues/${plan.number}\\b`).test(text)))
      .map(origin => origin.at)
      .sort()
    if (linked.length) starts.set(plan.number, linked[0]!)
  }
  return starts
}

/** 管理岗的三时刻与两段等待；没有审批人时返回 undefined。 */
function coordinationFor(plan: PlanIssue, requirementStart: string | undefined, team: Team | undefined): Coordination | undefined {
  if (!team?.approver) return undefined
  const timestamps: Coordination['timestamps'] = {}
  if (requirementStart) timestamps.requirement_start = requirementStart
  if (plan.createdAt) timestamps.plan_published = plan.createdAt
  if (plan.closedAt) timestamps.plan_completed = plan.closedAt
  const durations: Coordination['durations'] = {}
  const confirm = hours(requirementStart, plan.createdAt)
  const close = hours(plan.createdAt, plan.closedAt)
  if (confirm !== undefined) durations.confirm = confirm
  if (close !== undefined) durations.close = close
  return { timestamps, durations }
}

/** 把任务按岗位分组，并在有审批人时追加 approver 角色。 */
function rolesOf(tasks: TaskIssue[], built: ReturnType<typeof buildTasks>, team: Team | undefined,
  plan: PlanIssue, requirementStart: string | undefined): RoleTimesheet[] {
  const metas = new Map(tasks.map(task => [task.number, parseTaskMeta(task.body)]))
  const groups = new Map<string, RoleTimesheet>()
  for (const task of built) {
    const meta = metas.get(task.number)
    const key = team?.roles.find(role => (meta?.order !== undefined && role.order === meta.order) || role.name === meta?.role)?.key
      ?? `role-${meta?.order ?? task.number}`
    const existing = groups.get(key)
    if (existing) existing.tasks.push(task)
    else groups.set(key, { key, name: meta?.role || '—', person: meta?.person || '—', tasks: [task] })
  }
  const roles = [...groups.values()]
  const coordination = coordinationFor(plan, requirementStart, team)
  if (team?.approver && coordination) {
    roles.push({ key: 'approver', name: team.approver.role, person: team.approver.person, tasks: [], coordination })
  }
  return roles
}

function planTimesheet(plan: PlanIssue, tasks: TaskIssue[], pulls: PullRequest[], threadStartedAt: string | undefined,
  base: string, team: Team | undefined): PlanTimesheet {
  const built = buildTasks({ plan, tasks, pulls, threadStartedAt, base })
  return {
    number: plan.number,
    url: `${base}/issues/${plan.number}`,
    title: plan.title,
    content: plan.body,
    roles: rolesOf(tasks, built, team, plan, threadStartedAt),
  }
}

/** 拉取一个计划的分层工时；计划号不存在时返回 undefined。 */
export function collectPlan(source: TimesheetSource, planNumber: number): PlanTimesheet | undefined {
  const plan = planIssue(source.cli, source.repository, planNumber)
  if (!plan?.title) return undefined
  const issues = ghJsonPages(source.cli, `repos/${source.repository}/issues?state=all&per_page=100`)
  const tasks: TaskIssue[] = []
  const pulls: PullRequest[] = []
  for (const entry of issues) {
    const item = asObject(entry)
    const number = Number(item.number)
    if (item.pull_request) {
      pulls.push(asPull(item, number))
      continue
    }
    if (!asArray(item.labels).map(labelName).includes('task')) continue
    const body = asString(item.body)
    if (!declaresPlan(body, planNumber)) continue
    tasks.push({ number, title: asString(item.title), body,
      createdAt: asString(item.created_at), closedAt: asString(item.closed_at) || null })
  }
  const base = `https://github.com/${source.repository}`
  const starts = threadStartByPlan([plan], source.tickets, source.triggerOf)
  const threadStartedAt = source.planLinkOf(plan.number)?.at ?? starts.get(plan.number)
  return planTimesheet(plan, tasks, pulls, threadStartedAt, base, readTeam(source.cli, source.repository))
}

/** 拉取仓库里所有计划的分层工时。 */
export function collectAllPlans(source: TimesheetSource): PlanTimesheet[] {
  const issues = ghJsonPages(source.cli, `repos/${source.repository}/issues?state=all&per_page=100`)
  const plans: PlanIssue[] = []
  const tasks: TaskIssue[] = []
  const pulls: PullRequest[] = []
  for (const entry of issues) {
    const item = asObject(entry)
    const number = Number(item.number)
    const labels = asArray(item.labels).map(labelName)
    if (item.pull_request) {
      pulls.push(asPull(item, number))
    } else if (labels.includes('plan')) {
      plans.push({ number, title: asString(item.title), body: asString(item.body),
        createdAt: asString(item.created_at), closedAt: asString(item.closed_at) || null })
    } else if (labels.includes('task')) {
      tasks.push({ number, title: asString(item.title), body: asString(item.body),
        createdAt: asString(item.created_at), closedAt: asString(item.closed_at) || null })
    }
  }
  const starts = threadStartByPlan(plans, source.tickets, source.triggerOf)
  const base = `https://github.com/${source.repository}`
  const team = readTeam(source.cli, source.repository)
  return plans
    .map(plan => planTimesheet(plan, tasks.filter(task => declaresPlan(task.body, plan.number)), pulls,
      source.planLinkOf(plan.number)?.at ?? starts.get(plan.number), base, team))
    .sort((a, b) => a.number - b.number)
}

/** 工单以 completed 结束时，找出刚刚关闭的计划 issue（±10 分钟窗口）。 */
export function findPlanForEnd(source: Pick<TimesheetSource, 'cli' | 'repository'>, endedAt: string): number | undefined {
  const issues = ghJsonPages(source.cli, `repos/${source.repository}/issues?state=closed&labels=plan&per_page=30`)
  const at = Date.parse(endedAt)
  const candidates = issues
    .map(entry => {
      const item = asObject(entry)
      const closed = Date.parse(asString(item.closed_at))
      return { number: Number(item.number), distance: Number.isFinite(closed) ? Math.abs(closed - at) : Number.POSITIVE_INFINITY }
    })
    .filter(item => item.number > 0 && item.distance <= 10 * 60_000)
    .sort((a, b) => a.distance - b.distance)
  return candidates[0]?.number
}

/** 把工时表作为评论贴到计划 issue；已有标记则跳过并返回 false。 */
export function postTimesheet(source: Pick<TimesheetSource, 'cli' | 'repository'>, plan: number, markdown: string): boolean {
  const comments = asArray(ghJson(source.cli, `repos/${source.repository}/issues/${plan}/comments?per_page=100`))
  if (comments.some(entry => asString(asObject(entry).body).includes(TIMESHEET_MARK))) return false
  run(source.cli, ['api', '-X', 'POST', `repos/${source.repository}/issues/${plan}/comments`, '-f', `body=${markdown}`])
  return true
}

export function timesheetMarkdown(plan: PlanTimesheet, project = ''): string {
  return renderMarkdown({ number: plan.number, title: plan.title, body: plan.content, createdAt: '', closedAt: null }, plan.roles, project)
}

