/** 工时数据装配 v3：读计划/任务 issue、结果 PR 与话题起点，产出 B1–B4 行，并可回贴计划 issue。 */
import { execFileSync } from 'node:child_process'
import type { Ticket, Trigger } from '../core/index.ts'
import { buildRows, declaresPlan, renderMarkdown, type PlanIssue, type PullRequest, type TaskIssue, type TimesheetRow } from '../sources/timesheet.ts'

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

/** 拉取一个计划的 B1–B4 行；计划号不存在时返回 undefined。 */
export function collectTimesheet(source: TimesheetSource, planNumber: number): { plan: PlanIssue; rows: TimesheetRow[] } | undefined {
  const plan = planIssue(source.cli, source.repository, planNumber)
  if (!plan?.title) return undefined
  const issues = ghJsonPages(source.cli, `repos/${source.repository}/issues?state=all&per_page=100`)
  const tasks: TaskIssue[] = []
  const pulls: PullRequest[] = []
  for (const entry of issues) {
    const item = asObject(entry)
    const number = Number(item.number)
    if (item.pull_request) {
      // The issues list already carries the PR body and `pull_request.merged_at`, so no per-PR request is needed.
      pulls.push(asPull(item, number))
    } else if (asArray(item.labels).map(labelName).includes('task')) {
      const body = asString(item.body)
      if (!declaresPlan(body, planNumber)) continue
      tasks.push({ number, title: asString(item.title), body,
        createdAt: asString(item.created_at), closedAt: asString(item.closed_at) || null })
    }
  }
  const base = `https://github.com/${source.repository}`
  const starts = threadStartByPlan([plan], source.tickets, source.triggerOf)
  const threadStartedAt = source.planLinkOf(plan.number)?.at ?? starts.get(plan.number)
  return { plan, rows: buildRows({ plan, tasks, pulls, threadStartedAt, base }) }
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
  const comments = ghJsonPages(source.cli, `repos/${source.repository}/issues/${plan}/comments?per_page=100`)
  if (comments.some(entry => asString(asObject(entry).body).includes(TIMESHEET_MARK))) return false
  run(source.cli, ['api', '-X', 'POST', `repos/${source.repository}/issues/${plan}/comments`, '-f', `body=${markdown}`])
  return true
}

export function timesheetMarkdown(plan: PlanIssue, rows: TimesheetRow[]): string { return renderMarkdown(plan, rows) }
/**
 * 每个计划的话题开始时刻：只认工单消息里出现的 `issues/<n>` 链接，取最早的一条。
 * 没有链接就留空——B1 会进入 `missing`，不做任何推断。
 */
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

/** 拉取仓库里所有计划的 B1–B4 行（按计划号、任务号排序）。 */
export function collectAllTimesheets(source: TimesheetSource): TimesheetRow[] {
  const issues = ghJsonPages(source.cli, `repos/${source.repository}/issues?state=all&per_page=100`)
  const plans: PlanIssue[] = []
  const tasks: TaskIssue[] = []
  const pulls: PullRequest[] = []
  for (const entry of issues) {
    const item = asObject(entry)
    const number = Number(item.number)
    const labels = asArray(item.labels).map(labelName)
    if (item.pull_request) {
      // The issues list already carries the PR body and `pull_request.merged_at`, so no per-PR request is needed.
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
  const rows = plans.flatMap(plan => {
    const own = tasks.filter(task => declaresPlan(task.body, plan.number))
    const threadStartedAt = source.planLinkOf(plan.number)?.at ?? starts.get(plan.number)
    return buildRows({ plan, tasks: own, pulls, threadStartedAt, base })
  })
  return rows.sort((a, b) => a.plan - b.plan || a.task - b.task)
}






