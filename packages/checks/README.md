# @geeks-accelerator/agent-ready-checks

The checks behind [agent-ready uptime monitoring](../../README.md): one request at a time, each returning a plain result. Used by `agent-ready-uptime` and by the hosted [Sites in the Woods](https://sitesinthewoods.com), so a fix to a check helps both.

```ts
import { checkPage } from "@geeks-accelerator/agent-ready-checks/http/page-check";
import { checkMcp } from "@geeks-accelerator/agent-ready-checks/mcp/check";
import { discoverAgentFiles } from "@geeks-accelerator/agent-ready-checks/agent/discover";

const home = await checkPage("https://example.com/", { keyword: "Welcome" });
console.log(home.ok, home.timings.ttfbMs, home.tls?.validTo);

const mcp = await checkMcp("https://example.com/mcp");
console.log(mcp.ok, mcp.fingerprint); // the fingerprint changes when a tool is renamed, removed or changes shape
```

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

## Safety

- Private, loopback and link-local addresses (raw IPs included) are refused, checked on the address each request actually connects to. `MONITOR_ALLOW_LOCAL=1` allows local URLs for tests; never set it when deployed.
- No cookies or credentials are sent. `fetchOnHost` (and `checkPage`'s `sameHost`) follow redirects only on the site's own host, for callers that must not leave it.
- Bodies are read up to a cap, and every pattern run over a body is bounded, so a hostile site can't stall a check.
- `FINGERPRINT_VERSION` prefixes every fingerprint: if its recipe changes, the version changes, and stored fingerprints are replaced quietly instead of alerting.

Report a security problem privately: see [SECURITY.md](../../SECURITY.md).

## License

MIT
