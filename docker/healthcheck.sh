#!/bin/sh
# 探针只看面板是否应答。
#
# 两个刻意的选择：
# 1. 不用 `scripts/dsh-superagent status` 的退出码：本部署只启用飞书，GitHub Source
#    关掉后 status 会长期停在 3，而 3 在 Docker 眼里和"挂了"无法区分。
# 2. 打 /state 而不是 /：插件 API 没有根路径，打 / 会得到 404 并被 curl -f 判为失败。
set -eu

PORT="${SUPERAGENT_PORT:-3082}"

# 面板仍在本机回环上（管理 API 要求 loopback），探针直接连 127.0.0.1。
curl -fsS --max-time 8 \
  -H 'x-orchestrator-request: 1' \
  "http://127.0.0.1:${PORT}/orchestrator/api/state" \
  -o /dev/null
