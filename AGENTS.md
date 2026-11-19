# Working on agent-ready-uptime

Agent-ready uptime monitoring: one npm package, `agent-ready-uptime`, holding the checks and the runner on them.

## Layout

- `src/checks`: the checks (`http`, `agent`, `mcp`, `sitemap`, `net`, `domain`, `robots`), the shared judgements (`rules`), a check as data (`spec`), the site config's keys (`config`), webhooks, chart geometry, escaped HTML and test servers (`testing`). Imported by subpath: `agent-ready-uptime/checks/http/page-check`. [Sites in the Woods](https://sitesinthewoods.com) runs on them.
- `src`: the runner. `config` (monitor.config.json), `targets` (a site's checks), `runner` (discovery, the schedule, state), `judge` (what's news), `alerts` (Discord and Slack), `page` and `server` (the status page), `cli` and `bin`.
- `test`: vitest, against local fake sites only (`test/checks` for the checks).

## Rules

- **Node 26 or later**, ESM, TypeScript. Dependencies: `htmlparser2`, `saxes` and `zod`. Adding one needs a reason a few lines of code can't meet.
- **The checks never import the runner** (`src/checks` stands alone, as a library).
- **Every request goes through `fetchUrl`** (or a check built on it): private addresses refused, reads capped, patterns bounded. See SECURITY.md.
- **Alerts say what broke and nothing else.** No links but the site's own, no mentions, one message per alert.
- **The status page changes nothing.** GET only, escaped through `html` from `checks/html/template`.
- **The runner stays small.** It checks from one place and keeps 24 hours; history, confirmation from a second location, journeys and teams are a hosted service's job.
- **Writing:** plain, direct sentences. No em dashes.

## Releasing

1. Change `version` in `package.json`; add a CHANGELOG entry.
2. `npm run typecheck`, `npm test`, then `npx agent-ready-uptime check` against two or three real sites.
3. Publish a GitHub release tagged `v<version>`: the Release workflow tests and publishes to npm through trusted publishing, and the Image workflow pushes the Docker image.
