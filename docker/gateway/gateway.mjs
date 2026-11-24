/**
 * 工时聚合 + 项目控制面网关（容器内运行）。
 *
 * 能力：
 *   GET  /                     项目列表页面（新建 / 查看状态 / 删除）
 *   GET  /healthz              存活探针
 *   GET  /projects             项目清单 + 容器状态
 *   POST /projects             新建项目（写目录、建卷、建容器、启动、等健康、登记）
 *   GET  /projects/:id/status  容器状态与健康
 *   DELETE /projects/:id       停止并删除容器（保留数据卷）
 *   GET  /timesheet?project=&plan=   转发该项目的 v2 工时响应
 *   GET  /timesheet/all        汇总全部项目
 *
 * 访问实例的方式：dsh-shared 网络按别名，Host 改写为 127.0.0.1:<port>。
 * 创建容器的方式：直连 /var/run/docker.sock 的 Docker API（不依赖 docker CLI，避免拉镜像）。
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import http from 'node:http'

const PORT = Number(process.env.GATEWAY_PORT || 3090)
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 15000)
const CONFIG = process.env.GATEWAY_PROJECTS || new URL('./projects.json', import.meta.url).pathname
const DEFAULTS = process.env.GATEWAY_DEFAULTS || new URL('./defaults.env', import.meta.url).pathname
const REPO_DIR = process.env.GATEWAY_REPO_DIR || '/workspace/docker'
const NETWORK = process.env.GATEWAY_NETWORK || 'dsh-shared'
const DEFAULT_IMAGE = process.env.GATEWAY_DEFAULT_IMAGE || 'dsh-superagent-project:8fb09223df0776e68b09edd0d044df61025d1efa'
const BASE_PORT = Number(process.env.GATEWAY_BASE_PORT || 3085)

// ---------- 项目清单（每次读取，支持运行期变更） ----------
function projects() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG, 'utf8'))
    const list = Array.isArray(raw.projects) ? raw.projects : []
    return list
      .filter(item => item && item.id && item.host && Number.isInteger(Number(item.port)))
      .map(item => ({ id: String(item.id), name: String(item.name ?? item.id), host: String(item.host), port: Number(item.port) }))
  } catch {
    return []
  }
}
function saveProjects(list) {
  writeFileSync(CONFIG, JSON.stringify({ projects: list }, null, 2))
}
function findProject(id) {
  return projects().find(project => project.id === id)
}

// ---------- Docker API ----------
function docker(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path, method, headers: body ? { 'content-type': 'application/json' } : {} },
      res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            const error = new Error(`docker ${res.statusCode}: ${data.slice(0, 300)}`)
            error.status = res.statusCode
            return reject(error)
          }
          try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
        })
      },
    )
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function containerName(id) { return `dsh-superagent-${id}-dsh-superagent-1` }
function volumes(id) {
  return {
    [`dsh-superagent-${id}_dsh-home`]: '/root/.dsh',
    [`dsh-superagent-${id}_superagent-state`]: '/root/.dsh/superagent-state',
    [`dsh-superagent-${id}_lark-config`]: '/root/.lark-cli-dsh-superagent',
    [`dsh-superagent-${id}_gh-config`]: '/root/.gh-agent',
  }
}

function readDefaults() {
  const env = {}
  if (!existsSync(DEFAULTS)) return env
  for (const line of readFileSync(DEFAULTS, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    env[line.slice(0, index).trim()] = line.slice(index + 1)
  }
  return env
}

function usedPorts() {
  const ports = new Set(projects().map(project => project.port))
  for (const item of containerList()) if (item.port) ports.add(item.port)
  return ports
}

/** 运行中的本项目容器（同名前缀），给状态与端口占用用。 */
function containerList() {
  // 同步快照：不查询 Docker，仅按清单推断；端口分配时再排除清单外的容器由调用方补。
  return projects().map(project => ({ id: project.id, port: project.port }))
}

async function allocatePort() {
  const taken = usedPorts()
  let port = BASE_PORT
  for (;;) {
    if (!taken.has(port)) {
      // 宿主端口不发布，这里只保证实例端口唯一即可
      return port
    }
    port += 1
  }
}

// ---------- 创建 / 删除 ----------
async function createProject(input) {
  const id = String(input.name ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw Object.assign(new Error('项目名只能用小写字母、数字和连字符'), { status: 400 })
  if (findProject(id)) throw Object.assign(new Error(`项目已存在：${id}`), { status: 409 })
  const repository = String(input.repository ?? '').trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Object.assign(new Error('repository 需要 owner/repo 形式'), { status: 400 })
  const appId = String(input.appId ?? '').trim()
  const appSecret = String(input.appSecret ?? '').trim()
  if (!appId || !appSecret) throw Object.assign(new Error('需要飞书 App ID 与 App Secret'), { status: 400 })

  const port = Number.isInteger(Number(input.port)) && Number(input.port) > 0 ? Number(input.port) : await allocatePort()
  if (usedPorts().has(port)) throw Object.assign(new Error(`端口 ${port} 已被占用`), { status: 409 })

  const image = String(input.image ?? DEFAULT_IMAGE)
  const defaults = readDefaults()
  const env = {
    ...defaults,
    DSH_HOME: '/root/.dsh',
    STATE_DIR: '/root/.dsh/superagent-state',
    LARKSUITE_CLI_CONFIG_DIR: '/root/.lark-cli-dsh-superagent',
    GH_CONFIG_DIR: '/root/.gh-agent',
    SUPERAGENT_PROFILE: id,
    SUPERAGENT_PORT: String(port),
    PROJECT_ALIAS: id,
    PROJECT_ID: repository,
    PROJECT_NAME: String(input.displayName ?? id),
    TZ: 'Asia/Shanghai',
    LARK_APP_ID: appId,
    LARK_APP_SECRET: appSecret,
    GITHUB_REPOSITORY: repository,
    GH_USER: String(input.ghUser ?? defaults.GH_USER ?? ''),
    DSH_ORCHESTRATOR_TRUSTED_HOSTS: `${id}:${port}`,
  }

  // 1) 写项目目录（便于以后用 compose 管理，也便于人工查看）
  const dir = `${REPO_DIR}/dsh-superagent-${id}`
  mkdirSync(dir, { recursive: true })
  const template = `${REPO_DIR}/docker-compose.project.yml`
  if (existsSync(template)) copyFileSync(template, `${dir}/docker-compose.yml`)
  writeFileSync(`${dir}/.env`, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n')

  // 2) 数据卷
  for (const name of Object.keys(volumes(id))) {
    await docker('/volumes/create', 'POST', { Name: name }).catch(() => undefined)
  }

  // 3) 容器
  const binds = Object.entries(volumes(id)).map(([name, target]) => `${name}:${target}`)
  const created = await docker(`/containers/create?name=${encodeURIComponent(containerName(id))}`, 'POST', {
    Image: image,
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    HostConfig: {
      Binds: binds,
      RestartPolicy: { Name: 'unless-stopped' },
      StopGracePeriod: 300 * 1_000_000_000,
      NetworkMode: NETWORK,
    },
    NetworkingConfig: { EndpointsConfig: { [NETWORK]: { Aliases: [id] } } },
  })
  await docker(`/containers/${created.Id}/start`, 'POST')
  saveProjects([...projects(), { id, name: String(input.displayName ?? id), host: id, port }])

  // 4) 等健康（最多 5 分钟）
  const deadline = Date.now() + 5 * 60_000
  let state
  while (Date.now() < deadline) {
    state = (await docker(`/containers/${containerName(id)}/json`)).State ?? {}
    const health = state.Health?.Status
    if (health === 'healthy' || (!health && state.Running)) break
    if (health === 'unhealthy') break
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  return { id, port, image, state: state?.Health?.Status ?? (state?.Running ? 'running' : 'unknown') }
}

async function deleteProject(id) {
  const project = findProject(id)
  if (!project) throw Object.assign(new Error(`未知项目：${id}`), { status: 404 })
  const name = containerName(id)
  await docker(`/containers/${name}/stop?t=10`, 'POST').catch(() => undefined)
  await docker(`/containers/${name}?v=0`, 'DELETE').catch(() => undefined)
  saveProjects(projects().filter(item => item.id !== id))
  return { id, removed: true, volumesKept: true }
}

async function statusOf(id) {
  const project = findProject(id)
  if (!project) throw Object.assign(new Error(`未知项目：${id}`), { status: 404 })
  try {
    const info = await docker(`/containers/${containerName(id)}/json`)
    return { id, port: project.port, running: !!info.State?.Running, health: info.State?.Health?.Status ?? null,
      startedAt: info.State?.StartedAt ?? null, image: info.Config?.Image ?? null }
  } catch (error) {
    return { id, port: project.port, running: false, health: null, error: String(error.message ?? error) }
  }
}

// ---------- 工时转发 ----------
async function call(project, path, query = '') {
  const url = `http://${project.host}:${project.port}${path}${query}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Host: `127.0.0.1:${project.port}`, 'x-orchestrator-request': '1' },
    })
    return { ok: response.ok, status: response.status, text: await response.text() }
  } catch (error) {
    return { ok: false, status: 502, text: JSON.stringify({ error: String(error?.message ?? error) }) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 页面 ----------
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>项目实例</title>
<style>
body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;color:#111;background:#fafafa}
h1{font-size:18px;margin:0 0 16px}
table{border-collapse:collapse;width:100%;background:#fff}
th,td{border:1px solid #e5e5e5;padding:8px;text-align:left;font-size:13px}
th{background:#f3f3f3;font-weight:600}
.ok{color:#0a7f3f}.bad{color:#b3261e}.warn{color:#a15c00}
form{background:#fff;border:1px solid #e5e5e5;padding:16px;margin-top:24px;max-width:720px}
label{display:block;margin:8px 0 4px;font-size:12px;color:#555}
input{width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}
button{margin-top:14px;padding:8px 14px;border:0;border-radius:4px;background:#2563eb;color:#fff;cursor:pointer}
button.danger{background:#b3261e;padding:2px 8px;font-size:12px;margin:0}
pre{background:#111;color:#ddd;padding:10px;overflow:auto;max-height:200px;font-size:12px}
</style></head><body>
<h1>项目实例</h1>
<table><thead><tr><th>项目</th><th>端口</th><th>状态</th><th>健康</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table>
<form id="create"><strong>新建项目</strong>
<label>项目名（小写字母/数字/连字符）</label><input name="name" required placeholder="kb2">
<label>显示名</label><input name="displayName" placeholder="知识库项目">
<label>GitHub 仓库（owner/repo）</label><input name="repository" required placeholder="lafinger-agent/kb2-demo">
<label>端口（留空自动分配）</label><input name="port" placeholder="3085">
<label>飞书 App ID</label><input name="appId" required>
<label>飞书 App Secret</label><input name="appSecret" required type="password">
<button type="submit">创建并启动</button>
</form>
<pre id="out"></pre>
<script>
const rows = document.getElementById('rows'), out = document.getElementById('out')
const log = text => { out.textContent = text }
async function refresh() {
  const projects = await fetch('/projects').then(r => r.json())
  rows.innerHTML = projects.map(p => \`<tr><td>\${p.id}</td><td>\${p.port}</td>
    <td class="\${p.status?.running ? 'ok' : 'bad'}">\${p.status?.running ? '运行中' : '未运行'}</td>
    <td>\${p.status?.health ?? '-'}</td>
    <td><button class="danger" data-id="\${p.id}">删除</button></td></tr>\`).join('')
  for (const button of rows.querySelectorAll('button')) {
    button.onclick = async () => {
      if (!confirm('删除容器？数据卷会保留')) return
      log(await fetch('/projects/' + button.dataset.id, { method: 'DELETE' }).then(r => r.text()))
      refresh()
    }
  }
}
document.getElementById('create').onsubmit = async event => {
  event.preventDefault()
  const form = new FormData(event.target)
  const body = Object.fromEntries([...form].filter(([, v]) => v !== ''))
  log('创建中…（构建/启动可能需要 1–5 分钟）')
  const response = await fetch('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  log(await response.text())
  refresh()
}
refresh(); setInterval(refresh, 15000)
</script></body></html>`

// ---------- 路由 ----------
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function readBody(req) {
  let data = ''
  for await (const chunk of req) data += chunk
  return data ? JSON.parse(data) : {}
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://gateway')
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(PAGE)
    }
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, projects: projects().length })
    if (url.pathname === '/projects' && req.method === 'GET') {
      const list = await Promise.all(projects().map(async project => {
        try { return { ...project, status: await statusOf(project.id) } }
        catch { return { ...project, status: { running: false } } }
      }))
      return json(res, 200, list)
    }
    if (url.pathname === '/projects' && req.method === 'POST') {
      const body = await readBody(req)
      return json(res, 201, await createProject(body))
    }
    const statusMatch = url.pathname.match(/^\/projects\/([\w-]+)\/status$/)
    if (statusMatch) return json(res, 200, await statusOf(statusMatch[1]))
    const deleteMatch = url.pathname.match(/^\/projects\/([\w-]+)$/)
    if (deleteMatch && req.method === 'DELETE') return json(res, 200, await deleteProject(deleteMatch[1]))
    if (url.pathname === '/timesheet') {
      const project = findProject(url.searchParams.get('project') ?? '')
      if (!project) return json(res, 404, { error: 'unknown project' })
      const plan = url.searchParams.get('plan')
      const probe = await call(project, '/orchestrator/api/timesheet', plan ? `?plan=${encodeURIComponent(plan)}` : '')
      res.writeHead(probe.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(probe.text)
    }
    if (url.pathname === '/timesheet/all') {
      const rows = []
      const errors = []
      await Promise.all(projects().map(async project => {
        const probe = await call(project, '/orchestrator/api/timesheet')
        if (!probe.ok) { errors.push({ id: project.id, status: probe.status, error: probe.text.slice(0, 300) }); return }
        try {
          const body = JSON.parse(probe.text)
          rows.push({ id: project.id, name: project.name, plans: body.plans ?? [] })
        } catch (error) { errors.push({ id: project.id, status: 500, error: String(error?.message ?? error) }) }
      }))
      return json(res, 200, { projects: rows.sort((a, b) => a.id.localeCompare(b.id)), errors })
    }
    return json(res, 404, { error: 'not found' })
  } catch (error) {
    return json(res, error?.status ?? 500, { error: String(error?.message ?? error) })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.error(`[timesheet-gateway] listening 0.0.0.0:${PORT}, projects=${projects().map(p => p.id).join(',') || '(none)'}`)
})
