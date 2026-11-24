# 项目实例与工时网关（容器化，不占用宿主端口）

一个项目 = 一个文件夹 = 一个容器 = 一个 DSH profile + 一个飞书应用 + 一个 GitHub 仓库。
所有实例都不发布宿主端口，由**工时聚合网关**在 `dsh-shared` 网络上按别名访问。

## 目录布局

```
docker/
├── Dockerfile / entrypoint.sh / healthcheck.sh / panel-forward.mjs   # 通用镜像与启动逻辑
├── docker-compose.project.yml      # 项目实例模板（复制到项目目录使用）
├── .env.project.example            # 项目环境变量模板
├── new-project.ps1                 # 一键新建项目
├── docker-compose.gateway.yml      # 工时网关
├── gateway/gateway.mjs             # 网关实现
├── gateway/projects.json           # 项目清单（网关读取）
└── dsh-superagent-<项目>/          # 每个项目一个目录（不入库，含 .env 密钥）
    ├── docker-compose.yml          # 由模板复制而来
    └── .env
```

`docker/.gitignore` 已排除 `dsh-superagent-*/`，**项目目录不入库**，模板与网关脚本才入库。

## 一次性准备

```powershell
cd dsh-superagent-prototype\docker
docker network create dsh-shared
docker compose -f docker-compose.gateway.yml up -d
```

## 新建一个项目

```powershell
.\new-project.ps1 -Name kb2 -Port 3085 -Repository lafinger-agent/kb2-demo -FromEnv dsh-superagent-metahuman\.env
```

脚本会建目录、复制模板、生成 `.env`、构建启动、等 `healthy`、写入 `gateway/projects.json` 并重启网关。

**每个项目必须有独立的飞书应用**（`LARK_APP_ID` / `LARK_APP_SECRET`），否则实例之间会抢事件；端口与别名也必须唯一。

## 已有项目（metahuman）

```powershell
cd dsh-superagent-metahuman
docker compose up -d          # 或 docker compose ps / logs -f
```

该实例同时发布宿主端口（便于局域网直接看面板）并加入 `dsh-shared`（别名 `metahuman`）。

## 网关接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects` | 项目清单 + `ok` 探活 |
| GET | `/timesheet?project=<id>&plan=N` | 转发该项目的 v2 工时响应 |
| GET | `/timesheet/all` | 汇总：`{ projects: [...], errors: [...] }` |
| GET | `/healthz` | 存活探针 |

网关只监听容器内 `0.0.0.0:3090`。宿主机前端要用时，取消 `docker-compose.gateway.yml` 里 `ports` 注释（只占一个端口）；前端若也容器化，让它加入 `dsh-shared` 并访问 `http://gateway:3090`。

## 原理

- 实例的 DSH 面板强制监听容器内 `127.0.0.1:<port>`；
- `entrypoint.sh` 启动 `panel-forward.mjs`，把 `<容器网卡IP>:<port>` 原样转发到 `127.0.0.1:<port>`（保留 Host 头）；
- 网关在 `dsh-shared` 上连 `<别名>:<port>`，把 `Host` 写成 `127.0.0.1:<port>`，实例的 `sameOrigin` 校验直接通过——无需改实例配置。

## 排障

| 现象 | 处理 |
|---|---|
| 网关 502 / ECONNREFUSED | 实例没加入 `dsh-shared`，或 forwarder 未启动（`docker logs <容器> | grep panel-forward`）|
| 网关 403 | Host 不是 `127.0.0.1:<port>`；检查网关是否按端口改写 Host |
| 两个实例抢飞书事件 | 复用了同一个飞书应用 |
| 端口冲突 | `SUPERAGENT_PORT` 逐项目唯一 |
| 脚本停在"还没有飞书应用凭据" | 填好项目目录 `.env` 的 `LARK_APP_ID` / `LARK_APP_SECRET` 后重跑（可加 `-SkipBuild`）|
| 重建后网关连不上 | 网络别名来自 compose，确认 `dsh-shared` 段仍在、容器已重建 |
