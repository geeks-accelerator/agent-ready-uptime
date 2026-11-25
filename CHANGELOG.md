# Changelog

## 0.11.0

- `measureHtml` counts data blocks apart from scripts: `<script>` tags of type `application/ld+json`, `application/json`, `importmap` and `speculationrules` never run, so they're `dataBlocks` and `dataBytes`, no longer in `scripts` or `inlineScriptBytes`. `__NEXT_DATA__` stays with the scripts, as repeated page data (`frameworkBytes`). Speculation rules are still read.
- `HtmlWeight.cdnScripts` and `cdnScriptOf(src)`: scripts Cloudflare adds to a page, by closed name (`CDN_SCRIPTS`: `email_protection`, `rocket_loader`, `web_analytics`, `challenge`, `other`), recognised by `/cdn-cgi/` on the site or Cloudflare's analytics host. They still count in `scripts`; the name lets a report say who added them.
- `SitemapFetchResult.stylesheet` and `usesXslt(body)`: a sitemap that asks browsers to style it with XSLT. Chrome 158 (2026-11-17) no longer runs XSLT, so people opening it see unstyled XML; crawlers never used it. A CSS stylesheet isn't counted.
- `TlsInfo.validFrom`, beside `validTo`, from page and port checks alike: a certificate's lifetime, which says when a self-renewing one should have renewed.

## 0.10.1

- `judgeChain` never calls a redirect from the site's root `temporary`: `/` sending each visitor to their language or region (`/` → `/en`, often a 307) depends on who asks, so it's temporary on purpose. A root that takes more than one redirect is still a `chain`.

## 0.10.0

- Every redirect is recorded as a step (`Hop`, made by `hopOf` in `fetchUrl`, `fetchOnHost` and the test fetchers alike): its address, status, cache answer (`cacheOf`: Cloudflare's `cf-cache-status`, then `x-nextjs-cache`, then `x-vercel-cache`, kept only from the closed list `CACHE_STATES`) and whether its `X-Robots-Tag` said noindex. `FetchResult.redirects` entries carry them.
- `PageCheckResult.hops`: the redirects and the last response as one path (empty without a redirect), so an alert can say which step failed instead of giving one status for three responses.
- `judgeChain(hops)` in `checks/rules`: a step that failed after a redirect (`hop_failed`), a step marked noindex on the way (`through_noindex`), a temporary 302, 303 or 307 to another path on the site (`temporary`), or more than one redirect (`chain`). The HTTPS and `www.` hop to the same path is free, and a redirect to a sign-in page is fine. `CHAIN_CONFIRM` (3): checks in a row before it's news.
- `chainWords(hops, place?)` in `checks/format`: "307 (cache HIT) → /old/preview 404 (cache HIT)". The runner's failing and down alerts add it as "Path: …".
- `isLoginPath` in `checks/url`.

## 0.9.0

- `confirmChange(stored, pending, now, at)` in `checks/rules`: a fingerprint that differs from the stored one (an MCP server's tools, a DNS record set) is held until the same new value is read `CHANGE_CONFIRM` times in a row (3: the read that saw it and its retries after 1 and 5 minutes, `PAGE_RETRIES`). A read back to the stored one is a blip, never announced; another new value starts the count again; a new recipe is never an edit (`sameRecipe`). The runner retries a pending change on that schedule and keeps it in the state (`pendingChange`).
- `confirmWords`: how a failure or change was confirmed, in one line ("3 times over 6 minutes, from US West and US East", "2 days running"). Down, failing and changed alerts carry it as `confirmed`; `alertDetail` adds "Confirmed: …", and the webhook body has `confirmed`.
- `lasted` moved to `checks/format` (still exported from the judge).

## 0.8.1

- `agentNamed` checks every place a token appears, so a user agent that names a longer word first ("Googlebot-Video … Googlebot/2.1") still names the agent.
- `tokenForms(purpose?)`: each sending agent's token in the table's form and lowercase, for case-sensitive filters such as Cloudflare's `userAgent_like` (Bing writes "bingbot").

## 0.8.0

- `checks/agents`: one table of the AI agents that read websites, `AI_AGENTS`, each with its operator, its purpose (`training`, `search`, or `user`: fetching a page because a person asked), what its operator says about robots.txt (`follows`, or `may-ignore-for-a-person`), and the documentation page and date it came from (checked 2026-11-21). Agents whose purpose their operator leaves unclear or mixed aren't in it. `agentNamed` finds an agent in a user agent by its token as a whole word; `agentOf` reads a request as a verified agent, a claimed name (not verified, so not counted as the agent), a signed assistant, another verified bot, or unknown; `stopTrainingLines` builds the robots.txt lines that stop training and keep search and people's questions.
- `CRAWLERS` and `CRAWLER_PROBES` are derived from the table (`judged`, `probe`), unchanged in content.
- `robotsState` keeps every AI agent's own group in `rules`, not only the judged crawlers' and `*`, so a rule written for one agent (`User-agent: GPTBot`) is seen as a change. The fingerprint's recipe is now `robots2:` (`ROBOTS_FINGERPRINT`).
- `sameRecipe(a, b)` in `checks/rules`: two fingerprints compare only when made the same way (the prefix before the first colon). The runner uses it, so a recipe change is never reported as a change, and robots.txt and DNS changes compare by their own recipe.

## 0.7.0

- `checks/http/sign`: Web Bot Auth request signing (HTTP Message Signatures, RFC 9421, Ed25519), so a site's CDN can verify a monitor's requests instead of trusting a user agent anyone can copy. `signatureHeaders` covers `@authority` and `signature-agent` with `created`, `expires` (5 minutes), `keyid` (the RFC 7638 thumbprint), a nonce and `tag="web-bot-auth"`; `signaturesDirectory` builds the signed JWK Set served at `/.well-known/http-message-signatures-directory`; `newSigningKey`, `signerFrom`, `verifySignatureHeaders`.
- `fetchUrl` signs each hop afresh (the signature covers the host) when given `sign`, or with the process's own key: set `MONITOR_SIGNING_KEY` (from `agent-ready-uptime signing-key`) and `MONITOR_SIGNATURE_AGENT` (the https origin serving its directory). Only the monitor profile signs: crawler probes and browser requests never do, so a probe still tests how a site treats a crawler's name. The status page serves the directory when a key is set.
- A UCP business profile (`/.well-known/ucp`, the Universal Commerce Protocol) is a new emerging agent file, `ucp_profile`: a version and at least one service, each endpoint an http(s) URL (`no_services` is a new reason). Its summary is the version and counts, never the profile's text.
- `productFacts`: what a page's product structured data gives an agent shopping for it (a name, description, link, image, brand, a price above 0 with its currency, availability, a GTIN or MPN, and whether the price appears in the page's own text), as closed facts.

## 0.6.0

- `checks/domain/registration`: `judgeRegistration(before, after, at)` says what a domain's registration change means. A date that moved forward before the old expiry is a renewal (`"seen"`). One that moved after expiry, or with the `auto renew period` status, is only the registry's own renewal (`"registry"`): for .com, .net and most gTLDs the registry renews the day after expiry whether or not the registrar was paid, and the registrar may then park the site. It also returns `unpaid` (that status), `bad` (holds, redemption, pending delete), `locks` (removed and added) and `parked` (nameservers just moved to a parking host, `PARKING_NS`).
- The runner's domain check alerts on those: expired and only the registry renewed it, a new registry status problem, a registrar lock removed, nameservers moved to a parking host. Before, a domain renewed only by the registry reset its expiry reminders silently.
- `lookupDomain` sets `noRdap` when the TLD's registry has no RDAP service (.io, .co, .me…), and the check says so.

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
