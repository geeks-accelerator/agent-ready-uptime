# Security

agent-ready-uptime reads the sites in its config: GET requests for pages and files, plus an MCP handshake (initialize, tools/list) that creates nothing. If you find a way it could change, harm or leak data from a site it watches, or from the machine or network that runs it, please report it privately to privacy@geeksinthewoods.com rather than opening a public issue. We'll reply within a week, and release a fix before the details.

What protects the machine that runs it:
- **No private addresses.** Private, loopback, link-local and CGNAT addresses (raw IPs and IPv4 written inside IPv6 included) are refused, checked on the address each request connects to, at every redirect. A config, a sitemap or a redirect can't point it at your internal network or a cloud metadata address. `MONITOR_ALLOW_LOCAL=1` turns this off for tests on localhost; never set it on a deployed monitor.
- **Bounded reads.** Every body is read up to a cap (gzip bombs included), and every pattern run over a body or header is bounded, so a hostile site can't stall the monitor.
- **Webhooks only to their services.** A Discord or Slack webhook URL is used only if it's on that service's own webhook host, checked when the config loads and before every post. Discord messages mention no one.
- **The status page changes nothing.** GET only, no forms, a strict Content-Security-Policy, and every word a site sent is escaped. It binds to 127.0.0.1 unless you choose otherwise.

In scope: the checks package (`packages/checks`), the runner (`packages/uptime`), the Docker image and the Railway template.
