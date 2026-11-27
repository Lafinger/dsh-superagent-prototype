# GitHub App 部署配置步骤（含 DSH 适配说明）

> 先讲清一个硬约束，避免白忙：**DSH 当前只支持"用户账号"的 gh 令牌，不支持 GitHub App 安装令牌。**
> - 启动校验 `src/deployment.ts:87-105` 会执行 `gh api user` 取 `login` 和 `id`（提交邮箱也由 `id+login` 推出）。
> - GitHub App 的**安装令牌（`ghs_…`）不能调用 `/user`**（返回 `Resource not accessible by integration`），会触发 setup 的 `agentCliSignedOut / agentCliNoAccount`。
> - 另外 `GithubUser.login` 的正则 `^[A-Za-z0-9-]+$`（`deployment.ts:78`）**不接受 `[bot]` 后缀**。
>
> 所以：**要么用"机器用户"（machine user，纯配置即可，见 `bot-github-account-setup.md`）；要么按下文 Part B 改造 DSH 才真正能用 App。** 下面 Part A 是标准 App 配置（在任何场景都适用），Part B 是让它接进本部署的改造步骤。

---

## Part A. 标准 GitHub App 创建 / 安装 / 取令牌

### A1. 创建 App
1. 个人账号：`Settings → Developer settings → GitHub Apps → New GitHub App`；组织：`Org Settings → Developer settings → GitHub Apps`。
2. 填写：
   - **GitHub App name**：如 `lafinger-project-bot`（决定 bot 登录名 `<slug>[bot]`）。
   - **Homepage URL**：可填仓库地址。
   - **Webhook**：取消 **Active**（本部署靠轮询，不需要 webhook）。
3. **Repository permissions**（最小集）：
   - `Contents: Read and write`
   - `Issues: Read and write`
   - `Pull requests: Read and write`
   - `Metadata: Read-only`（自动必选）
   - 如要观测 CI：再加 `Checks: Read-only` / `Actions: Read-only`
4. **Where can this app be installed**：`Only on this account`。
5. 创建后记录：
   - **App ID**（General 页顶部）
   - **Private key**：`Generate a private key` → 下载 `*.pem`（**只显示一次**，妥善保管）
   - （可选）Client ID / Client secret（走 OAuth 时才用）

### A2. 安装到仓库
1. App 页面 → `Install App` → 选择账号 → `Only select repositories` → 选 `Lafinger/dsh-project-demo` → `Install`。
2. 记录 **Installation ID**：安装成功后地址形如 `https://github.com/settings/installations/<INSTALLATION_ID>`；也可用 A3 的 JWT 调 `GET /app/installations` 查。

### A3. 用私钥换安装令牌（有效期 1 小时）
需要先用私钥签一个 JWT（RS256），再用 JWT 换 installation token。

**方式一：openssl（bash）**
```bash
APP_ID=123456
INSTALLATION_ID=987654
PEM=app.pem

iat=$(( $(date +%s) - 60 )); exp=$(( $(date +%s) + 540 ))
b64url(){ openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
payload=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$iat" "$exp" "$APP_ID" | b64url)
sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$PEM" | b64url)
JWT="$header.$payload.$sig"

curl -s -X POST \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/app/installations/$INSTALLATION_ID/access_tokens"
# 返回 {"token":"ghs_...","expires_at":"..."}
```

**方式二：Node 内置 crypto（无需额外依赖）**
```js
const fs = require('fs'), crypto = require('crypto')
const appId = process.env.APP_ID, key = fs.readFileSync('app.pem')
const now = Math.floor(Date.now() / 1000)
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iat: now - 60, exp: now + 540, iss: String(appId) })
const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url')
console.log(unsigned + '.' + sig)   // 作为 Bearer 去换 installation token
```

### A4. 验证令牌（重要）
```bash
# 能列出安装覆盖的仓库（说明令牌有效、有权限）
curl -s -H "Authorization: Bearer ghs_xxx" -H "Accept: application/vnd.github+json" \
  https://api.github.com/installation/repositories

# 关键：/user 会失败（这正是 DSH 不能直接用 App 令牌的原因）
curl -s -H "Authorization: Bearer ghs_xxx" https://api.github.com/user
# => {"message":"Resource not accessible by integration"}
```

---

## Part B. 让 DSH 用上 GitHub App（需改造）

若组织要求用 App（例如无个人机器账号、集中治理），需按下面改造；否则**建议直接用机器用户**（Part C）。

### B1. 代码改动点
1. **`src/deployment.ts`**
   - `GithubUser` 正则（:78）放宽以接受 `[bot]`：`/^[A-Za-z0-9\-\[\]]+$/`。
   - `resolveDeployment`（:87-105）增加 App 分支：当 `gh api user` 失败且配置了 App 时，改用
     - `GET /installation/repositories` 校验仓库与权限；或 `GET repos/<repo>` 取 `.permissions.push`；
     - 身份用配置的 `botLogin`（`<slug>[bot]`）与 `botId`（可用 `GET /users/<slug>[bot]` 取 id），
     - `noreply = <botId>+<slug>[bot]@users.noreply.github.com`。
2. **令牌刷新器**（新增，关键）
   - 安装令牌 1 小时过期，`hosts.yml` 是静态的，必须定时刷新。
   - 新增 `docker/gh-app-refresh.sh`：用 `GH_APP_ID` + 私钥 + `GH_APP_INSTALLATION_ID` 生成 JWT → 换 installation token → 重写 `/root/.gh-agent/hosts.yml`（`oauth_token` / `user`）。
   - `entrypoint.sh`：App 模式下不再用静态 `GH_TOKEN` 写 `hosts.yml`，改为启动后台 loop（如每 50 分钟刷新一次，启动即刷一次）。
3. **git 凭据（push 用）**
   - App 令牌走 https 推 git 时，通常需要 `username=x-access-token`、`password=<ghs token>`。
   - 现有 `workerGitConfig`（`src/infra/environment.ts:106-112`）用的是 `gh auth git-credential`；大概率可用，但若 push 401，需换成自定义 credential helper 返回 `x-access-token`。
4. **配置与密钥**
   - compose 增加：`GH_APP_ID`、`GH_APP_INSTALLATION_ID`、私钥（用 docker secret 或只读挂载 `/run/secrets/gh-app.pem`）。
   - `.env.project` 增加对应变量；私钥不要进镜像、不要提交。
5. **测试**
   - `tests/deployment.spec.ts`（若有）补 App 身份解析分支；跑 `vitest run`。

### B2. 改造后的效果与代价
- issue/PR/评论作者显示为 `<slug>[bot]`；`isHumanLogin` 视为**非人类**（`src/sources/github-trigger.ts:46`），它发的评论不能作为授权来源——与预期一致（防自触发）。
- 代价：需维护私钥与刷新器、改 3~4 个文件、处理 git 凭据与过期，运维复杂度明显高于机器用户。

---

## Part C. 建议：优先"机器用户"，App 仅在必要时
| 维度 | 机器用户（machine user） | GitHub App |
| --- | --- | --- |
| DSH 开箱兼容 | ✅ 直接可用（换 token 即可） | ❌ 需改造（deployment/entrypoint/刷新器） |
| 令牌有效期 | PAT 长期（需轮换） | 安装令牌 1 小时（必须刷新） |
| 权限粒度 | fine-grained PAT 已足够细 | 最细，贴合组织治理 |
| 身份显示 | bot 账号 | `<slug>[bot]` |
| 维护成本 | 低 | 高 |
| 适用 | 个人仓库/少数仓库 | 组织统一治理、无个人机器账号 |

**结论**：当前项目（个人私有仓库）用**机器用户**最划算，见 [bot-github-account-setup.md](./bot-github-account-setup.md) 与 `docker/switch-github-bot.ps1`。若你确实要走 App，我可以按 Part B 把改造做掉（deployment 解析 + 令牌刷新器 + compose 密钥 + 测试），预计改动 4 个文件。

---

## Part D. 附：App 模式验证清单
- `GET /installation/repositories` 能看到目标仓库
- `gh-agent api repos/<repo> --jq .permissions.push` == true（或自定义校验）
- 面板 `setup.problem=null`、`github=ready`
- 建测试 issue/PR，作者为 `<slug>[bot]`
- `hosts.yml` 的 `oauth_token` 在 1 小时内被刷新（看刷新日志/`expires_at`）
