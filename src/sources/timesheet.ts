/** 工时（交付时长）v3.1：四个时刻 + 三段差值；行内带计划/任务/PR 的链接与正文全文。 */

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

export interface TimesheetRow {
  plan: number
  plan_url: string
  plan_title: string
  plan_content: string
  task: number
  task_url: string
  task_title: string
  task_content: string
  /** PR 字段整组缺失表示该任务没有结果 PR。 */
  pull?: number
  pull_url?: string
  pull_title?: string
  pull_content?: string
  role: string
  person: string
  b1?: string
  b2?: string
  b3?: string
  b4?: string
  planning?: number
  response?: number
  closing?: number
  total?: number
  missing: string[]
}

const HOUR = 3_600_000

/** 两个时刻之间的自然小时数；任一缺失或为负返回 undefined。 */
export function hours(from?: string | null, to?: string | null): number | undefined {
  if (!from || !to) return undefined
  const delta = Date.parse(to) - Date.parse(from)
  return Number.isFinite(delta) && delta >= 0 ? delta / HOUR : undefined
}

/**
 * 任务正文声明归属计划的行。计划模板各版本分别写过「归属计划」与「所属计划」，
 * 两种都接受，否则该任务的工时行会静默消失（buildRows 只按任务出行）。
 */
const PLAN_LINK = /(?:归属|所属)计划[：:]\s*#(\d+)/

/** 任务正文是否声明属于该计划。 */
export function declaresPlan(body: string, plan: number): boolean {
  return new RegExp(`(?:归属|所属)计划[：:]\\s*#${plan}\\b`).test(body)
}

/** 从任务 issue 正文解析所属计划、角色、负责人。 */
export function parseTaskMeta(body: string): { plan?: number; role: string; person: string } {
  const plan = body.match(PLAN_LINK)?.[1]
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
    // PR 描述常写成「设计任务：#7」「关联任务: #7」，关键字与编号之间允许冒号或空格，
    // 否则只能靠 ±10 分钟的关闭时间兜底，容易把同一计划下别的任务的 PR 认领过来。
    return new RegExp(`(Closes|closes|Fixes|fixes|关联任务|对应任务|任务)\\s*[：:]?\\s*#${task.number}\\b`).test(text)
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
  /** 仓库网页根地址，例如 https://github.com/owner/name */
  base: string
}): TimesheetRow[] {
  const { plan, pulls, threadStartedAt, base } = input
  return input.tasks
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
        plan_url: `${base}/issues/${plan.number}`,
        plan_title: plan.title,
        plan_content: plan.body,
        task: task.number,
        task_url: `${base}/issues/${task.number}`,
        task_title: task.title,
        task_content: task.body,
        ...(pull
          ? { pull: pull.number, pull_url: `${base}/pull/${pull.number}`, pull_title: pull.title, pull_content: pull.body }
          : {}),
        role: meta.role || '—',
        person: meta.person || '—',
        ...(threadStartedAt ? { b1: threadStartedAt } : {}),
        ...(plan.createdAt ? { b2: plan.createdAt } : {}),
        ...(pull ? { b3: pull.createdAt } : {}),
        ...(plan.closedAt ? { b4: plan.closedAt } : {}),
        missing,
      }
      row.planning = hours(row.b1, row.b2)
      row.response = hours(row.b2, row.b3)
      row.closing = hours(row.b3, row.b4)
      row.total = hours(row.b1, row.b4)
      return row
    })
    .sort((a, b) => a.task - b.task)
}

const TIME = (iso?: string) => iso
  ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  : '—'
const SPAN = (row: TimesheetRow, key: string, value?: number) =>
  value === undefined ? (row.missing.includes(key) ? '缺失' : '—') : `${value.toFixed(1)}h`

/** 计划 issue 的评论正文；仅内部使用，不是接口格式。 */
export function renderMarkdown(plan: PlanIssue, rows: TimesheetRow[], project = ''): string {
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
    `## 工时（交付时长）：${project ? `${project} · ` : ''}${plan.title}`,
    '',
    line(header),
    line(header.map(() => '---')),
    ...body,
    '',
    '> B1 话题开始（原始需求消息）→ B2 计划创建 → B3 该任务首个结果 PR → B4 计划关闭。缺失的时刻标为「缺失」，不做推算。',
  ].join('\n')
}
/** 管理岗（审批人）的一次决策。 */
export interface CoordinationEvent {
  at: string
  kind: 'confirm' | 'approve' | 'rework' | 'stop'
  plan: number
  pull?: number
}

/**
 * 管理岗的协调与审核统计：复用 B1（需求开始）、B2（计划发布）、B4（计划完成），
 * 不套用任务行的交付时长；没有决策消息时整个对象为 null。
 */
export interface Coordination {
  plan: number
  role: string
  person: string
  requirement_start?: string
  plan_published?: string
  plan_completed?: string
  wait_confirm_hours?: number
  wait_close_hours?: number
  events: CoordinationEvent[]
}

