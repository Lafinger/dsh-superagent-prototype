每个改动 UI 的工单,PR 描述必须同时包含 Before 和 After 两份视觉证据,清楚标注,并说明基线版本与改动后的版本。
场景、视口、主题和相关 UI 状态要一致,比较才有意义;截图或演示视频都可以。
只有 After 的证据是不完整的。
用应用的真实截图,不要拿设计稿充当"之前的实现";不要暴露飞书私密内容或凭据。
后续 UI 改动使其过期时,要更新对比。
如果没有真实基线截图,就如实说明缺失的证据与限制,保持交班为未完成,不要声称该 UI PR 已 ready。
worker 负责采集和验证对比;主控在交付 ready 结果之前检查所报告的证据。

按匹配规则、分配、这些提示或仓库指令的要求去请求评审。
绝不要以 agent 账号身份开启自动合并,以免 agent 合并自己的成果:只有本节点名的 merge CLI 才可开启,形如 `<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha> --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY`。
本节没有点名 merge CLI 时,每个 PR 都由人来合并。
若有 merge CLI,当你从工单分支开出的 PR 同时满足以下条件时,为该 PR 的头提交开启自动合并:PR 已 ready;改动少于 200 行(增+删);指令要求的每个批准都覆盖该提交;若它改变用户可见内容,指令点名了由谁批准此类改动,且该批准覆盖该提交。
报 ready 时不必等批准;批准到了再开自动合并。
否则由人合并该 PR;在你的报告里说明这一点。
一旦任一条件不再成立(例如评审要求修改),以及在向该 PR 推送之前,用 `<merge CLI> pr merge <number> --disable-auto --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY` 撤回自动合并;等新头提交满足条件后再重新开启。
绝不代替评审者批准或合并。
每个为你开出的 PR 做过评审的人,每个 PR 记一次,记在 PR 分支的每个提交上:当第一次评估某位人工评审者对该 PR 的反馈时,重写该分支,使它的每个提交都带有"截至目前已记入的每个人一条"的 `Co-authored-by: <姓名或登录名> <id+登录名@users.noreply.github.com>` 尾注,id 取自 `gh api users/<login> --jq .id`。
先按上面的办法撤回自动合并。

运行 `git fetch origin`;用 `gh pr view <number> --json baseRefName` 得到的基分支设置 `base=$(git merge-base HEAD origin/<基分支>)`,并设置 `old=$(git rev-parse origin/<头分支>)`;然后运行 `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD`,每个已记入的人一条 `--trailer`,它只改提交信息;再用 `git push --force-with-lease=<头分支>:$old` 推送;若推送被拒,停下并报告。
你之后新增的提交也带同样的尾注。
对某个提交的批准,也覆盖它被重写后的副本(树相同)。
若 PR 已合并,不要重写;把未记入的评审者写进 orchestrator_report。
绝不为了记入评审者而推一个空提交。
不要记入机器人(登录名以 [bot] 结尾的,以及本指令点名的评审机器人账号)、PR 作者、agent 账号,或本指令点名的提交作者——后者已作为每个提交的作者被记入。
把你记入过的人写进 orchestrator_report,以免后续 worker 重复记入。
如果人也在处理同一问题,且其分支或 PR 含有本工单的代码(来自工单分支的提交,或其改动被带过去),立刻用 gh 关闭本工单的 PR,不必问任何人,并在上面留一句点名那个人 PR 的说明。
只是相关、或不含本工单代码的工作,不是关闭的理由。
关闭该 PR 即结束工单;不要再发别的消息。
