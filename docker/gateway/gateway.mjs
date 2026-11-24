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
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-gateway' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await response.text()
      if (!response.ok) throw Object.assign(new Error(`github ${response.status}: ${text.slice(0, 200)}`), { status: response.status })
      return text ? JSON.parse(text) : {}
    } catch (error) {
      lastError = error
      if (error?.status && error.status < 500) throw error
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  throw lastError
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
  let existing = new Set()
  try {
    const list = await githubApi(`/repos/${repository}/collaborators`, 'GET', undefined, token)
    existing = new Set((Array.isArray(list) ? list : []).map(item => String(item.login ?? '').toLowerCase()))
  } catch { /* 读不到就当作都不存在 */ }
  const results = []
  for (const login of logins) {
    const existed = existing.has(String(login).toLowerCase())
    try {
      await githubApi(`/repos/${repository}/collaborators/${encodeURIComponent(login)}`, 'PUT', { permission }, token)
      results.push({ login, ok: true, permission, existed })
    } catch (error) {
      results.push({ login, ok: false, existed, error: String(error?.message ?? error) })
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
/** 生成 settings/team.yml：approver + 任意数量岗位（面板可配）。 */
function teamYaml(spec) {
  const lines = [
    '# 由 dsh 网关在创建项目时生成。approver 对接客户；roles 按 order 顺序交付。',
    'approver:',
    `  name: ${spec.approver.name || '管理岗'}`,
    `  feishu_open_id: ${spec.approver.openId ?? ''}`,
    `  feishu_name: ${spec.approver.person ?? spec.approver.name}`,
    `  github: ${spec.approver.github ?? ''}`,
    '',
    'roles:',
  ]
  for (const role of spec.roles) {
    lines.push(
      `  - key: ${role.key}`,
      `    name: ${role.name}`,
      `    order: ${role.order}`,
      `    feishu_open_id: ${role.openId ?? ''}`,
      `    feishu_name: ${role.person ?? role.name}`,
      `    github: ${role.github ?? ''}`,
    )
    if (role.deliverableDir) lines.push(`    deliverable_dir: ${role.deliverableDir}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function writeTeamFile(repository, spec, token) {
  // 文件已存在时必须带 sha，否则 GitHub 返回 422。
  let sha
  try {
    const existing = await githubApi(`/repos/${repository}/contents/settings/team.yml`, 'GET', undefined, token)
    sha = existing.sha
  } catch { /* 不存在就新建 */ }
  return githubApi(`/repos/${repository}/contents/settings/team.yml`, 'PUT', {
    message: sha ? 'chore: update team.yml for the dsh project' : 'chore: add team.yml for the dsh project',
    content: Buffer.from(teamYaml(spec), 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  }, token)
}

// ---------- 飞书群成员 ----------
/** 用应用凭据读群成员，返回 [{openId, name}]；不需要 lark-cli。 */
async function feishuMembers(appId, appSecret, chatId) {
  if (!appId || !appSecret || !chatId) throw Object.assign(new Error('需要 App ID、App Secret 与群 ID'), { status: 400 })
  const tokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const tokenBody = await tokenResponse.json()
  if (tokenBody.code !== 0) throw Object.assign(new Error(`获取 token 失败：${tokenBody.msg ?? tokenBody.code}`), { status: 400 })
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=open_id&page_size=100`, {
    headers: { authorization: `Bearer ${tokenBody.tenant_access_token}` },
  })
  const body = await response.json()
  if (body.code !== 0) throw Object.assign(new Error(`读取群成员失败：${body.msg ?? body.code}`), { status: 400 })
  return (body.data?.items ?? []).map(item => ({ openId: item.member_id, name: item.name }))
}

/** 从请求里取团队规格；没给 team 时返回 undefined（调用方决定用默认值还是跳过）。 */
function teamSpecFrom(input, collaborators) {
  if (!input.team) return undefined
  const approver = {
    name: String(input.team?.approver?.name || input.approverName || '管理岗'),
    person: String(input.team.approver?.person ?? ''),
    openId: String(input.approverOpenId ?? input.team.approver?.openId ?? ''),
    github: String(input.team.approver?.github ?? collaborators[0] ?? ''),
  }
  const roles = (Array.isArray(input.team.roles) ? input.team.roles : []).map((role, index) => ({
    key: String(role.key ?? `role-${index + 1}`),
    person: String(role.person ?? ''),
    name: String(role.name ?? `岗位${index + 1}`),
    order: Number(role.order ?? index + 1),
    openId: String(role.openId ?? ''),
    github: String(role.github ?? collaborators[index] ?? collaborators[0] ?? ''),
    deliverableDir: String(role.deliverableDir ?? ''),
  }))
  if (!roles.length) return undefined
  if (new Set(roles.map(role => role.key)).size !== roles.length) throw Object.assign(new Error('岗位 key 不能重复'), { status: 400 })
  return { approver, roles }
}

function defaultTeamSpec(collaborators) {
  return {
    approver: { name: '管理岗', openId: '', github: collaborators[0] ?? '' },
    roles: [
      { key: 'design', name: '设计岗', order: 1, openId: '', github: collaborators[0] ?? '', deliverableDir: 'design/' },
      { key: 'implement', name: '实施岗', order: 2, openId: '', github: collaborators[1] ?? collaborators[0] ?? '', deliverableDir: 'app/' },
    ],
  }
}

/** 已存在项目的配置对齐：只写有变化的块，不碰容器与数据。 */
async function reconcileProject(project, spec) {
  const settings = await readSettings(project)
  const report = {}
  const feishu = sourceOf(settings, 'feishu')
  if (feishu) {
    const config = { ...(feishu.value?.config ?? {}) }
    if (!config.cli) config.cli = '/root/.local/bin/lark-bot'
    const chats = Array.isArray(config.chats) ? [...config.chats] : []
    for (const chat of spec.chats ?? []) if (!chats.some(item => item.chatId === chat.chatId)) chats.push(chat)
    config.chats = chats
    if (spec.directMessages !== undefined) config.directMessages = !!spec.directMessages
    if (spec.otherChats) config.otherChats = spec.otherChats
    const next = { ...feishu.value, config }
    if (JSON.stringify(next) === JSON.stringify(feishu.value)) report.feishu = { saved: false, changed: false }
    else report.feishu = { changed: true, ...(await apiCall(project, 'PUT', '/orchestrator/api/settings/source:feishu', { value: next, revision: feishu.revision })) }
  }
  const github = sourceOf(settings, 'github')
  if (github && spec.repository) {
    const config = { ...(github.value?.config ?? {}) }
    if (!config.cli) config.cli = '/root/.local/bin/gh-agent'
    config.repository = spec.repository
    if (spec.observe) Object.assign(config, spec.observe)
    const next = { ...github.value, config }
    if (JSON.stringify(next) === JSON.stringify(github.value)) report.github = { saved: false, changed: false }
    else report.github = { changed: true, ...(await apiCall(project, 'PUT', '/orchestrator/api/settings/source:github', { value: next, revision: github.revision })) }
  }
  const policy = settings.blocks?.policy
  if (policy && (spec.feishuAllowed?.length || spec.githubAllowed?.length)) {
    const value = JSON.parse(JSON.stringify(policy.value ?? {}))
    const sources = value.sources ?? {}
    if (spec.feishuAllowed?.length) {
      const current = sources.feishu ?? {}
      const allowed = spec.replace ? [] : [...(current.allowed ?? [])]
      for (const user of spec.feishuAllowed) if (!allowed.some(item => item.id === user.id)) allowed.push(user)
      sources.feishu = { ...current, allowed }
    }
    if (spec.githubAllowed?.length) {
      const current = sources.github ?? {}
      const allowed = spec.replace ? [] : [...(current.allowed ?? [])]
      for (const login of spec.githubAllowed) if (!allowed.some(item => item.id === login)) allowed.push({ id: login })
      sources.github = { ...current, allowed }
    }
    value.sources = sources
    if (JSON.stringify(value) === JSON.stringify(policy.value)) report.policy = { saved: false, changed: false }
    else report.policy = { changed: true, ...(await apiCall(project, 'PUT', '/orchestrator/api/settings/policy', { value, revision: policy.revision })) }
  }
  return report
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
  const teamSpec = teamSpecFrom(input, collaborators) ?? defaultTeamSpec(collaborators)
  if (repo.created) await writeTeamFile(repo.full, teamSpec, token)
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
      // 未显式给飞书准入时，用审批人与各岗位的 open_id 兜底
      feishuAllowed: normalizeUsers(input.feishuAllowed).length
        ? normalizeUsers(input.feishuAllowed)
        : [teamSpec.approver.openId, ...teamSpec.roles.map(role => role.openId)].filter(Boolean).map(id => ({ id })),
      githubAllowed: collaborators, // 与协作者合并为同一份名单：既能提需求，也能推 PR
    })
  } catch (error) { settings = { error: String(error?.message ?? error) } }

  const team = await checkTeamFile(repository, defaults.GH_TOKEN)
  const collaboratorsResult = await ensureCollaborators(repository, collaborators, token, String(input.collaboratorPermission ?? 'push'))
  return { id, port, image, state: state?.Health?.Status ?? (state?.Running ? 'running' : 'unknown'), repo, settings, team: { ...team, roles: teamSpec.roles.length }, collaborators: collaboratorsResult }
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
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>项目实例</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--line:#e3e5e8;--text:#16181d;--muted:#6b7280;--brand:#2563eb;--ok:#0a7f3f;--bad:#b3261e;--warn:#a15c00}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 64px}
header{margin-bottom:18px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:14px;margin:0}
.sub{color:var(--muted);font-size:12px;margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px}
.card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.muted{color:var(--muted);font-size:12px}
table.grid{width:100%;border-collapse:collapse}
table.grid th,table.grid td{border-bottom:1px solid var(--line);padding:9px 8px;text-align:left;font-size:13px}
table.grid th{color:var(--muted);font-weight:600;font-size:12px;background:#fafbfc}
table.grid tr:last-child td{border-bottom:0}
.right{text-align:right}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid transparent}
.badge.ok{color:var(--ok);background:#eaf6ef;border-color:#cbe8d6}
.badge.bad{color:var(--bad);background:#fdeceb;border-color:#f6cdc9}
.badge.warn{color:var(--warn);background:#fdf3e6;border-color:#f3dfc2}
label{display:block;font-size:12px;color:var(--muted);margin:0 0 4px}
input,select{width:100%;padding:7px 9px;border:1px solid #d3d6db;border-radius:6px;background:#fff;font:inherit;color:inherit}
input:focus,select:focus{outline:2px solid #c7d7fb;border-color:var(--brand)}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.span2{grid-column:1 / -1}
.row{display:flex;gap:8px;align-items:center}
.row input{flex:1}
fieldset{border:1px solid var(--line);border-radius:8px;margin:16px 0 0;padding:12px 14px 14px}
legend{font-size:12px;color:var(--muted);padding:0 6px}
.roles-wrap{overflow-x:auto}
table.roles{width:100%;border-collapse:collapse;min-width:760px}
table.roles th,table.roles td{padding:6px 4px;text-align:left;font-size:12px;color:var(--muted);font-weight:600}
table.roles td{color:var(--text);font-weight:400}
table.roles input,table.roles select{padding:5px 6px;font-size:12px}
button{padding:8px 14px;border:1px solid transparent;border-radius:7px;background:var(--brand);color:#fff;font:inherit;cursor:pointer}
button:hover{filter:brightness(.96)}
button.ghost{background:#fff;color:var(--text);border-color:#d3d6db}
button.danger{background:#fff;color:var(--bad);border-color:#f0c4c0;padding:3px 9px;font-size:12px}
.actions{display:flex;align-items:center;gap:12px;margin-top:16px}
pre{background:#0f172a;color:#e2e8f0;border-radius:8px;padding:12px;font-size:12px;line-height:1.5;overflow:auto;max-height:260px;margin:0;white-space:pre-wrap;word-break:break-word}
@media (max-width:820px){.grid2{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
<header><h1>项目实例</h1><p class="sub">一个项目 = 一个容器；创建时自动建仓库、写 team.yml、配飞书群与准入。</p></header>

<section class="card">
  <div class="card-head"><h2>项目</h2><span id="count" class="muted"></span></div>
  <table class="grid"><thead><tr><th>项目</th><th>端口</th><th>状态</th><th>健康</th><th class="right">操作</th></tr></thead><tbody id="rows"></tbody></table>
</section>

<section class="card">
  <div class="card-head"><h2>新建项目</h2><span class="muted">创建约 1–2 分钟</span></div>
  <form id="create">
    <div class="grid2">
      <div><label>项目名（小写字母/数字/连字符）</label><input name="name" required placeholder="kb2"></div>
      <div><label>显示名</label><input name="displayName" placeholder="知识库项目"></div>
      <div><label>仓库 owner</label><input name="owner" placeholder="lafinger-agent"></div>
      <div><label>仓库名（留空 = dsh-&lt;项目名&gt;）</label><input name="repoName" placeholder="dsh-kb2"></div>
      <div class="span2"><label>GitHub 账号（协作者 + 准入，逗号分隔，必填）</label><input name="collaborators" required placeholder="Lafinger,zhengze736"></div>
      <div><label>飞书 App ID</label><input name="appId" required></div>
      <div><label>飞书 App Secret</label><input name="appSecret" required type="password"></div>
      <div class="span2"><label>飞书项目群 ID</label>
        <div class="row"><input name="chatId" placeholder="oc_xxxxxxxx"><button type="button" class="ghost" id="loadMembers">读取群成员</button><span id="memberHint" class="muted"></span></div>
      </div>
    </div>

    <fieldset><legend>审批人（管理岗）</legend>
      <div class="grid2">
        <div><label>从群成员选择</label><select id="approverPick"><option value="">（手工填 open_id）</option></select></div>
        <div><label>open_id</label><input name="approverOpenId" placeholder="ou_xxxxxxxx"><input type="hidden" name="approverPerson"></div>
        <div><label>GitHub 账号</label><input name="approverGithub" placeholder="Lafinger"></div>
      </div>
    </fieldset>

    <fieldset><legend>岗位（team.yml 的 roles，按 order 顺序交付）</legend>
      <div class="roles-wrap">
        <table class="roles"><thead><tr><th>成员</th><th>Key</th><th>岗位名</th><th>顺序</th><th>open_id</th><th>GitHub</th><th>目录</th><th></th></tr></thead><tbody id="roles"></tbody></table>
      </div>
      <button type="button" class="ghost" id="addRole">+ 添加岗位</button>
    </fieldset>

    <div class="actions"><button type="submit">创建并启动</button><span class="muted">等容器 healthy 后返回结果</span></div>
  </form>
</section>

<section class="card"><div class="card-head"><h2>执行结果</h2></div><pre id="out"></pre></section>
</div>
<script>
var members = []
var roleBox = document.getElementById('roles')
function optionHtml(m) { return '<option value="' + m.openId + '">' + m.name + '</option>' }
function fillMemberSelects() {
  document.getElementById('approverPick').innerHTML = '<option value="">（手工填 open_id）</option>' + members.map(optionHtml).join('')
  var selects = roleBox.querySelectorAll('select')
  for (var i = 0; i < selects.length; i++) {
    var current = selects[i].value
    selects[i].innerHTML = '<option value="">（手工填）</option>' + members.map(optionHtml).join('')
    selects[i].value = current
  }
}
function addRole(values) {
  var row = document.createElement('tr')
  row.className = 'role'
  row.innerHTML = '<td><select class="roleMember"><option value="">（手工填）</option>' + members.map(optionHtml).join('') + '</select></td>' +
    '<td><input name="roleKey" placeholder="design"></td>' +
    '<td><input name="roleName" placeholder="设计岗"></td>' +
    '<td><input name="roleOrder" placeholder="1" style="width:56px"></td>' +
    '<td><input name="roleOpenId" placeholder="ou_…"><input type="hidden" name="rolePerson"></td>' +
    '<td><input name="roleGithub" placeholder="Lafinger"></td>' +
    '<td><input name="roleDir" placeholder="design/"></td>' +
    '<td><button type="button" class="danger">删除</button></td>'
  roleBox.appendChild(row)
  var pick = row.querySelector('.roleMember'), open = row.querySelector('[name=roleOpenId]'), person = row.querySelector('[name=rolePerson]')
  pick.onchange = function () {
    if (!pick.value) return
    open.value = pick.value
    person.value = pick.options[pick.selectedIndex].textContent
  }
  row.querySelector('button').onclick = function () { row.remove() }
  if (values) for (var key in values) { var input = row.querySelector('[name=' + key + ']'); if (input) input.value = values[key] }
}
document.getElementById('addRole').onclick = function () { addRole({}) }
document.getElementById('approverPick').onchange = function () {
  if (!this.value) return
  document.querySelector('[name=approverOpenId]').value = this.value
  document.querySelector('[name=approverPerson]').value = this.options[this.selectedIndex].textContent
}
document.getElementById('loadMembers').onclick = async function () {
  var form = document.getElementById('create')
  var hint = document.getElementById('memberHint')
  hint.textContent = '读取中…'
  try {
    var response = await fetch('/feishu/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: form.appId.value, appSecret: form.appSecret.value, chatId: form.chatId.value }) })
    var body = await response.json()
    if (!response.ok) throw new Error(body.error || response.status)
    members = body.members || []
    fillMemberSelects()
    hint.textContent = '已读取 ' + members.length + ' 人'
  } catch (error) { hint.textContent = '读取失败：' + error.message + '（可手工填 open_id）' }
}
addRole({ roleKey: 'design', roleName: '设计岗', roleOrder: '1', roleDir: 'design/' })
addRole({ roleKey: 'implement', roleName: '实施岗', roleOrder: '2', roleDir: 'app/' })

var rows = document.getElementById('rows'), out = document.getElementById('out')
function badge(ok, text, kind) { return '<span class="badge ' + kind + '">' + text + '</span>' }
async function refresh() {
  var list = await fetch('/projects').then(function (r) { return r.json() })
  document.getElementById('count').textContent = list.length + ' 个'
  rows.innerHTML = list.map(function (p) {
    var running = p.status && p.status.running
    var health = (p.status && p.status.health) || '—'
    var healthKind = health === 'healthy' ? 'ok' : health === 'starting' ? 'warn' : 'bad'
    return '<tr><td><strong>' + p.id + '</strong></td><td>' + p.port + '</td><td>' + badge(running, running ? '运行中' : '未运行', running ? 'ok' : 'bad') + '</td><td>' + badge(true, health, healthKind) + '</td><td class="right"><button class="danger" data-id="' + p.id + '">删除</button></td></tr>'
  }).join('')
  var buttons = rows.querySelectorAll('button')
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].onclick = async function () {
      if (!confirm('删除容器？数据卷会保留')) return
      out.textContent = await fetch('/projects/' + this.dataset.id, { method: 'DELETE' }).then(function (r) { return r.text() })
      refresh()
    }
  }
}
document.getElementById('create').onsubmit = async function (event) {
  event.preventDefault()
  var body = {}
  new FormData(event.target).forEach(function (value, key) { if (value !== '') body[key] = value })
  if (body.collaborators) body.collaborators = body.collaborators.split(',').map(function (s) { return s.trim() }).filter(Boolean)
  var roles = []
  var roleRows = roleBox.querySelectorAll('tr.role')
  for (var i = 0; i < roleRows.length; i++) {
    var row = roleRows[i]
    var role = {
      key: row.querySelector('[name=roleKey]').value.trim(),
      name: row.querySelector('[name=roleName]').value.trim(),
      order: Number(row.querySelector('[name=roleOrder]').value) || undefined,
      openId: row.querySelector('[name=roleOpenId]').value.trim(),
      person: row.querySelector('[name=rolePerson]').value.trim(),
      github: row.querySelector('[name=roleGithub]').value.trim(),
      deliverableDir: row.querySelector('[name=roleDir]').value.trim(),
    }
    if (role.key && role.name) roles.push(role)
  }
  var approver = { name: '管理岗', person: body.approverPerson || '', openId: body.approverOpenId || '', github: body.approverGithub || '' }
  body.team = { approver: approver, roles: roles }
  delete body.approverOpenId; delete body.approverGithub; delete body.approverPerson
  var allowed = approver.openId ? [approver.openId] : []
  for (var j = 0; j < roles.length; j++) if (roles[j].openId) allowed.push(roles[j].openId)
  if (allowed.length) body.feishuAllowed = allowed
  out.textContent = '创建中…'
  var response = await fetch('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  out.textContent = await response.text()
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
    const reconcileMatch = url.pathname.match(/^\/projects\/([\w-]+)\/reconcile$/)
    if (reconcileMatch && req.method === 'POST') {
      const id = reconcileMatch[1]
      const project = findProject(id)
      if (!project) return json(res, 404, { error: `未知项目：${id}` })
      const body = await readBody(req)
      const defaults = readDefaults()
      const target = { host: project.host, port: project.port }
      const current = await readSettings(target)
      const repository = String(body.repository ?? sourceOf(current, 'github')?.value?.config?.repository ?? '')
      const collaborators = normalizeUsers(body.collaborators).map(user => user.id)
      const teamSpec = teamSpecFrom(body, collaborators)
      let team = await checkTeamFile(repository, defaults.GH_TOKEN)
      let written = false
      if (body.writeTeam && teamSpec && repository) {
        await writeTeamFile(repository, teamSpec, defaults.GH_TOKEN)
        written = true
        team = await checkTeamFile(repository, defaults.GH_TOKEN)
      }
      const openIds = teamSpec
        ? [teamSpec.approver.openId, ...teamSpec.roles.map(role => role.openId)].filter(Boolean).map(item => ({ id: item }))
        : []
      const settings = await reconcileProject(target, {
        chats: body.chatId ? [{ chatId: String(body.chatId), listen: body.listen === 'all' ? 'all' : 'mentions' }] : [],
        directMessages: body.directMessages,
        otherChats: body.otherChats,
        repository: repository || undefined,
        observe: body.observe,
        feishuAllowed: normalizeUsers(body.feishuAllowed).length ? normalizeUsers(body.feishuAllowed) : openIds,
        githubAllowed: collaborators,
        replace: !!body.replace,
      })
      const collaboratorResults = collaborators.length && repository
        ? await ensureCollaborators(repository, collaborators, defaults.GH_TOKEN, String(body.collaboratorPermission ?? 'push'))
        : []
      const changed = ['feishu', 'github', 'policy'].filter(key => settings[key]?.changed)
      if (written) changed.push('team.yml')
      if (collaboratorResults.some(item => item.ok && !item.existed)) changed.push('collaborators')
      return json(res, 200, { id, ok: true, changed, team: { ...team, written, roles: teamSpec?.roles.length ?? null }, settings, collaborators: collaboratorResults })
    }
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
    if (url.pathname === '/feishu/members' && req.method === 'POST') {
      const body = await readBody(req)
      return json(res, 200, {
        members: await feishuMembers(String(body.appId ?? ''), String(body.appSecret ?? ''), String(body.chatId ?? '')),
      })
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








