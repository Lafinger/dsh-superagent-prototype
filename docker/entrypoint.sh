#!/bin/sh
# 容器入口：幂等初始化飞书凭据 → 建 profile → 装插件 → 落机器配置 → 用 tmux 起服务 → 前台保活。
#
# 注意：上游 scripts/dsh-superagent 是 Python 脚本（依赖 fcntl），profile 用
# `dsh --profile <name>` 指定，不是位置参数。这里全部走该脚本，以保住它的四种退出码语义。
set -eu

PROFILE="${SUPERAGENT_PROFILE:-superagent}"
PORT="${SUPERAGENT_PORT:-3082}"
DSH_HOME="${DSH_HOME:-/root/.dsh}"
STATE_DIR="${STATE_DIR:-${DSH_HOME}/superagent-state}"
LARK_DIR="${LARKSUITE_CLI_CONFIG_DIR:-/root/.lark-cli-dsh-superagent}"
GH_DIR="${GH_CONFIG_DIR:-/root/.gh-agent}"
REPO_DIR="${REPO_DIR:-/opt/dsh-superagent}"
SESSION="dsh-${PROFILE}"
# 模型供应商（默认复用本机的 cpa；密钥走 CPA_API_KEY 环境变量）
MODEL_PROVIDER="${MODEL_PROVIDER:-cpa}"
MODEL_BASE_URL="${MODEL_BASE_URL:-https://cpa.lafinger.us.ci:8343/v1}"
MODEL_NAME="${MODEL_NAME:-deepseek-v4.1-flash}"
MODEL_APIKEY_ENV="${MODEL_APIKEY_ENV:-CPA_API_KEY}"

# 面板监听地址：绑定容器主网卡 IP，宿主的 127.0.0.1:<port> 端口映射才能转到进程。
# dsh web 只接受具体的本机地址（拒绝通配），而容器重建后 IP 可能变化，所以每次启动都重新计算。
PANEL_HOST="$(hostname -i 2>/dev/null | awk '{print $1}')"
if [ -z "${PANEL_HOST}" ]; then
  PANEL_HOST="$(node -e "const n=require('os').networkInterfaces();for(const k in n)for(const a of n[k]||[])if(a.family==='IPv4'&&!a.internal){console.log(a.address);process.exit(0)}" 2>/dev/null || true)"
fi
[ -n "${PANEL_HOST}" ] || PANEL_HOST="127.0.0.1"

log() { echo "[entrypoint] $*"; }

# --- 1. 飞书凭据：每次启动都刷新 ---------------------------------------------
# lark-cli 把 secret 存进 keychain（config.json 里是 "source":"keychain" 的引用）。
# 该 keychain 在容器重建（新 machine-id）后无法解密，表现为 invalid_client /
# "auth method is not supported"。因此这里**每次启动都重新 init 一次**（用 .env 里的
# 凭据覆盖刷新 keychain），而不是「有 config 就跳过」。
if [ -n "${LARK_APP_ID:-}" ] && [ -n "${LARK_APP_SECRET:-}" ]; then
  log "刷新 lark-cli 机器人配置（每次启动都刷新，规避 keychain 不跨容器持久）"
  # --app-secret-stdin 不把 secret 放进 argv，也不回显
  if printf '%s' "${LARK_APP_SECRET}" | lark-cli config init --app-id "${LARK_APP_ID}" --app-secret-stdin >/dev/null 2>&1; then
    lark-cli config strict-mode bot --global >/dev/null 2>&1 || true
    if lark-cli im +chat-list --as bot >/dev/null 2>&1; then
      log "lark-cli 机器人配置就绪（凭据验证通过）"
    else
      log "lark-cli 配置已写入，但凭据验证未通过（检查 LARK_APP_ID/SECRET 与权限/发布）"
    fi
  else
    log "lark-cli config init 失败"
  fi
else
  log "未设置 LARK_APP_ID / LARK_APP_SECRET，跳过飞书初始化（feishu Source 将停在 setup 缺参状态）"
fi

# --- 1b. GitHub agent 凭据：幂等落盘 ----------------------------------------
# setup 强制校验可推送的 GitHub 仓库（见 docs/adr/0002），必须有一个 agent gh 账号。
# 注意两点坑：
#  1) 直接写 hosts.yml 而不是 `gh auth login --with-token`：后者会校验 token 必须含
#     read:org，而只勾 repo 的经典 token 会被拒；但实际 API/push 并不需要 read:org。
#  2) 必须先 unset GH_TOKEN 才不会让 gh 只认环境变量、不落盘。插件 setup 的 worker
#     probe 会剥掉含 TOKEN 的变量，所以凭据必须落盘在 GH_CONFIG_DIR 里。
mkdir -p "${GH_DIR}"
if [ -f "${GH_DIR}/hosts.yml" ]; then
  log "gh-agent 凭据已落盘，跳过"
elif [ -n "${GH_TOKEN:-}" ]; then
  # hosts.yml 的 user 提示：优先用 GH_USER（专用 bot 账号时设它），否则退回仓库属主。
  gh_user="${GH_USER:-${GITHUB_REPOSITORY%%/*}}"
  umask 077
  { printf 'github.com:\n    oauth_token: '; printf '%s' "${GH_TOKEN}"
    printf '\n    user: %s\n    git_protocol: https\n' "${gh_user}"; } > "${GH_DIR}/hosts.yml"
  if env -u GH_TOKEN GH_CONFIG_DIR="${GH_DIR}" gh api user --jq .login >/dev/null 2>&1; then
    log "gh-agent 凭据已写入并验证通过"
  else
    log "gh-agent 凭据写入但验证失败：GH_TOKEN 可能无效或无 repo 权限"
  fi
else
  log "未设置 GH_TOKEN，跳过 gh-agent（GitHub setup 会失败）"
fi

# --- 2. profile：仅首次创建 --------------------------------------------------
# 这条命令会重建 profile 并删除其 cordis.patch.yml，因此只允许在不存在时执行。
if [ ! -d "${DSH_HOME}/profiles/${PROFILE}" ]; then
  log "从 web 模板创建 profile '${PROFILE}'"
  dsh --profile "${PROFILE}" --from-default-profile web --dump-config > /dev/null
  # 直接生成机器配置，而不是 sed 上游示例：示例里 stateDir 是占位符、飞书行被注释，
  # 多次 sed 容易改错。这里显式写出本部署需要的键。
  # - webserver: 必须监听 127.0.0.1（插件管理 API 要求 loopback Web 服务器，见 src/app/http.ts）；
  #   宿主经端口映射的访问由容器内的 panel-forward 把网卡 IP:<port> 转发到回环。
  # - dsh-superagent: stateDir 必须是绝对路径
  # - dsh-superagent-github: 必须启用。插件 setup 无条件校验 GitHub 仓库（见 docs/adr/0002），
  #   关闭它会让 settings.sources.github 缺失，必现 repositoryUnset，飞书也随之无法工作。
  cat > "${DSH_HOME}/profiles/${PROFILE}/cordis.patch.yml" <<EOF
# 由 docker/entrypoint.sh 生成。改这里等效于改"机器配置"，
# 机器限制也可改 Settings -> Deployment（stateDir 除外，它不能在此处改）。
- id: webserver
  config:
    host: 127.0.0.1
    port: ${PORT}
- id: dsh-superagent
  config:
    stateDir: ${STATE_DIR}
- id: dsh-superagent-github
  disabled: false
- id: dsh-superagent-feishu
  disabled: false
# 模型供应商：与插件同一 profile 的 DSH 实例必须有可用模型，否则评估/执行不动。
# 默认复用本机的 cpa 供应商，密钥从 apiKeyEnv 指定的环境变量读取。
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ${MODEL_PROVIDER}:
        displayName: ${MODEL_PROVIDER}
        apiKeyEnv: ${MODEL_APIKEY_ENV}
        api: openai-responses
        baseURL: ${MODEL_BASE_URL}
        models:
          - id: ${MODEL_NAME}
            name: ${MODEL_NAME}
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: ${MODEL_PROVIDER}
    model: ${MODEL_NAME}
    reasoningEffort: high
EOF
  log "已写入 cordis.patch.yml（stateDir=${STATE_DIR}, port=${PORT}）"
else
  log "profile '${PROFILE}' 已存在，保留其 cordis.patch.yml 不动"
fi

# 面板必须监听 127.0.0.1（插件管理 API 要求 loopback）。若历史配置被写成别的地址，纠正回 127.0.0.1。
panel_file="${DSH_HOME}/profiles/${PROFILE}/cordis.patch.yml"
if [ -f "${panel_file}" ]; then
  tmp_file="${panel_file}.tmp.$$"
  awk '
    /^[[:space:]]*host:[[:space:]]/ && !done { sub(/host:.*/, "host: 127.0.0.1"); done=1 }
    { print }
  ' "${panel_file}" > "${tmp_file}" && mv "${tmp_file}" "${panel_file}"
fi

# --- 3. 安装插件：幂等 --------------------------------------------------------
# 重复 add 会报错，直接吞掉该错误即可；真正的失败会在 setup 里暴露。
if ! dsh plugin --profile "${PROFILE}" list 2>/dev/null | grep -q 'dsh-superagent'; then
  log "安装 dsh-superagent bundle 到 profile '${PROFILE}'"
  dsh plugin --profile "${PROFILE}" add "link:${REPO_DIR}" \
    || log "插件安装报错，继续启动（面板会显示 setup 问题）"
else
  log "插件已安装，跳过"
fi

mkdir -p "${STATE_DIR}"

# 上一个容器被 recreate 时可能残留 stateDir 锁目录（proper-lockfile），新进程会报
# "Lock file is already being held" 而无法起 orchestrator。容器是全新的，这里的锁必为陈旧锁，清掉。
rm -rf "${STATE_DIR}.lock" 2>/dev/null || true

# --- 3b. 面板端口转发：容器网卡 IP:<port> -> 127.0.0.1:<port> ------------------
# 面板本身必须绑在 127.0.0.1（管理 API 要求 loopback）。宿主的 127.0.0.1:<port>
# 端口映射转发到容器网卡 IP:<port>，那里没人监听，所以在这里起一个转发器接收映射、
# 并转发到回环上的面板；转发时保留原始 Host 头，Host/Origin 白名单照常通过。
if [ "${PANEL_HOST}" != "127.0.0.1" ]; then
  PANEL_HOST="${PANEL_HOST}" SUPERAGENT_PORT="${PORT}" \
    sh -c 'while true; do node /usr/local/bin/panel-forward.mjs || true; sleep 2; done' &
  log "面板端口转发已启动：${PANEL_HOST}:${PORT} -> 127.0.0.1:${PORT}"
fi

# --- 4. 用上游脚本启动（保留 tmux，见 docs/adr/0001） -------------------------
log "通过 scripts/dsh-superagent 启动 tmux session ${SESSION}"
# 首次启动它可能报 setup 缺失，那是正常的第一步；退出码语义见 README。
"${REPO_DIR}/scripts/dsh-superagent" --profile "${PROFILE}" --url "http://127.0.0.1:${PORT}" start \
  || log "start 非零退出，请查日志；setup 可能仍待完成"

# --- 5. 前台保活，容器生命周期跟随 tmux session -------------------------------
log "保活中，面板端口 ${PORT}"
while tmux has-session -t "=${SESSION}" 2>/dev/null; do
  sleep 5
done
log "tmux session ${SESSION} 已结束，容器退出以便按 restart 策略重启"
exit 1
