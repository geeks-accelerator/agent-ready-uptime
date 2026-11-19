# Working on agent-ready-uptime

Agent-ready uptime monitoring: a checks package and a small runner, in one npm workspace.

## Layout

- `packages/checks/src`: the checks (`http`, `agent`, `mcp`, `sitemap`, `net`, `domain`, `robots`), the shared judgements (`rules`), a check as data (`spec`), the site config's keys (`config`), webhooks, chart geometry and escaped HTML. Imported by subpath: `agent-ready-checks/http/page-check`.
- `packages/uptime/src`: `config` (monitor.config.json), `targets` (a site's checks), `runner` (discovery, the schedule, state), `judge` (what's news), `alerts` (Discord and Slack), `page` and `server` (the status page), `cli`.
- `packages/*/test`: vitest, against local fake sites only.

## Rules

- **Node 26 or later**, ESM, TypeScript. Dependencies: `htmlparser2`, `saxes` and `zod`. Adding one needs a reason a few lines of code can't meet.
- **Every request goes through `fetchUrl`** (or a check built on it): private addresses refused, reads capped, patterns bounded. See SECURITY.md.
- **Alerts say what broke and nothing else.** No links but the site's own, no mentions, one message per alert.
- **The status page changes nothing.** GET only, escaped through `html` from `html/template`.
- **The runner stays small.** It checks from one place and keeps 24 hours; history, confirmation from a second location, journeys and teams are a hosted service's job.
- **Writing:** plain, direct sentences. No em dashes.

## Releasing

1. Change `version` in the package's `package.json` (and the runner's dependency on the checks package when that changed).
2. CHANGELOG entry; `npm test`; `npx agent-ready-uptime check` against real sites.
3. Publish a GitHub release tagged `checks-v<version>` or `uptime-v<version>`; the Release workflow tests and publishes that package to npm through trusted publishing.
