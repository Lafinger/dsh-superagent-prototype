/** 工时数据装配 v3：读计划/任务 issue、结果 PR 与话题起点，产出 B1–B4 行，并可回贴计划 issue。 */
import { execFileSync } from 'node:child_process'
import type { Ticket, Trigger } from '../core/index.ts'
import { buildRows, renderMarkdown, type PlanIssue, type PullRequest, type TaskIssue, type TimesheetRow } from '../sources/timesheet.ts'

/** 计划完成时回贴的评论标记，用于幂等。 */
export const TIMESHEET_MARK = '<!-- dsh-timesheet -->'

type Json = Record<string, unknown>

function run(cli: string, args: string[]): string {
  return execFileSync(cli, args, { encoding: 'utf8', maxBuffer: 32 << 20 })
}
function ghJson(cli: string, path: string): unknown { return JSON.parse(run(cli, ['api', path])) }
const asObject = (value: unknown): Json => (typeof value === 'object' && value !== null ? value as Json : {})
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
const labelName = (value: unknown): string => typeof value === 'string' ? value : asString(asObject(value).name)

export interface TimesheetSource {
  cli: string
  repository: string
  tickets: Ticket[]
  triggerOf: (id: string) => Trigger | undefined
}

/** 话题开始时刻：计划相关工单里最早的原始需求消息时间。 */
export function threadStartOf(tickets: Ticket[], triggerOf: (id: string) => Trigger | undefined): string | undefined {
  const times = tickets
    .map(ticket => ticket.origin?.triggerId)
    .filter((id): id is string => typeof id === 'string')
    .map(id => triggerOf(id)?.at)
    .filter((at): at is string => typeof at === 'string')
    .sort()
  return times[0]
}

function planIssue(cli: string, repository: string, number: number): PlanIssue {
  const item = asObject(ghJson(cli, `repos/${repository}/issues/${number}`))
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
  if (!plan.title) return undefined
  const issues = asArray(ghJson(source.cli, `repos/${source.repository}/issues?state=all&per_page=100`))
  const tasks: TaskIssue[] = []
  const pulls: PullRequest[] = []
  for (const entry of issues) {
    const item = asObject(entry)
    const number = Number(item.number)
    if (item.pull_request) {
      const pull = asObject(ghJson(source.cli, `repos/${source.repository}/pulls/${number}`))
      pulls.push({ number, title: asString(pull.title), body: asString(pull.body),
        createdAt: asString(pull.created_at), mergedAt: asString(pull.merged_at) || null })
    } else if (asArray(item.labels).map(labelName).includes('task')) {
      const body = asString(item.body)
      if (!new RegExp(`归属计划[：:]\\s*#${planNumber}\\b`).test(body)) continue
      tasks.push({ number, title: asString(item.title), body,
        createdAt: asString(item.created_at), closedAt: asString(item.closed_at) || null })
    }
  }
  const base = `https://github.com/${source.repository}`
  return { plan, rows: buildRows({ plan, tasks, pulls, threadStartedAt: threadStartOf(source.tickets, source.triggerOf), base }) }
}

/** 工单以 completed 结束时，找出刚刚关闭的计划 issue（±10 分钟窗口）。 */
export function findPlanForEnd(source: Pick<TimesheetSource, 'cli' | 'repository'>, endedAt: string): number | undefined {
  const issues = asArray(ghJson(source.cli, `repos/${source.repository}/issues?state=closed&labels=plan&per_page=30`))
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

export function timesheetMarkdown(plan: PlanIssue, rows: TimesheetRow[]): string { return renderMarkdown(plan, rows) }
/**
 * 每个计划的话题开始时刻。先按工单消息里出现的 `issues/<n>` 链接精确匹配；没有链接时，
 * 取"计划创建之前最近的工单"的原始消息时间作为话题起点（计划总是紧随其需求工单产生）。
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
  // 1) 显式链接优先
  for (const plan of plans) {
    const linked = origins
      .filter(origin => origin.texts.some(text => new RegExp(`/issues/${plan.number}\\b`).test(text)))
      .map(origin => origin.at)
      .sort()
    if (linked.length) starts.set(plan.number, linked[0]!)
  }
  // 2) 没有链接时，按时间就近：计划创建前最近的工单
  for (const plan of plans) {
    if (starts.has(plan.number)) continue
    const earlier = origins
      .filter(origin => !plan.createdAt || origin.at <= plan.createdAt)
      .sort((a, b) => a.at.localeCompare(b.at))
    const latest = earlier.at(-1)
    if (latest) starts.set(plan.number, latest.at)
  }
  return starts
}

/** 拉取仓库里所有计划的 B1–B4 行（按计划号、任务号排序）。 */
export function collectAllTimesheets(source: TimesheetSource): TimesheetRow[] {
  const issues = asArray(ghJson(source.cli, `repos/${source.repository}/issues?state=all&per_page=100`))
  const plans: PlanIssue[] = []
  const tasks: TaskIssue[] = []
  const pulls: PullRequest[] = []
  for (const entry of issues) {
    const item = asObject(entry)
    const number = Number(item.number)
    const labels = asArray(item.labels).map(labelName)
    if (item.pull_request) {
      const pull = asObject(ghJson(source.cli, `repos/${source.repository}/pulls/${number}`))
      pulls.push({ number, title: asString(pull.title), body: asString(pull.body),
        createdAt: asString(pull.created_at), mergedAt: asString(pull.merged_at) || null })
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
    const own = tasks.filter(task => new RegExp(`归属计划[：:]\\s*#${plan.number}\\b`).test(task.body))
    return buildRows({ plan, tasks: own, pulls, threadStartedAt: starts.get(plan.number), base })
  })
  return rows.sort((a, b) => a.plan - b.plan || a.task - b.task)
}




