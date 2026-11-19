# agent-ready-uptime

Agent-ready uptime monitoring, open source: uptime, TLS and domain expiry, sitemaps, llms.txt, AI crawler access and MCP tool changes, with alerts to Discord or Slack and a status page.

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
| The domain's registration (RDAP) | daily | 30, 14, 7 and 1 days before it expires |
| Sitemaps (from robots.txt, `/sitemap.xml`, `/sitemap.json`) | every 30 minutes | one stops parsing or lists fewer URLs than `minUrls` |
| Agent files: `llms.txt`, agent card, OpenAPI, MCP manifest, `robots.txt`, `security.txt` | hourly | one that was valid stops being valid (an HTML fallback served as `llms.txt` fails) |
| The MCP server (from `/.well-known/mcp.json`, or configured) | hourly | the handshake fails, or its tools change: "removed `adopt`; added `adopt_v2`" |
| AI crawler access: the homepage and `llms.txt` fetched as Googlebot, Bingbot, GPTBot, ClaudeBot, PerplexityBot and others | hourly | a crawler that got in is turned away |
| TCP ports and DNS records (configured) | every minute / 15 minutes | a port stops answering; a record set changes or loses an expected value |

A file or crawler the site never served isn't an alert (that's the site's choice); one we've watched that goes away is. While a site's homepage is down, its other checks don't alert on their own: they fail because it does.

Requests identify themselves as `agent-ready-uptime (+https://github.com/geeks-accelerator/agent-ready-uptime)` (set `MONITOR_USER_AGENT` to name your own), send no cookies or credentials, and refuse private and loopback addresses, so a config can't point it at your internal network.

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
- Webhook URLs are secrets: name the environment variable (`env`) rather than putting the URL in the file. Only Discord's and Slack's own webhook hosts are accepted.

No file? `SITES=https://a.example,https://b.example` with `DISCORD_WEBHOOK_URL` and/or `SLACK_WEBHOOK_URL` is a whole config.

## Running it

- `watch`: checks on schedule, serves the status page (`--port`, default 8080 or `PORT`; `--host`, default 127.0.0.1 or `HOST`; `--no-page`), and prints one JSON line per check and per alert.
- `check`: one pass of every check, then exits 1 if anything is failing, 0 if not. With the same `--state` file it's a whole monitor from cron or a scheduled GitHub Action: a failure still has to repeat before it alerts, and a recovery still says so.
- State lives in `.agent-ready-uptime/state.json` (`--state`, or `STATE_PATH`): last results, MCP tool lists and DNS records, and the graph's last 24 hours. A restart picks up where it left off without alerting again.

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
| `domain/rdap` | a domain's expiry, registrar and status from RDAP |
| `robots` | robots.txt parsed by RFC 9309 with Google's precedence; what each AI crawler may read |
| `spec` | a check as data (`CheckSpec`), run by `runSpec`, validated by `specSchema` |
| `rules` | when a failure is news (three in a row for a page) and when an expiry is announced |
| `config` | a site's config keys (zod), shared with the hosted service |
| `webhook` | Discord and Slack webhook URLs checked by host; posting with retries |
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
