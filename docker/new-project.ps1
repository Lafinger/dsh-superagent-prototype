# 新建一个项目实例：一个项目 = docker/dsh-superagent-<项目>/ 一个文件夹。
#
# 示例：
#   .\new-project.ps1 -Name kb2 -Port 3085 -Repository lafinger-agent/kb2-demo -FromEnv dsh-superagent-metahuman\.env
#
# 脚本会：
#   1) 建 docker/dsh-superagent-<Name>/ 文件夹（已存在则复用）；
#   2) 复制 docker-compose.project.yml → 该目录 docker-compose.yml；
#   3) 由 .env.project.example 生成该目录 .env（可复制已有项目的密钥）；
#   4) 构建并启动容器，等待 healthy；
#   5) 把该项目登记到 gateway/projects.json 并重启网关。
#
# 项目目录带 .env 密钥，已在 docker/.gitignore 中排除，不会入库。

param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][int]$Port,
  [string]$Alias = '',
  [Parameter(Mandatory = $true)][string]$Repository,
  [string]$Ref = 'main',
  [string]$FromEnv = '',
  [string]$AppId = '',
  [string]$AppSecret = '',
  [string]$GhToken = '',
  [string]$GhUser = 'lafinger-agent',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
if (-not $Alias) { $Alias = $Name }
if ($Name -notmatch '^[a-z0-9][a-z0-9-]*$') { throw "Name 只能用小写字母、数字和连字符：$Name" }

function Get-EnvMap([string]$path) {
  $map = @{}
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $k, $v = $line -split '=', 2
    $map[$k.Trim()] = $v
  }
  return $map
}

# 1. 网络
if (-not (docker network inspect dsh-shared 2>$null)) {
  docker network create dsh-shared | Out-Null
  Write-Host "已创建网络 dsh-shared"
}

# 2. 端口占用检查
$used = docker ps --format '{{.Ports}}' | Select-String ":$Port->"
if ($used) { throw "端口 $Port 已被其他容器占用" }

# 3. 项目文件夹
$folder = Join-Path $PSScriptRoot "dsh-superagent-$Name"
if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
Copy-Item (Join-Path $PSScriptRoot 'docker-compose.project.yml') (Join-Path $folder 'docker-compose.yml') -Force

$envPath = Join-Path $folder '.env'
$content = Get-Content (Join-Path $PSScriptRoot '.env.project.example')
$set = @{
  SUPERAGENT_PROFILE = $Name
  SUPERAGENT_PORT    = "$Port"
  PROJECT_ALIAS      = $Alias
  SUPERAGENT_REF     = $Ref
  GITHUB_REPOSITORY  = $Repository
  GH_USER            = $GhUser
}
if ($AppId) { $set['LARK_APP_ID'] = $AppId }
if ($AppSecret) { $set['LARK_APP_SECRET'] = $AppSecret }
if ($GhToken) { $set['GH_TOKEN'] = $GhToken }

$out = foreach ($line in $content) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { $line; continue }
  $k = ($line -split '=', 2)[0].Trim()
  if ($set.ContainsKey($k)) { "$k=$($set[$k])" } else { $line }
}
$out | Set-Content -Path $envPath -Encoding UTF8

# 4. 从已有环境复制密钥（飞书应用除外）
if ($FromEnv) {
  $src = Get-EnvMap (Join-Path $PSScriptRoot $FromEnv)
  $map = Get-EnvMap $envPath
  foreach ($key in @('LINKCODE_API_KEY', 'CPA_API_KEY', 'GH_TOKEN')) {
    if (-not $map[$key] -and $src[$key]) { $map[$key] = $src[$key] }
  }
  $map.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" } | Set-Content -Path $envPath -Encoding UTF8
}

$map = Get-EnvMap $envPath
if (-not $map['LARK_APP_ID'] -or -not $map['LARK_APP_SECRET']) {
  Write-Warning "还没有飞书应用凭据：请填写 $envPath 的 LARK_APP_ID / LARK_APP_SECRET 后重跑本脚本。"
  return
}

# 5. 启动（在项目目录内执行，compose 自动读同目录 .env）
Push-Location $folder
try {
  $args = @('compose', 'up', '-d')
  if (-not $SkipBuild) { $args += '--build' }
  docker @args
  if ($LASTEXITCODE -ne 0) { throw "docker compose 启动失败" }
} finally {
  Pop-Location
}

# 6. 等健康
$container = "dsh-superagent-$Name-dsh-superagent-1"
for ($i = 0; $i -lt 60; $i++) {
  $health = docker inspect --format '{{.State.Health.Status}}' $container 2>$null
  if ($health -eq 'healthy') { break }
  if ($health -eq 'unhealthy') { throw "容器不健康：docker logs $container" }
  Start-Sleep -Seconds 5
}
Write-Host "容器 $container 已就绪"

# 7. 登记到网关
$projectsPath = Join-Path $PSScriptRoot 'gateway/projects.json'
$registry = if (Test-Path $projectsPath) { Get-Content $projectsPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{ projects = @() } }
$list = @($registry.projects | Where-Object { $_.id -ne $Alias })
$list += [pscustomobject]@{ id = $Alias; name = $Name; host = $Alias; port = $Port }
[pscustomobject]@{ projects = $list } | ConvertTo-Json -Depth 4 | Set-Content -Path $projectsPath -Encoding UTF8

# 8. 重启网关
$gateway = docker ps --filter 'name=timesheet-gateway' --format '{{.Names}}'
if ($gateway) { docker restart $gateway | Out-Null; Write-Host "已重启网关 $gateway" }
else { Write-Host "网关未运行；启动它：cd $PSScriptRoot; docker compose -f docker-compose.gateway.yml up -d" }

Write-Host ""
Write-Host "下一步："
Write-Host "  1) 把机器人拉进项目群，在面板里配置飞书群与 GitHub 仓库；"
Write-Host "  2) 探活：docker exec <网关容器> curl -s http://$Alias`:$Port/orchestrator/api/state"
Write-Host "  3) 工时：docker exec <网关容器> curl -s 'http://127.0.0.1:3090/timesheet?project=$Alias'"
