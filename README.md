# agent-ready-uptime

Agent-ready uptime monitoring, open source: uptime, TLS and domain expiry, sitemaps, llms.txt, AI crawler access and MCP tool changes, with alerts to Discord, Slack or any webhook and a status page.

Made by [Sites in the Woods](https://sitesinthewoods.com), which runs these same checks as a hosted service: every outage confirmed from a second region, 400 days of history, AI agents walking through your site's real tasks, and team dashboards. This is the free part you host yourself.

Most monitors ask whether your homepage answers. This one also watches what AI agents and crawlers meet: your `llms.txt`, agent card, OpenAPI and MCP manifest, whether GPTBot, ClaudeBot and the rest can still get in, and whether your MCP server's tools were renamed, removed or changed shape. An agent that called `adopt` yesterday fails today if it's now `adopt_v2`; this tells you first.

```bash
export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…   # or SLACK_WEBHOOK_URL; optional
npx agent-ready-uptime init https://your.site
npx agent-ready-uptime watch
```

Then open <http://127.0.0.1:8080/> for the status page. Node 26 or later. Or [deploy it on Railway](https://railway.com/deploy/agent-ready-uptime) in a minute.

## What it checks

For each site, with no configuration beyond its URL:

| Check | How often | It alerts when |
|---|---|---|
| The homepage (status, keyword, final URL; first-byte time) | every minute | it fails three times in a row (retried after 1 minute, then 5), and when it's back |
| The TLS certificate | with the homepage | 14 and 3 days before it expires |
| The domain's registration (RDAP) | daily | 30, 14, 7 and 1 days before it expires; when it expired and only the registry renewed it (the registrar may not have been paid); a hold, redemption or pending delete; a registrar lock removed; nameservers moved to a parking host |
| Sitemaps (from robots.txt, `/sitemap.xml`, `/sitemap.json`) | every 30 minutes | one stops parsing or lists fewer URLs than `minUrls` |
| Agent files: `llms.txt`, agent card, OpenAPI, MCP manifest, `robots.txt`, `security.txt` | hourly | one that was valid stops being valid (an HTML fallback served as `llms.txt` fails) |
| The MCP server (from `/.well-known/mcp.json`, or configured) | hourly | the handshake fails, or its tools change: "removed `adopt`; added `adopt_v2`" |
| AI crawler access: the homepage and `llms.txt` fetched as Googlebot, Bingbot, GPTBot, ClaudeBot, PerplexityBot and others | hourly | a crawler that got in is turned away |
| TCP ports and DNS records (configured) | every minute / 15 minutes | a port stops answering; a record set changes or loses an expected value |

A file or crawler the site never served isn't an alert (that's the site's choice); one we've watched that goes away is. While a site's homepage is down, its other checks don't alert on their own: they fail because it does.

Requests identify themselves as `agent-ready-uptime (+https://github.com/geeks-accelerator/agent-ready-uptime)` (set `MONITOR_USER_AGENT` to name your own), send no cookies or credentials, and refuse private and loopback addresses, so a config can't point it at your internal network.

**Signed requests (Web Bot Auth).** A user agent is a claim anyone can copy, so CDNs that check bots (Cloudflare among them) verify signatures instead. Run `agent-ready-uptime signing-key`, set the key it prints as `MONITOR_SIGNING_KEY`, and set `MONITOR_SIGNATURE_AGENT` to the https origin where your status page is served: every monitor request then carries a signature, and the status page serves its key directory at `/.well-known/http-message-signatures-directory`. Crawler probes never sign, since they test how a site treats a crawler's name. Register the origin with your CDN's verified bot program if you want it allowed by name.

## Configuration

`monitor.config.json` (`init` writes one; `npx agent-ready-uptime schema` prints its JSON schema, and editors pick it up from `$schema`):

```json
{
  "$schema": "https://unpkg.com/agent-ready-uptime/monitor.config.schema.json",
  "sites": [
    {
      "slug": "example",
      "name": "Example",
      "url": "https://example.com",
      "homepage": { "keyword": "Welcome" },
      "agent": { "mcp": "/mcp", "exclude": ["crawler:GPTBot"] },
      "ports": [{ "name": "Mail", "host": "mail.example.com", "port": 465, "tls": true }],
      "dns": [{ "name": "example.com", "type": "MX" }]
    }
  ],
  "alerts": [
    { "kind": "discord", "env": "DISCORD_WEBHOOK_URL" },
    { "kind": "slack", "env": "SLACK_WEBHOOK_URL" }
  ]
}
```

- `sitemaps: false` or `agent: false` switches those off for a site; `sitemaps: { "urls": ["/sitemap.xml"], "minUrls": 10 }` names them instead of discovering.
- `homepage`: `url` (a health endpoint instead of `/`), `keyword`, `keywordAbsent`, `expectedStatus`, `expectedFinalUrl`, `confirmFailures`, `timeoutMs`, `intervalSeconds`.
- `agent`: `paths` (files at non-standard places), `mcp`, `exclude` (`"llms_txt"`, `"mcp"`, `"crawler:GPTBot"`), `crawlers` (more user agents), `intervalSeconds`.
- `defaults`: how often each kind runs (`homepageIntervalSeconds`, `agentIntervalSeconds`, `sitemapIntervalSeconds`, `portIntervalSeconds`, `dnsIntervalSeconds`) and timeouts.
- Webhook URLs are secrets: name the environment variable (`env`) rather than putting the URL in the file. Discord and Slack: only their own webhook hosts are accepted.
- `{ "kind": "webhook", "env": "WEBHOOK_URL", "secretEnv": "WEBHOOK_SECRET" }` posts each alert as JSON to any public HTTPS endpoint (Zapier, Make, n8n, your own), signed by [Standard Webhooks](https://www.standardwebhooks.com/) (`webhook-id`, `webhook-timestamp`, `webhook-signature`), so its libraries verify it in any language. `npx agent-ready-uptime secret` makes a secret. The body is `{ type: "alert.down", version: 1, id, at, kind, site, target, title, detail, url }`; `title` and `detail` can quote a site, so treat them as text. A private address is refused after resolving, and redirects aren't followed.

No file? `SITES=https://a.example,https://b.example` with `DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL` and/or `WEBHOOK_URL` (with `WEBHOOK_SECRET`) is a whole config.

## Running it

- `watch`: checks on schedule, serves the status page (`--port`, default 8080 or `PORT`; `--host`, default 127.0.0.1 or `HOST`; `--no-page`), and prints one JSON line per check and per alert.
- `check`: one pass of every check. Failures are listed first on stderr, each with why, then a count. It exits **0** when everything passed, **1** when a check failed, and **2** when the run itself failed (bad arguments or config, a crash), so a build can retry a broken run without hiding a real failure. With the same `--state` file it's a whole monitor from cron or a scheduled GitHub Action: a failure still has to repeat before it alerts, and a recovery still says so.
- State lives in `.agent-ready-uptime/state.json` (`--state`, or `STATE_PATH`): last results, MCP tool lists and DNS records, and the graph's last 24 hours. A restart picks up where it left off without alerting again.

### In CI

Stop a deploy when the site is down, `llms.txt` is gone, an AI crawler is newly refused or an MCP server's tools changed:

```yaml
name: Site checks
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 26 }
      - run: npx agent-ready-uptime@0.4.0 check
        env: { SITES: "https://example.com" }
```

In GitHub Actions, `check` also writes a table of every check to the run's summary page and marks each failure on the run (`::error`), with no flag to set.

To check a preview before it goes live, run it after the deployment and pass the preview's URL. On Vercel, a [`repository_dispatch`](https://vercel.com/guides/how-can-i-run-end-to-end-tests-after-my-vercel-preview-deployment) on `vercel.deployment.success` carries it:

```yaml
on:
  repository_dispatch:
    types: [vercel.deployment.success]
jobs:
  check:
    if: github.event.client_payload.environment == 'preview'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 26 }
      - run: npx agent-ready-uptime@0.4.0 check
        env: { SITES: "${{ github.event.client_payload.url }}" }
```

A preview's robots.txt and agent files often differ from production on purpose (previews are usually kept out of search), so check the files that matter there, or check production right after it deploys.

### Docker

```bash
docker run -d -p 8080:8080 -e HOST=0.0.0.0 -e SITES=https://example.com \
  -e DISCORD_WEBHOOK_URL=… -v aru:/app/.agent-ready-uptime ghcr.io/geeks-accelerator/agent-ready-uptime
```

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/agent-ready-uptime)

Set `SITES` (and, if you like, `DISCORD_WEBHOOK_URL` or `SLACK_WEBHOOK_URL`) and deploy: the service's public URL is your status page. The template runs the published image with a volume for the state file, a health check and restarts.

## The status page

One plain page: each site up or down and since when, its latest first byte, a 24-hour response-time graph (from zero, gaps left as gaps), TLS and domain days left, and each check, with the MCP server's tool count and when it last changed. It refreshes itself every 30 seconds, works without JavaScript, follows the system's light or dark mode, and has nothing on it that changes anything.

It binds to 127.0.0.1 by default. It lists the sites you watch, so exposing it (`--host 0.0.0.0`) is your choice.

## What it doesn't do

It checks from one place (yours), keeps 24 hours, and sends one message per alert. [Sites in the Woods](https://sitesinthewoods.com) is the hosted version, built on the same checks: it confirms an outage from a second region before anyone's alerted, keeps 400 days of history with likely causes, sends AI agents through your site's real tasks (journeys), grades your API's errors for a way forward, and adds email, push, teams and public status pages.

## The checks, as a library

The checks the runner uses are in the same package, one request at a time, each returning a plain result. [Sites in the Woods](https://sitesinthewoods.com) runs on them too, so a fix to a check helps both.

```ts
import { checkPage } from "agent-ready-uptime/checks/http/page-check";
import { checkMcp } from "agent-ready-uptime/checks/mcp/check";

const home = await checkPage("https://example.com/", { keyword: "Welcome" });
console.log(home.ok, home.timings.ttfbMs, home.tls?.validTo);

const mcp = await checkMcp("https://example.com/mcp");
console.log(mcp.ok, mcp.fingerprint); // changes when a tool is renamed, removed or changes shape
```

Each module is `agent-ready-uptime/checks/<module>`:

| Module | What it does |
|---|---|
| `http/request` | `fetchUrl`: one request with DNS, connect, TLS and first-byte timings, the certificate's expiry, a size cap, and private addresses refused |
| `http/page-check` | `checkPage`: a page judged (status, keyword, final URL, title and noindex, an agent file's format) |
| `http/same-host` | `fetchOnHost`: redirects followed only on the site's own host |
| `agent/discover`, `agent/validate` | find and validate `llms.txt`, the agent card, OpenAPI, the MCP manifest, `robots.txt` and `security.txt`; the crawler probes |
| `mcp/check`, `mcp/diff` | an MCP handshake and tool list, fingerprinted; what changed between two lists |
| `sitemap/fetch`, `sitemap/parse` | discover, fetch and parse XML, news and JSON sitemaps and indexes, gzip included, with size caps |
| `net/port`, `net/dns` | a TCP (and TLS) port check; a record set asked of the zone's own nameservers |
| `domain/rdap` | a domain's expiry, registrar and status from RDAP (`noRdap` when its registry has no RDAP service) |
| `domain/registration` | what a registration change means (`judgeRegistration`): a renewal the registrar made, or only the registry's own after expiry; bad statuses, removed locks, parking nameservers |
| `robots` | robots.txt parsed by RFC 9309 with Google's precedence; what each AI crawler may read |
| `agents` | the AI agents that read websites, by purpose (training, search, a person's question), each from its operator's docs |
| `spec` | a check as data (`CheckSpec`), run by `runSpec`, validated by `specSchema` |
| `rules` | when a failure is news (three in a row for a page) and when an expiry is announced |
| `config` | a site's config keys (zod), shared with the hosted service |
| `webhook` | Discord and Slack webhook URLs checked by host, generic ones by shape; posting with retries; Standard Webhooks signing (`signWebhook`, `webhookHeaders`); `publicFetch`, a `fetch` that never reaches a private address |
| `chart`, `format`, `html/template` | a line's geometry with gaps kept, round axes, response times in words, escaped HTML |
| `testing/servers`, `testing/fake-mcp` | local sites and an MCP server for tests |

### Safety

- Private, loopback and link-local addresses (raw IPs included) are refused, checked on the address each request actually connects to. `MONITOR_ALLOW_LOCAL=1` allows local URLs for tests; never set it when deployed.
- No cookies or credentials are sent. `fetchOnHost` (and `checkPage`'s `sameHost`) follow redirects only on the site's own host, for callers that must not leave it.
- Bodies are read up to a cap, and every pattern run over a body is bounded, so a hostile site can't stall a check.
- `FINGERPRINT_VERSION` prefixes every fingerprint: if its recipe changes, the version changes, and stored fingerprints are replaced quietly instead of alerting.

[`readiness-audit`](https://github.com/geeks-accelerator/agent-and-search-readiness) scores a site once against the Agent and Search Readiness Standard; this watches it. The audit tells you once; the monitor tells you when it breaks. Report a security problem privately: see [SECURITY.md](SECURITY.md).

## License

MIT
