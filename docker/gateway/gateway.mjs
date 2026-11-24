/**
 * 工时聚合网关（容器内运行，不发布宿主端口）。
 *
 * 它在 dsh-shared 网络上按别名访问各项目实例（实例内的 panel-forward 把
 * 网卡 IP:端口 转发到 127.0.0.1:端口），并把 Host 改写成 127.0.0.1:<port>，
 * 使实例的 sameOrigin 校验直接通过，无需修改任何实例配置。
 *
 * 路由：
 *   GET /healthz                       → { ok: true }
 *   GET /projects                      → [{ id, name, host, port, ok }]
 *   GET /timesheet?project=<id>&plan=N → 原样转发该项目的 v2 响应
 *   GET /timesheet/all                 → { projects: [{ id, name, plans }], errors: [...] }
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const CONFIG = new URL('./projects.json', import.meta.url)
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 15000)
const PORT = Number(process.env.GATEWAY_PORT || 3090)

function loadProjects() {
  const raw = JSON.parse(readFileSync(CONFIG, 'utf8'))
  const list = Array.isArray(raw.projects) ? raw.projects : []
  return list.filter(item => item && item.id && item.host && Number.isInteger(Number(item.port)))
    .map(item => ({ id: String(item.id), name: String(item.name ?? item.id), host: String(item.host), port: Number(item.port) }))
}

const projects = loadProjects()
const byId = new Map(projects.map(project => [project.id, project]))

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function call(project, path, query = '') {
  const url = `http://${project.host}:${project.port}${path}${query}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Host: `127.0.0.1:${project.port}`, 'x-orchestrator-request': '1' },
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text }
  } catch (error) {
    return { ok: false, status: 502, text: JSON.stringify({ error: String(error?.message ?? error) }) }
  } finally {
    clearTimeout(timer)
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://gateway')
  if (url.pathname === '/healthz') return send(res, 200, { ok: true, projects: projects.length })
  if (url.pathname === '/projects') {
    const rows = await Promise.all(projects.map(async project => {
      const probe = await call(project, '/orchestrator/api/state')
      return { ...project, ok: probe.ok }
    }))
    return send(res, 200, rows)
  }
  if (url.pathname === '/timesheet') {
    const id = url.searchParams.get('project') ?? ''
    const project = byId.get(id)
    if (!project) return send(res, 404, { error: `unknown project: ${id}` })
    const plan = url.searchParams.get('plan')
    const probe = await call(project, '/orchestrator/api/timesheet', plan ? `?plan=${encodeURIComponent(plan)}` : '')
    res.writeHead(probe.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(probe.text)
  }
  if (url.pathname === '/timesheet/all') {
    const rows = []
    const errors = []
    await Promise.all(projects.map(async project => {
      const probe = await call(project, '/orchestrator/api/timesheet')
      if (!probe.ok) {
        errors.push({ id: project.id, status: probe.status, error: probe.text.slice(0, 500) })
        return
      }
      try {
        const body = JSON.parse(probe.text)
        rows.push({ id: project.id, name: project.name, plans: body.plans ?? [] })
      } catch (error) {
        errors.push({ id: project.id, status: 500, error: String(error?.message ?? error) })
      }
    }))
    return send(res, 200, { projects: rows.sort((a, b) => a.id.localeCompare(b.id)), errors })
  }
  return send(res, 404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.error(`[timesheet-gateway] listening 0.0.0.0:${PORT}, projects=${projects.map(p => p.id).join(',') || '(none)'}`)
})
