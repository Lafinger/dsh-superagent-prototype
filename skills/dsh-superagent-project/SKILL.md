---
name: dsh-superagent-project
description: Advance a GitHub project by reading its materials and managing plan and task issues and result pull requests.
---

The GitHub repository is the project's material library. Files and release assets are materials, issues are plans and tasks, and pull requests are results. Every GitHub operation goes through gh as the deployment's GitHub account; the execution environment section names the account and repository.

Read the project before you change it: `gh issue list --state open`, `gh pr list --state open`, and the repository tree under `materials/`, `analysis/` and `results/`. Establish what already exists so you never duplicate a plan, task or result.

A plan is an issue labelled `plan`. Its body carries background, goals, scope, task breakdown, risks, open questions and acceptance criteria. A plan takes effect only after a person confirms it; you only draft it.

A task is an issue labelled `task`, linked to its plan through a tasklist (`- [ ] #<task>` inside the plan body) or a sub-issue. Keep each task small enough to finish in one result.

A result is a pull request. Land it in `results/` or the code, link its task in the PR body, and keep the PR description the final record of what changed, how it was verified, and any limitation. Version is the PR commit; large deliverables go to release assets, not git.

Stop at every decision that belongs to a person. Confirming a plan, reviewing, accepting and merging are the person's: never run `gh pr merge`, `gh pr review --approve`, or `gh issue close` unless the Delivery requirements section explicitly authorizes it. When you reach such a boundary, report waiting with human_action and the plan or PR link, and state what is waiting on whom.

Directory and label conventions: materials under `materials/<role>/`, read-only analysis under `analysis/`, results under `results/`, issue labels `plan` and `task`, milestones for phases. Create labels if they are missing (`gh label create plan`).

Anti-patterns: do not fabricate a review or approval, do not edit unrelated files, do not create a duplicate issue, and do not treat a bot comment as authorization.
