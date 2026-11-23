/** 工时（交付时长）v2：按 计划 → 角色 → 任务 分层；计划/任务/PR 正文各出现一次。 */

export interface TaskIssue {
  number: number
  title: string
  body: string
  createdAt: string
  closedAt?: string | null
}

export interface PlanIssue {
  number: number
  title: string
  body: string
  createdAt: string
  closedAt?: string | null
}

export interface PullRequest {
  number: number
  title: string
  body: string
  createdAt: string
  mergedAt?: string | null
}

/** 四个语义时刻；缺失的时刻不出现，代号记入 `missing`。 */
export interface TaskTimestamps {
  requirement_start?: string
  plan_published?: string
  submitted?: string
  plan_completed?: string
}

/** 相邻时刻相减，单位小时；无法计算时不出现。 */
export interface TaskDurations {
  planning?: number
  response?: number
  closing?: number
  total?: number
}

export interface TaskPull {
  number: number
  url: string
  title: string
  content: string
}

export interface TaskTimesheet {
  number: number
  url: string
  title: string
  content: string
  /** 没有结果 PR 时整个字段缺失。 */
  pull?: TaskPull
  timestamps: TaskTimestamps
  durations: TaskDurations
  missing: string[]
}

/** 管理岗只统计三个时刻与两段等待，不返回审阅事件。 */
export interface Coordination {
  timestamps: Pick<TaskTimestamps, 'requirement_start' | 'plan_published' | 'plan_completed'>
  durations: { confirm?: number; close?: number }
}

export interface RoleTimesheet {
  key: string
  name: string
  person: string
  /** 管理岗为空数组。 */
  tasks: TaskTimesheet[]
  /** 仅管理岗有。 */
  coordination?: Coordination
}

export interface PlanTimesheet {
  number: number
  url: string
  title: string
  content: string
  roles: RoleTimesheet[]
}

const HOUR = 3_600_000

/** 两个时刻之间的自然小时数；任一缺失或为负返回 undefined。 */
export function hours(from?: string | null, to?: string | null): number | undefined {
  if (!from || !to) return undefined
  const delta = Date.parse(to) - Date.parse(from)
  return Number.isFinite(delta) && delta >= 0 ? delta / HOUR : undefined
}

const PLAN_LINK = /(?:归属|所属)计划[：:]\s*#(\d+)/

/** 任务正文是否声明属于该计划。 */
export function declaresPlan(body: string, plan: number): boolean {
  const declared = body.match(PLAN_LINK)?.[1]
  return declared !== undefined && Number(declared) === plan
}

/** 从任务正文解析归属计划、角色、负责人与顺序。 */
export function parseTaskMeta(body: string): { plan?: number; role: string; person: string; order?: number } {
  const plan = body.match(PLAN_LINK)?.[1]
  const line = body.match(/\*\*角色\*\*[：:]\s*([^\n]+)/)?.[1] ?? ''
  const parts = line.split('·').map(part => part.trim())
  const order = parts.find(part => /^顺序\s*\d+$/.test(part))?.match(/\d+/)?.[0]
  const role = parts[0] ?? ''
  const person = parts.find(part => part && part !== role && !/^顺序/.test(part)) ?? ''
  return { ...(plan ? { plan: Number(plan) } : {}), role, person, ...(order ? { order: Number(order) } : {}) }
}

/** 结果 PR 与任务的关联：显式引用优先，其次按任务关闭时间就近匹配。 */
export function linkPull(task: TaskIssue, pulls: PullRequest[]): PullRequest | undefined {
  const explicit = pulls.find(pull => {
    const text = `${pull.title}\n${pull.body}`
    return new RegExp(`(Closes|closes|Fixes|fixes|关联任务|对应任务|任务)\\s*#${task.number}\\b`).test(text)
  })
  if (explicit || !task.closedAt) return explicit
  const closed = Date.parse(task.closedAt)
  return pulls
    .filter(pull => pull.mergedAt && Math.abs(Date.parse(pull.mergedAt) - closed) < 10 * 60_000)
    .sort((a, b) => Math.abs(Date.parse(a.mergedAt!) - closed) - Math.abs(Date.parse(b.mergedAt!) - closed))[0]
}

/** 为一个计划里的每个任务算出时刻、时长与缺失项。 */
export function buildTasks(input: {
  plan: PlanIssue
  tasks: TaskIssue[]
  pulls: PullRequest[]
  threadStartedAt?: string
  base: string
}): TaskTimesheet[] {
  const { plan, pulls, threadStartedAt, base } = input
  return input.tasks
    .map(task => {
      const pull = linkPull(task, pulls)
      const timestamps: TaskTimestamps = {}
      const missing: string[] = []
      if (threadStartedAt) timestamps.requirement_start = threadStartedAt
      else missing.push('requirement_start')
      if (plan.createdAt) timestamps.plan_published = plan.createdAt
      else missing.push('plan_published')
      if (pull) timestamps.submitted = pull.createdAt
      else missing.push('submitted')
      if (plan.closedAt) timestamps.plan_completed = plan.closedAt
      else missing.push('plan_completed')
      const durations: TaskDurations = {}
      const planning = hours(timestamps.requirement_start, timestamps.plan_published)
      const response = hours(timestamps.plan_published, timestamps.submitted)
      const closing = hours(timestamps.submitted, timestamps.plan_completed)
      const total = hours(timestamps.requirement_start, timestamps.plan_completed)
      if (planning !== undefined) durations.planning = planning
      if (response !== undefined) durations.response = response
      if (closing !== undefined) durations.closing = closing
      if (total !== undefined) durations.total = total
      return {
        number: task.number,
        url: `${base}/issues/${task.number}`,
        title: task.title,
        content: task.body,
        ...(pull ? { pull: { number: pull.number, url: `${base}/pull/${pull.number}`, title: pull.title, content: pull.body } } : {}),
        timestamps,
        durations,
        missing,
      } satisfies TaskTimesheet
    })
    .sort((a, b) => a.number - b.number)
}

const TIME = (iso?: string) => iso
  ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  : '—'

/** 计划 issue 的评论正文；仅内部使用，不是接口格式。 */
export function renderMarkdown(plan: PlanIssue, roles: RoleTimesheet[], project = ''): string {
  const header = ['任务', '岗位', '负责人', '需求开始', '计划发布', '首次提交', '计划完成',
    '规划期', '响应期', '收尾期', '全周期']
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const needs = { planning: 'requirement_start', response: 'submitted', closing: 'plan_completed', total: 'plan_completed' } as const
  const span = (task: TaskTimesheet, key: keyof TaskDurations) => {
    const value = task.durations[key]
    return value === undefined ? (task.missing.includes(needs[key]) ? '缺失' : '—') : `${value.toFixed(1)}h`
  }
  const body = roles.flatMap(role => role.tasks.map(task => line([
    `#${task.number}`,
    role.name,
    role.person,
    TIME(task.timestamps.requirement_start),
    TIME(task.timestamps.plan_published),
    TIME(task.timestamps.submitted),
    TIME(task.timestamps.plan_completed),
    span(task, 'planning'),
    span(task, 'response'),
    span(task, 'closing'),
    span(task, 'total'),
  ])))
  return [
    '<!-- dsh-timesheet -->',
    `## 工时（交付时长）：${project || plan.title}`,
    '',
    line(header),
    line(header.map(() => '---')),
    ...body,
    '',
    '> 需求开始 → 计划发布 → 首次提交 → 计划完成；缺失的时刻标为「缺失」，不做推算。',
  ].join('\n')
}
