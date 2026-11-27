# 容器内保留 tmux

dsh-superagent 以容器方式部署，但容器内仍然运行 tmux，而不是让 `dsh --profile superagent` 直接做 PID 1。

插件的运维面（`scripts/dsh-superagent` 的 start / stop / status / restart）完全建立在 tmux session 之上，上游文档里的启动检查、四种退出码语义、排障表和每小时巡检 prompt 也都以它为前提。把 tmux 从容器里去掉，能让容器更"原生"，但同时会让上述整套运维约定失效，需要另写一套等价的状态与重启机制，并长期跟随上游变更。这里选择保住上游脚本的可用性，代价是容器内多一个 tmux 进程、入口脚本多一层间接。

因此：**改 podman、改 systemd、或把 dsh 提升为 PID 1 之前，先确认 `scripts/dsh-superagent` 已被等价物取代**，否则巡检与重启流程会静默失灵。
