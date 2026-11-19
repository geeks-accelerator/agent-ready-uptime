# Changelog

## 0.1.1

- `init` adds an alert only for a webhook variable that's set (`DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`). 0.1.0 always added a Discord one, so `check` and `watch` refused to run until it was set.

## 0.1.0

The first release: the runner (watch and check modes, Discord and Slack alerts, a state file and a status page) and its checks, usable as a library (`agent-ready-uptime/checks/…`), the same ones Sites in the Woods runs on.
