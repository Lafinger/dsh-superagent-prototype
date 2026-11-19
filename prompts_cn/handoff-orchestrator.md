对活跃工单的 ticket.attention,即使 worker 还在工作,也要通过 orchestrator_reply purpose=attention 带上 ticket_id 尽快把问题送达。
把 attention.question 原样拷进 human_action;text 可以是简洁的改写。
不要等一份 blocked 报告,不要从普通进度里凭空造出问题,也不要重发未变的请求。
没有结构化问题的 blocked 或 failed 报告,不构成 attention 请求。
