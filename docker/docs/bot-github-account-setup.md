# 专用 Bot GitHub 账号 · 配置清单

> 目标：让 DSH 的 Project Worker 用**独立 bot 账号**操作 GitHub，使 plan/task issue、PR、评论的作者显示为 bot，而不是你个人账号。

## 0. 原理（先理解为什么）
- Agent 的 GitHub 身份 = `gh` 登录账号。启动时执行 `gh api user` 取 `login` 与 `id`，并推导提交邮箱 `noreply = <id>+<login>@users.noreply.github.com`（`src/deployment.ts:95-105`）。
- **一个 token 只对应一个账号**，无法在同一凭据下"改作者名"。要独立 bot 身份，只能让 Agent 使用 bot 账号的 token。
- setup 还会校验该账号对仓库有 **push 权限**（`deployment.ts:99-104` 要求 `permissions.push === true`）。

## 1. 创建 bot 账号（二选一）
- **A. Machine user（推荐先用）**：新建一个普通 GitHub 账号（如 `lafinger-agent`），用企业/常用邮箱、开启 2FA、补全资料（新账号易被风控，资料完整更稳）。
- **B. GitHub App（组织/更规范）**：创建 App → 安装到该仓库 → 授予 Issues / Pull requests / Contents 读写。⚠️ `gh` 默认走 user token，用 App 需把 installation token 注入 `gh`（较绕，建议后置）。

## 2. 授权仓库
- 把 bot 账号加成 `Lafinger/dsh-project-demo` 的 **Collaborator**，权限 **Write**（bot 账号需接受邀请）。
- 若在 org 下，也可给 bot 账号所在 team 写权限。
- 必须满足 `permissions.push === true`，否则 setup 报 `repositoryReadOnly`。

## 3. 生成 token（Fine-grained PAT，最小权限）
bot 账号 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate：
- **Repository access**：Only select repositories → `Lafinger/dsh-project-demo`（+ 将来要用的仓库）。
- **Permissions（Repository）**：`Contents: Read and write`、`Issues: Read and write`、`Pull requests: Read and write`；`Metadata` 自动只读。
- 复制 token（只显示一次）。

## 4. 记录 bot 的 login 与 noreply
- login 形如 `lafinger-agent`。
- 在 bot 账号开启 "Keep my email addresses private"；noreply 形如 `<id>+lafinger-agent@users.noreply.github.com`（DSH 自动计算，无需手填）。

## 5. 改部署配置
编辑 `dsh-superagent/docker/.env.project`：
- `GH_TOKEN=<bot 的 fine-grained PAT>`（替换原值）
- `GH_USER=<bot login>`（entrypoint 已支持；写进 hosts.yml 的 user 提示）
- `GITHUB_REPOSITORY` 保持 `Lafinger/dsh-project-demo`
- ⚠️ token 是 secret，别提交；`.env.project` 已在 gitignore。
- ⚠️ **改了 env_file 必须 `up -d --force-recreate` 才生效**（`restart` 不会重读 env_file）。

## 6. 关键坑：旧 `hosts.yml` 会让换号"静默失效"
- `/root/.gh-agent` 挂在命名卷 `gh-config` 上；`entrypoint.sh:54` 只要 `hosts.yml` 存在就**跳过**写凭据。**只改 `GH_TOKEN` 不会换号！**
- 正确的操作顺序（在 `dsh-superagent/docker` 下）：
  1. 改 `.env.project` 的 `GH_TOKEN`
  2. `docker exec dsh-superagent-project-dsh-superagent-1 rm -f /root/.gh-agent/hosts.yml`
  3. `docker compose -f docker-compose.project.yml --env-file .env.project up -d --force-recreate`
- 顺序很重要：先删卷里的 `hosts.yml`，再 `--force-recreate`，entrypoint 才会用新 token 重写。

## 7. 验证
- 身份：`docker exec dsh-superagent-project-dsh-superagent-1 sh -c 'env -u GH_TOKEN GH_CONFIG_DIR=/root/.gh-agent gh api user --jq .login'` → 应为 bot login。
- 登录态：`docker exec dsh-superagent-project-dsh-superagent-1 gh-agent auth status`
- 推送权：`docker exec dsh-superagent-project-dsh-superagent-1 gh-agent api repos/Lafinger/dsh-project-demo --jq .permissions.push` → `true`
- 面板：`GET /orchestrator/api/state` 的 `setup.problem=null`、`github=ready`。
- 实效：让机器人建一个测试 issue/PR，确认作者是 bot。

## 8. entrypoint 的 GH_USER 支持（已实现）
- 已把 `entrypoint.sh` 的 `gh_user` 改为 `gh_user="${GH_USER:-${GITHUB_REPOSITORY%%/*}}"`，并在 `docker-compose.project.yml` 透传 `GH_USER`。
- 因此设 `.env.project` 的 `GH_USER=<bot login>` 后，`hosts.yml` 的 `user:` 也会写成 bot，`gh auth status` 显示正确。
- 不设 `GH_USER` 时退回仓库属主，行为与原来一致（不影响运行，真实身份仍来自 token 的 `gh api user`）。

## 9. 行为影响与注意
- **自建事件被忽略**：GitHub source 对 `item.user.login == 部署账号` 的事件直接 `continue`（`src/sources/github.ts:227`）。bot 自己创建的 issue/PR **不会**反过来触发工单（防环）。人要反馈，请用**人类账号**评论或走飞书。
- **bot 类型判定**：`[bot]` 结尾或 `type=Bot` 被视为"非人类"（`src/sources/github-trigger.ts:46`）。GitHub App 的 login 带 `[bot]` → 它发的评论不能作为授权来源；machine user（普通 User）则与普通账号一致。
- **PR 绑定**：Agent 开的 PR 需 `pr.user.login == 部署账号` 且分支末段 == `DSH_SUPERAGENT_NAME` 才能绑定工单（`src/sources/github-pull.ts:23-25`）。换 bot 后 agent 的 PR 仍能绑定；**人类自开的 PR 仍不会自动绑定**，所以成果 PR 链接仍要走飞书贴给机器人（与现在一致）。
- **历史不变**：历史 issue/PR 作者不变，仅新操作显示为 bot。
- **多仓库**：token 的仓库范围要覆盖所有目标仓库。
- **回滚**：把 `GH_TOKEN` 换回原值 + 删 `hosts.yml` + `--force-recreate` 即恢复。
- **安全**：专用账号 + 2FA + 最小权限 + 定期轮换；不要与个人主账号共享 token。

## 10. 一键切换脚本（推荐）
`dsh-superagent/docker/switch-github-bot.ps1` 把第 5–7 步串起来，自带备份与校验：

```powershell
# 在 dsh-superagent/docker 目录
./switch-github-bot.ps1 -GhUser lafinger-agent
# 会安全提示输入 PAT；或显式传 -Token
./switch-github-bot.ps1 -GhUser lafinger-agent -Token '<fine-grained PAT>'
```

脚本做的事：备份 `.env.project` → 写入 `GH_TOKEN`/`GH_USER` → 删除旧 `/root/.gh-agent/hosts.yml` → `up -d --force-recreate` → 等健康 → 校验 `gh api user` 是否等于目标 login、仓库 `push` 权限是否为 true；失败会打印回滚步骤。
