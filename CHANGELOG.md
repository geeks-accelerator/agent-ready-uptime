# Changelog

## 0.5.0

- `measureHtml` counts two more parts of a page's HTML: `inlineStyleBytes` (inside `<style>` and in `style=""` attributes) and `imageMarkupBytes` (the `<img>`, `<picture>` and `<source>` tags themselves, `srcset` and `sizes` included), on the parse it already makes. A heavy page is usually one of these, inline scripts and data, or inline SVG.

## 0.4.0

- `check` reports for people: failures first on stderr, each with why, then a count (`All 31 checks passed.`). The JSON lines on stdout are unchanged.
- In GitHub Actions (`GITHUB_ACTIONS=true`), `check` also writes a table of every check to the run's summary (`$GITHUB_STEP_SUMMARY`, cut past 100 rows with a count) and an `::error` annotation per failure.
- Exit codes: 0 all passed, 1 a check failed, 2 the run itself failed. A crash now exits 2 (it was 1), so CI can tell a broken run from a failing site.
- `check` no longer says "No alerts configured" (it never serves a page).
- The README's CI section: a short workflow, and checking a Vercel preview.

## 0.3.0

- Generic webhooks: a `webhook` alert kind posts each alert as versioned JSON to any public HTTPS endpoint, signed by [Standard Webhooks](https://www.standardwebhooks.com/). Config: `{ "kind": "webhook", "env": "WEBHOOK_URL", "secretEnv": "WEBHOOK_SECRET" }`, or `WEBHOOK_URL` and `WEBHOOK_SECRET` beside `SITES`; `agent-ready-uptime secret` prints a new secret.
- `checks/webhook`: `WEBHOOK_KINDS` gains `"webhook"` (checked by shape: HTTPS, a name not a raw IP, no user info, at most 2,048 characters), `signWebhook`, `webhookHeaders`, `newWebhookSecret`, and `publicFetch`, a `fetch` over `fetchUrl` that refuses private addresses after resolving and never follows redirects. `postWithRetries` answers a private address at once instead of retrying.

## 0.2.0

- Four newer agent files can be checked: an API catalog (RFC 9727, `/.well-known/api-catalog`), an agent skills index (`/.well-known/agent-skills/index.json`), an AI catalog (`/.well-known/ai-catalog.json`, or `/.well-known/ard.json`) and an MCP server card (`/.well-known/mcp/server-card.json`). Each has a validator, a label and a path; `discoverAgentFiles` reads them when asked (`kinds`), and by default still reads only the settled files (`DISCOVERED_FILE_KINDS`), so a running monitor makes no new requests.
- `llmsTxtLinks`: an llms.txt's links on its own site, for checking that they answer.
- `organizationFacts`: what a page's structured data says about who runs the site (a name, description, logo, `sameAs` profiles, a contact), as closed facts.

## 0.1.2

- Times in alerts show in each reader's own timezone: a recovery's "Since" and an expiry's "On" use Discord's `<t:…>` and Slack's `<!date^…>` (Slack falls back to UTC text). Logs still say UTC.
- The README on npm gains the Railway template link.

## 0.1.1

- `init` adds an alert only for a webhook variable that's set (`DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`). 0.1.0 always added a Discord one, so `check` and `watch` refused to run until it was set.
- The Docker image (`ghcr.io/geeks-accelerator/agent-ready-uptime`) is built for amd64 and arm64; the first build was amd64 only, so it didn't pull on Apple Silicon or ARM servers.
- A [Railway template](https://railway.com/deploy/agent-ready-uptime): set `SITES` (and a webhook, if you like) and deploy.
- Released through npm trusted publishing (staged, approved by a maintainer), with provenance.

## 0.1.0

The first release: the runner (watch and check modes, Discord and Slack alerts, a state file and a status page) and its checks, usable as a library (`agent-ready-uptime/checks/…`), the same ones Sites in the Woods runs on.
