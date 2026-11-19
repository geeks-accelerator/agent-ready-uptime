# Contributing

Issues and pull requests are welcome. The runner stays small on purpose: one place, a webhook, a state file and a page. A feature that needs history, a second location or accounts belongs in a hosted service, not here.

## Layout

- `packages/checks` (`agent-ready-checks`): the code that inspects a site. One request at a time, a plain result back. [Sites in the Woods](https://sitesinthewoods.com) runs on the same package.
- `packages/uptime` (`agent-ready-uptime`): the runner. Config, schedule, judging, alerts, state and the status page.

## Changing a check

1. Write a test first, against a local site (`testServer` and `fakeMcpServer` in `packages/checks/src/testing`), and watch it fail. Tests never reach the outside network.
2. Keep the safety rules in [SECURITY.md](SECURITY.md): requests go through `fetchUrl`, private addresses stay refused, reads stay capped and patterns bounded.
3. If an MCP or DNS fingerprint's recipe changes, bump `FINGERPRINT_VERSION`, so stored fingerprints are replaced quietly instead of alerting.
4. `npm test` and `npm run typecheck`, then run `npx agent-ready-uptime check` against two or three real sites and read the output.
5. Add a CHANGELOG entry.

## Writing

Plain, direct sentences. Alerts say what broke and nothing else.
