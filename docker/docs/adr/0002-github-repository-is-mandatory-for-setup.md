# setup 强制要求一个可推送的 GitHub 仓库，飞书只是附加通道

dsh-superagent 的启动检查 `resolveDeployment()` 会**无条件**校验 GitHub 来源：没有仓库就抛 `repositoryUnset`，没有可用的 agent `gh` CLI 就抛 `agentCliUnset`/`agentCliSignedOut`，仓库不可推送就抛 `repositoryReadOnly`。而 `src/app/setup.ts` 的 `resolve()` 里，GitHub 的解析失败会直接中断整个 setup（飞书的解析才被 try/catch 包成可选）。

这意味着：**不存在「只启用飞书、不配 GitHub」的部署形态。** 把 `dsh-superagent-github` 设成 `disabled: true` 不会让它被跳过，反而使 `settings.sources.github` 缺失，从而必现 `repositoryUnset`，全局 setup 永不通过，`ctx.deployment` 不生成，飞书来源永远停在 `setupPending`。

因此任何希望飞书链路可用的部署，都必须同时提供一个 agent 可**读且可推送**的 GitHub 仓库和一份 agent `gh` 凭据。若确实要纯飞书运行，只能改动上游 `resolve()`/`resolveDeployment()` 让 GitHub 变成可选，并相应处理 `writeEnvironment`/`verifyEnvironment` 对 `github`、`repository` 的依赖——属于对上游的侵入式改造，不建议在测试期做。
