/**
 * 工时聚合 + 项目控制面网关（容器内运行）。
 *
 *   GET    /                         项目页面（新建 / 状态 / 删除）
 *   GET    /healthz                  存活探针
 *   GET    /projects                 清单 + 容器状态
 *   POST   /projects                 新建项目（写目录、建卷、建容器、启动、配置、登记）
 *   GET    /projects/:id/status      容器状态
 *   DELETE /projects/:id             停并删容器（保留数据卷）
 *   GET    /timesheet?project=&plan= 转发该项目的 v2 工时响应
 *   GET    /timesheet/all            汇总全部项目
 *
 * 访问实例：dsh-shared 网络按别名，Host 改写为 127.0.0.1:<port>。
 * 创建容器：直连 /var/run/docker.sock 的 Docker API，不依赖 docker CLI。
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

// ---------- 项目清单 ----------
function projects() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG, 'utf8'))
    return (Array.isArray(raw.projects) ? raw.projects : [])
      .filter(item => item && item.id && item.host && Number.isInteger(Number(item.port)))
      .map(item => ({ id: String(item.id), name: String(item.name ?? item.id), host: String(item.host), port: Number(item.port) }))
  } catch { return [] }
}
function saveProjects(list) { writeFileSync(CONFIG, JSON.stringify({ projects: list }, null, 2)) }
const findProject = id => projects().find(project => project.id === id)

// ---------- Docker API ----------
function docker(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath: '/var/run/docker.sock', path, method, headers: body ? { 'content-type': 'application/json' } : {} },
      response => {
        let data = ''
        response.on('data', chunk => { data += chunk })
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            const error = new Error(`docker ${response.statusCode}: ${data.slice(0, 300)}`)
            error.status = response.statusCode
            return reject(error)
          }
          try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
        })
      },
    )
    request.on('error', reject)
    if (body) request.write(JSON.stringify(body))
    request.end()
  })
}

const containerName = id => `dsh-superagent-${id}-dsh-superagent-1`
const volumesOf = id => ({
  [`dsh-superagent-${id}_dsh-home`]: '/root/.dsh',
  [`dsh-superagent-${id}_superagent-state`]: '/root/.dsh/superagent-state',
  [`dsh-superagent-${id}_lark-config`]: '/root/.lark-cli-dsh-superagent',
  [`dsh-superagent-${id}_gh-config`]: '/root/.gh-agent',
})

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

function usedPorts() { return new Set(projects().map(project => project.port)) }

function allocatePort() {
  const taken = usedPorts()
  let port = BASE_PORT
  while (taken.has(port)) port += 1
  return port
}

// ---------- 实例设置 ----------
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
  } finally { clearTimeout(timer) }
}

async function apiCall(project, method, path, body) {
  const response = await fetch(`http://${project.host}:${project.port}${path}`, {
    method,
    headers: { Host: `127.0.0.1:${project.port}`, 'x-orchestrator-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} → ${response.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

async function readSettings(project) {
  const res = await call(project, '/orchestrator/api/settings')
  if (!res.ok) throw new Error(`读取设置失败：${res.status}`)
  return JSON.parse(res.text)
}

const sourceOf = (settings, id) => (settings.sources ?? []).find(item => item.id === id)

/** 新实例的四类设置：接收群、仓库观察、准入名单；逐项容错。 */
async function applySettings(project, spec) {
  const settings = await readSettings(project)
  const result = {}
  const feishu = sourceOf(settings, 'feishu')
  if (feishu) {
    const config = { ...(feishu.value?.config ?? {}) }
    // 新实例的来源 cli 需要显式给出，否则面板报 agentCliUnset / cli 未设置
    if (!config.cli) config.cli = '/root/.local/bin/lark-bot'
    const chats = Array.isArray(config.chats) ? [...config.chats] : []
    for (const chat of spec.chats ?? []) if (!chats.some(item => item.chatId === chat.chatId)) chats.push(chat)
    config.chats = chats
    if (spec.directMessages !== undefined) config.directMessages = !!spec.directMessages
    if (spec.otherChats) config.otherChats = spec.otherChats
    try {
      result.feishu = await apiCall(project, 'PUT', '/orchestrator/api/settings/source:feishu',
        { value: { ...feishu.value, config }, revision: feishu.revision })
    } catch (error) { result.feishu = { error: String(error?.message ?? error) } }
  }
  const github = sourceOf(settings, 'github')
  if (github && spec.repository) {
    const config = { ...(github.value?.config ?? {}), repository: spec.repository, ...(spec.observe ?? {}) }
    if (!config.cli) config.cli = '/root/.local/bin/gh-agent'
    try {
      result.github = await apiCall(project, 'PUT', '/orchestrator/api/settings/source:github',
        { value: { ...github.value, config }, revision: github.revision })
    } catch (error) { result.github = { error: String(error?.message ?? error) } }
  }
  const policy = settings.blocks?.policy
  if (policy && (spec.feishuAllowed?.length || spec.githubAllowed?.length)) {
    const value = { ...(policy.value ?? {}) }
    const sources = { ...(value.sources ?? {}) }
    if (spec.feishuAllowed?.length) {
      const current = { ...(sources.feishu ?? {}) }
      const allowed = [...(current.allowed ?? [])]
      for (const user of spec.feishuAllowed) if (!allowed.some(item => item.id === user.id)) allowed.push(user)
      sources.feishu = { ...current, allowed }
    }
    if (spec.githubAllowed?.length) {
      const current = { ...(sources.github ?? {}) }
      const allowed = [...(current.allowed ?? [])]
      for (const login of spec.githubAllowed) if (!allowed.some(item => item.id === login)) allowed.push({ id: login })
      sources.github = { ...current, allowed }
    }
    value.sources = sources
    try {
      result.policy = await apiCall(project, 'PUT', '/orchestrator/api/settings/policy', { value, revision: policy.revision })
    } catch (error) { result.policy = { error: String(error?.message ?? error) } }
  }
  return result
}

/** 目标仓库是否有 settings/team.yml：没有就无法排计划。 */
async function checkTeamFile(repository, token) {
  if (!token) return { present: null, error: 'GH_TOKEN 为空，无法检查 team.yml' }
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/contents/settings/team.yml`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    })
    return { present: response.ok, status: response.status }
  } catch (error) { return { present: null, error: String(error?.message ?? error) } }
}

function normalizeUsers(input) {
  return (Array.isArray(input) ? input : [])
    .map(item => typeof item === 'string'
      ? { id: item }
      : { id: String(item?.id ?? ''), ...(item?.name ? { name: String(item.name) } : {}) })
    .filter(item => item.id)
}

// ---------- GitHub 仓库协作 ----------
async function githubApi(path, method, body, token) {
  if (!token) throw new Error('GH_TOKEN 为空')
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-gateway' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw Object.assign(new Error(`github ${response.status}: ${text.slice(0, 200)}`), { status: response.status })
  return text ? JSON.parse(text) : {}
}

/** 从仓库的 settings/team.yml 读每个岗位的 github 账号（工人用它推 PR）。 */
async function teamLogins(repository, token) {
  try {
    const file = await githubApi(`/repos/${repository}/contents/settings/team.yml`, 'GET', undefined, token)
    const text = Buffer.from(String(file.content ?? ''), 'base64').toString('utf8')
    return [...new Set(text.split(/\r?\n/).map(line => line.match(/^\s*github:\s*(\S+)/)?.[1]).filter(Boolean))]
  } catch { return [] }
}

/** 幂等添加协作者（默认 push 权限）。 */
async function ensureCollaborators(repository, logins, token, permission = 'push') {
  const results = []
  for (const login of logins) {
    try {
      await githubApi(`/repos/${repository}/collaborators/${encodeURIComponent(login)}`, 'PUT', { permission }, token)
      results.push({ login, ok: true, permission })
    } catch (error) {
      results.push({ login, ok: false, error: String(error?.message ?? error) })
    }
  }
  return results
}

// ---------- GitHub 仓库创建与 team.yml ----------
let cachedLogin
async function tokenLogin(token) {
  if (cachedLogin) return cachedLogin
  const user = await githubApi('/user', 'GET', undefined, token)
  cachedLogin = String(user.login ?? '')
  return cachedLogin
}

/** 仓库不存在就建（默认私有 + 初始化 README）；已存在则复用。 */
async function ensureRepository(full, options, token) {
  try {
    await githubApi(`/repos/${full}`, 'GET', undefined, token)
    return { full, created: false }
  } catch (error) {
    if (error?.status !== 404) throw error
  }
  const [owner, name] = full.split('/')
  const me = await tokenLogin(token)
  const mine = owner.toLowerCase() === me.toLowerCase()
  const body = { name, private: options.private !== false, auto_init: true }
  const created = mine
    ? await githubApi('/user/repos', 'POST', body, token)
    : await githubApi(`/orgs/${owner}/repos`, 'POST', body, token)
  return { full: created.full_name ?? full, created: true }
}

/** 新建仓库后写入 settings/team.yml：approver + 两个岗位，岗位 github 复用 collaborators。 */
async function writeTeamFile(repository, spec, token) {
  const [first, second = first] = spec.collaborators
  const yaml = [
    '# 由 dsh 网关在创建项目时生成。approver 对接客户，roles 按 order 顺序交付。',
    'approver:',
    `  name: ${spec.approverName}`,
    `  feishu_open_id: ${spec.approverOpenId}`,
    `  feishu_name: ${spec.approverName}`,
    `  github: ${first}`,
    '',
    'roles:',
    '  - key: design',
    '    name: 设计岗',
    '    order: 1',
    '    feishu_open_id: ',
    '    feishu_name: 设计岗',
    `    github: ${first}`,
    '    deliverable_dir: design/',
    '',
    '  - key: implement',
    '    name: 实施岗',
    '    order: 2',
    '    feishu_open_id: ',
    '    feishu_name: 实施岗',
    `    github: ${second}`,
    '    deliverable_dir: app/',
    '',
  ].join('\n')
  return githubApi(`/repos/${repository}/contents/settings/team.yml`, 'PUT', {
    message: 'chore: add team.yml for the dsh project',
    content: Buffer.from(yaml, 'utf8').toString('base64'),
  }, token)
}

// ---------- 创建 / 删除 ----------
async function createProject(input) {
  const id = String(input.name ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw Object.assign(new Error('项目名只能用小写字母、数字和连字符'), { status: 400 })
  if (findProject(id)) throw Object.assign(new Error(`项目已存在：${id}`), { status: 409 })
  const owner = String(input.owner ?? 'lafinger-agent').trim()
  const repoName = String(input.repoName ?? `dsh-${id}`).trim()
  const repository = String(input.repository ?? `${owner}/${repoName}`).trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Object.assign(new Error('repository 需要 owner/repo 形式'), { status: 400 })
  const collaborators = normalizeUsers(input.collaborators).map(user => user.id)
  if (!collaborators.length) throw Object.assign(new Error('collaborators 至少填一个（工人用各自账号推 PR）'), { status: 400 })
  const appId = String(input.appId ?? '').trim()
  const appSecret = String(input.appSecret ?? '').trim()
  if (!appId || !appSecret) throw Object.assign(new Error('需要飞书 App ID 与 App Secret'), { status: 400 })

  const port = Number.isInteger(Number(input.port)) && Number(input.port) > 0 ? Number(input.port) : allocatePort()
  if (usedPorts().has(port)) throw Object.assign(new Error(`端口 ${port} 已被占用`), { status: 409 })

  const image = String(input.image ?? DEFAULT_IMAGE)
  const defaults = readDefaults()
  const token = defaults.GH_TOKEN
  const repo = input.createRepo === false ? { full: repository, created: false } : await ensureRepository(repository, {}, token)
  if (repo.created) {
    await writeTeamFile(repo.full, {
      approverOpenId: String(input.approverOpenId ?? ''),
      approverName: String(input.approverName ?? '管理岗'),
      collaborators,
    }, token)
  }
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

  const dir = `${REPO_DIR}/dsh-superagent-${id}`
  mkdirSync(dir, { recursive: true })
  const template = `${REPO_DIR}/docker-compose.project.yml`
  if (existsSync(template)) copyFileSync(template, `${dir}/docker-compose.yml`)
  writeFileSync(`${dir}/.env`, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n')

  for (const name of Object.keys(volumesOf(id))) {
    await docker('/volumes/create', 'POST', { Name: name }).catch(() => undefined)
  }

  const created = await docker(`/containers/create?name=${encodeURIComponent(containerName(id))}`, 'POST', {
    Image: image,
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    HostConfig: {
      Binds: Object.entries(volumesOf(id)).map(([name, target]) => `${name}:${target}`),
      RestartPolicy: { Name: 'unless-stopped' },
      StopGracePeriod: 300 * 1000000000,
      NetworkMode: NETWORK,
    },
    NetworkingConfig: { EndpointsConfig: { [NETWORK]: { Aliases: [id] } } },
  })
  await docker(`/containers/${created.Id}/start`, 'POST')
  saveProjects([...projects(), { id, name: String(input.displayName ?? id), host: id, port }])

  const deadline = Date.now() + 5 * 60_000
  let state = {}
  while (Date.now() < deadline) {
    state = (await docker(`/containers/${containerName(id)}/json`)).State ?? {}
    const health = state.Health?.Status
    if (health === 'healthy' || (!health && state.Running) || health === 'unhealthy') break
    await new Promise(resolve => setTimeout(resolve, 3000))
  }

  const chatId = String(input.chatId ?? '').trim()
  const listen = input.listen === 'all' ? 'all' : 'mentions'
  let settings
  try {
    settings = await applySettings({ host: id, port }, {
      chats: chatId ? [{ chatId, listen }] : [],
      directMessages: input.directMessages,
      otherChats: input.otherChats,
      repository,
      observe: input.observe,
      feishuAllowed: normalizeUsers(input.feishuAllowed),
      githubAllowed: normalizeUsers(input.githubAllowed).map(user => user.id),
    })
  } catch (error) { settings = { error: String(error?.message ?? error) } }

  const team = await checkTeamFile(repository, defaults.GH_TOKEN)
  const collaboratorsResult = await ensureCollaborators(repository, collaborators, token, String(input.collaboratorPermission ?? 'push'))
  return { id, port, image, state: state?.Health?.Status ?? (state?.Running ? 'running' : 'unknown'), repo, settings, team, collaborators: collaboratorsResult }
}

async function deleteProject(id) {
  if (!findProject(id)) throw Object.assign(new Error(`未知项目：${id}`), { status: 404 })
  await docker(`/containers/${containerName(id)}/stop?t=10`, 'POST').catch(() => undefined)
  await docker(`/containers/${containerName(id)}?v=0`, 'DELETE').catch(() => undefined)
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
    return { id, port: project.port, running: false, health: null, error: String(error?.message ?? error) }
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
.ok{color:#0a7f3f}.bad{color:#b3261e}
form{background:#fff;border:1px solid #e5e5e5;padding:16px;margin-top:24px;max-width:720px}
label{display:block;margin:8px 0 4px;font-size:12px;color:#555}
input,select{width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}
button{margin-top:14px;padding:8px 14px;border:0;border-radius:4px;background:#2563eb;color:#fff;cursor:pointer}
button.danger{background:#b3261e;padding:2px 8px;font-size:12px;margin:0}
pre{background:#111;color:#ddd;padding:10px;overflow:auto;max-height:220px;font-size:12px}
</style></head><body>
<h1>项目实例</h1>
<table><thead><tr><th>项目</th><th>端口</th><th>状态</th><th>健康</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table>
<form id="create"><strong>新建项目</strong>
<label>项目名（小写字母/数字/连字符）</label><input name="name" required placeholder="kb2">
<label>显示名</label><input name="displayName" placeholder="知识库项目">
<label>仓库 owner（默认 lafinger-agent）</label><input name="owner" placeholder="lafinger-agent">
<label>仓库名（留空 = dsh-&lt;项目名&gt;）</label><input name="repoName" placeholder="dsh-kb2">
<label>协作者 GitHub 账号（逗号分隔，必填）</label><input name="collaborators" required placeholder="Lafinger,zhengze736">
<label>管理岗 open_id（写进 team.yml 的 approver）</label><input name="approverOpenId" placeholder="ou_xxxxxxxx">
<label>端口（留空自动分配）</label><input name="port" placeholder="3085">
<label>飞书 App ID</label><input name="appId" required>
<label>飞书 App Secret</label><input name="appSecret" required type="password">
<label>飞书项目群 ID（oc_ 开头，可留空）</label><input name="chatId" placeholder="oc_xxxxxxxx">
<label>群接收模式</label><select name="listen"><option value="mentions">仅 @ 机器人</option><option value="all">接收全部消息</option></select>
<label>准入飞书用户 open_id（逗号分隔，可留空）</label><input name="feishuAllowed" placeholder="ou_xxx,ou_yyy">
<label>准入 GitHub 账号（逗号分隔，可留空）</label><input name="githubAllowed" placeholder="Lafinger,zhengze736">
<button type="submit">创建并启动</button>
</form>
<pre id="out"></pre>
<script>
const rows = document.getElementById('rows'), out = document.getElementById('out')
const log = text => { out.textContent = text }
async function refresh() {
  const list = await fetch('/projects').then(r => r.json())
  rows.innerHTML = list.map(p => \`<tr><td>\${p.id}</td><td>\${p.port}</td>
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
  const body = Object.fromEntries([...new FormData(event.target)].filter(([, v]) => v !== ''))
  for (const key of ['feishuAllowed', 'githubAllowed', 'collaborators']) {
    if (body[key]) body[key] = body[key].split(',').map(s => s.trim()).filter(Boolean)
  }
  log('创建中…（启动 + 配置约 1–2 分钟）')
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
      const list = await Promise.all(projects().map(async project => ({ ...project, status: await statusOf(project.id) })))
      return json(res, 200, list)
    }
    if (url.pathname === '/projects' && req.method === 'POST') {
      return json(res, 201, await createProject(await readBody(req)))
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
    if (url.pathname === '/repos/collaborators' && req.method === 'POST') {
      const body = await readBody(req)
      const repository = String(body.repository ?? '')
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) return json(res, 400, { error: 'repository 需要 owner/repo 形式' })
      const logins = normalizeUsers(body.logins).map(user => user.id)
      const token = readDefaults().GH_TOKEN
      return json(res, 200, { repository, results: await ensureCollaborators(repository, logins, token, String(body.permission ?? 'push')) })
    }
    return json(res, 404, { error: 'not found' })
  } catch (error) {
    return json(res, error?.status ?? 500, { error: String(error?.message ?? error) })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.error(`[timesheet-gateway] listening 0.0.0.0:${PORT}, projects=${projects().map(p => p.id).join(',') || '(none)'}`)
})

