# dsh-superagent 单容器镜像
#
# 上游没有官方 Dockerfile：006-deployment.md 描述的是宿主机 + tmux 的安装流程。
# 本镜像把那条流程原样搬进容器，并保留 tmux（见 docs/adr/0001）。

# 用 Node 22 而不是 24：Node 24 会把主线程名设为 "MainThread"，于是
# /proc/<pid>/comm 返回 MainThread，而上游 scripts/dsh-superagent 的 serves()
# 只认 ucomm 为 node 或 dsh，导致 status/start/stop 看不到服务进程。
# Node 22 不设线程名，上游脚本可原样运行；且满足插件 engines.node (^22.19.0)。
FROM node:22-bookworm

ARG SUPERAGENT_REPO=https://github.com/deepseek-ai/dsh-superagent-prototype.git
ARG SUPERAGENT_REF=8c32a9dc5d72c033816c6a8110b37f40cf94fba4
ARG DSH_VERSION=0.2.1-rc.3
ARG LARK_CLI_VERSION=1.0.90
ARG GH_VERSION=2.103.3

# 上游前置条件：git 2.32+、Python 3.8+、tmux，以及构建工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl tmux python3 python3-venv python3-pip jq tini \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

# GitHub CLI：插件的 setup 强制校验一个可推送的 GitHub 仓库（见 docs/adr/0002），
# 因此容器里必须有 agent 的 gh。Debian 仓库没有 gh，官方 apt 源在本网络不可达，
# 改为从 GitHub Release 下二进制（github.com / objects.githubusercontent.com 可达）。
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tgz \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh* \
 && gh --version

# 钉住版本的 DeepSeek Harness。版本必须满足插件的 engines.dsh，否则启动时报插件不兼容。
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

# 插件本体：构建期从上游 clone 并 pin 到具体 commit，保证镜像可复现。
# 离线构建（Q2 建议 B）可改用 `--build-arg SUPERAGENT_SRC=./dsh-superagent` 配合下面的开关。
ARG SUPERAGENT_SRC=""
WORKDIR /opt
RUN if [ -n "$SUPERAGENT_SRC" ]; then \
      cp -r "$SUPERAGENT_SRC" /opt/dsh-superagent; \
    else \
      git clone --filter=blob:none "$SUPERAGENT_REPO" /opt/dsh-superagent \
      && git -C /opt/dsh-superagent checkout "$SUPERAGENT_REF"; \
    fi \
 && cd /opt/dsh-superagent \
 && pnpm install --frozen-lockfile \
 && pnpm build

# 飞书 CLI。插件通过容器内的本机 CLI 与飞书通信，因此必须装在同一个容器里。
# 注意包名是 @larksuite/cli（提供 lark-cli 这个可执行文件）；
# npm 上那个裸名 lark-cli 是无关的 0.1.0 stub，装了会得到错误的 CLI。
RUN npm install -g "@larksuite/cli@${LARK_CLI_VERSION}" \
 && lark-cli --version

ENV DSH_HOME=/root/.dsh \
    STATE_DIR=/root/.dsh/superagent-state \
    LARKSUITE_CLI_CONFIG_DIR=/root/.lark-cli-dsh-superagent \
    SUPERAGENT_PROFILE=superagent \
    SUPERAGENT_PORT=3082 \
    TZ=Asia/Shanghai

# wrapper：只做一件事，用机器人自己的凭据调用 lark-cli。
# 插件被指向 wrapper，而不是 lark-cli 本身（上游要求 bot-only 配置）。
# gh-agent 同理：用独立 GH_CONFIG_DIR 存放 agent 账号凭据。
RUN mkdir -p /root/.local/bin /root/.gh-agent \
 && printf '%s\n' \
      '#!/bin/sh' \
      'export LARKSUITE_CLI_CONFIG_DIR="${LARKSUITE_CLI_CONFIG_DIR:-/root/.lark-cli-dsh-superagent}"' \
      'exec lark-cli "$@"' \
      > /root/.local/bin/lark-bot \
 && printf '%s\n' \
      '#!/bin/sh' \
      'export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/root/.gh-agent}"' \
      'exec gh "$@"' \
      > /root/.local/bin/gh-agent \
 && chmod +x /root/.local/bin/lark-bot /root/.local/bin/gh-agent

ENV PATH=/root/.local/bin:$PATH \
    GH_CONFIG_DIR=/root/.gh-agent

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
COPY panel-forward.mjs /usr/local/bin/panel-forward.mjs
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

WORKDIR /opt/dsh-superagent

# 面板监听容器网卡 IP（由 entrypoint 每次启动写入），宿主经 127.0.0.1:<port> 映射访问。
EXPOSE 3082

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
  CMD ["/usr/local/bin/healthcheck.sh"]

# tini 负责回收 tmux 与 dsh 留下的孤儿进程
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
