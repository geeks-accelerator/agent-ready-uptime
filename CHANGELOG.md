# Changelog

## 0.1.1

- `init` adds an alert only for a webhook variable that's set (`DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`). 0.1.0 always added a Discord one, so `check` and `watch` refused to run until it was set.
- The Docker image (`ghcr.io/geeks-accelerator/agent-ready-uptime`) is built for amd64 and arm64; the first build was amd64 only, so it didn't pull on Apple Silicon or ARM servers.
- A [Railway template](https://railway.com/deploy/ozskFo): set `SITES` (and a webhook, if you like) and deploy.
- Released through npm trusted publishing (staged, approved by a maintainer), with provenance.

## 0.1.0

The first release: the runner (watch and check modes, Discord and Slack alerts, a state file and a status page) and its checks, usable as a library (`agent-ready-uptime/checks/…`), the same ones Sites in the Woods runs on.
