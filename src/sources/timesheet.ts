/** 工时（交付时长）v3：只记录四个时刻（B1–B4）与三段相邻差值，不做汇总、趋势或瓶颈。 */

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

export interface TimesheetRow {
  plan: number
  task: number
  title: string
  role: string
  person: string
  /** B1 话题开始（原始需求消息时间）*/
  b1?: string
  /** B2 正式发布（计划 issue 创建）*/
  b2?: string
  /** B3 首次提交（该任务第一个结果 PR）*/
  b3?: string
  /** B4 计划完成（计划 issue 关闭）*/
  b4?: string
  planning?: number
  response?: number
  closing?: number
  total?: number
  pull?: number
  missing: string[]
}

const HOUR = 3_600_000

/** 两个时刻之间的自然小时数；任一缺失或为负返回 undefined。 */
export function hours(from?: string | null, to?: string | null): number | undefined {
  if (!from || !to) return undefined
  const delta = Date.parse(to) - Date.parse(from)
  return Number.isFinite(delta) && delta >= 0 ? delta / HOUR : undefined
}

/** 从任务 issue 正文解析归属计划、角色、负责人。 */
export function parseTaskMeta(body: string): { plan?: number; role: string; person: string } {
  const plan = body.match(/归属计划[：:]\s*#(\d+)/)?.[1]
  const line = body.match(/\*\*角色\*\*[：:]\s*([^\n]+)/)?.[1] ?? ''
  const parts = line.split('·').map(part => part.trim())
  const role = parts[0] ?? ''
  const person = parts.find(part => part && part !== role && !/^顺序/.test(part)) ?? ''
  return { ...(plan ? { plan: Number(plan) } : {}), role, person }
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

/** 逐任务计算 B1–B4 与三段差值；缺失时刻留空并记入 missing。 */
export function buildRows(input: {
  plan: PlanIssue
  tasks: TaskIssue[]
  pulls: PullRequest[]
  /** 话题开始时刻：该计划对应工单的原始需求消息时间。 */
  threadStartedAt?: string
}): TimesheetRow[] {
  const { plan, pulls, threadStartedAt } = input
  const rows = input.tasks
    .map(task => {
      const meta = parseTaskMeta(task.body)
      const pull = linkPull(task, pulls)
      const missing: string[] = []
      if (!threadStartedAt) missing.push('b1')
      if (!plan.createdAt) missing.push('b2')
      if (!pull) missing.push('b3')
      if (!plan.closedAt) missing.push('b4')
      const row: TimesheetRow = {
        plan: meta.plan ?? plan.number,
        task: task.number,
        title: task.title,
        role: meta.role || '—',
        person: meta.person || '—',
        ...(threadStartedAt ? { b1: threadStartedAt } : {}),
        ...(plan.createdAt ? { b2: plan.createdAt } : {}),
        ...(pull ? { b3: pull.createdAt } : {}),
        ...(plan.closedAt ? { b4: plan.closedAt } : {}),
        ...(pull ? { pull: pull.number } : {}),
        missing,
      }
      row.planning = hours(row.b1, row.b2)
      row.response = hours(row.b2, row.b3)
      row.closing = hours(row.b3, row.b4)
      row.total = hours(row.b1, row.b4)
      return row
    })
    .sort((a, b) => a.task - b.task)
  return rows
}

const TIME = (iso?: string) => iso
  ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  : '—'
const SPAN = (row: TimesheetRow, key: string, value?: number) =>
  value === undefined ? (row.missing.includes(key) ? '缺失' : '—') : `${value.toFixed(1)}h`

/** Markdown 表：一任务一行，带幂等标记。 */
export function renderMarkdown(plan: PlanIssue, rows: TimesheetRow[]): string {
  const header = ['计划', '任务', '岗位', '负责人', 'B1 话题开始', 'B2 正式发布', 'B3 首次提交', 'B4 计划完成',
    '规划期 B2−B1', '响应期 B3−B2', '收尾期 B4−B3', '全周期 B4−B1']
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const body = rows.map(row => line([
    `#${plan.number}`,
    `#${row.task}`,
    row.role,
    row.person,
    TIME(row.b1),
    TIME(row.b2),
    TIME(row.b3),
    TIME(row.b4),
    SPAN(row, 'b2', row.planning),
    SPAN(row, 'b3', row.response),
    SPAN(row, 'b4', row.closing),
    SPAN(row, 'b4', row.total),
  ]))
  return [
    '<!-- dsh-timesheet -->',
    `## 工时（交付时长）：${plan.title}`,
    '',
    line(header),
    line(header.map(() => '---')),
    ...body,
    '',
    '> B1 话题开始（原始需求消息）→ B2 计划创建 → B3 该任务首个结果 PR → B4 计划关闭。缺失的时刻标为「缺失」，不做推算。',
  ].join('\n')
}

/** CSV：字段与 Markdown 一致。 */
export function renderCsv(rows: TimesheetRow[]): string {
  const header = ['plan', 'task', 'role', 'person', 'title', 'b1', 'b2', 'b3', 'b4',
    'planningHours', 'responseHours', 'closingHours', 'totalHours', 'pull', 'missing']
  const cell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const number = (value?: number) => value === undefined ? '' : value.toFixed(2)
  return [header.join(','), ...rows.map(row => [
    row.plan, row.task, row.role, row.person, row.title,
    row.b1 ?? '', row.b2 ?? '', row.b3 ?? '', row.b4 ?? '',
    number(row.planning), number(row.response), number(row.closing), number(row.total),
    row.pull ?? '', row.missing.join('+'),
  ].map(cell).join(','))].join('\n')
}
