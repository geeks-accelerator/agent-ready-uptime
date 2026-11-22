import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeMcpServer, testServer } from "../src/checks/testing/servers.js";
import type { RdapResult } from "../src/checks/domain/rdap.js";
import { discordPayload, slackPayload, webhookPayload, webhookSender } from "../src/alerts.js";
import { newWebhookSecret, signWebhook } from "../src/checks/webhook.js";
import { run } from "../src/cli.js";
import { configFromEnv, jsonSchema, parseConfig, ConfigError } from "../src/config.js";
import { alertDetail, judge, type Alert } from "../src/judge.js";
import { graph, renderPage } from "../src/page.js";
import { Runner } from "../src/runner.js";
import { pageServer } from "../src/server.js";
import { newTarget, readState } from "../src/state.js";
import { siteTargets } from "../src/targets.js";

const DISCORD = "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz";
const noDomain = async (domain: string): Promise<RdapResult> => ({ domain, ok: true, error: null, expiresAt: "2030-01-01T00:00:00Z", registrar: null, nameservers: [], statusFlags: [] });

describe("the config", () => {
  it("reads sites with the open keys, and webhooks from the file or the environment", () => {
    const { config, webhooks } = parseConfig({ sites: [{ slug: "ex", name: "Example", url: "https://example.com" }], alerts: [{ kind: "discord", env: "HOOK" }] }, { HOOK: DISCORD });
    expect(config.defaults.homepageIntervalSeconds).toBe(60);
    expect(webhooks).toEqual([{ kind: "discord", url: DISCORD }]);
  });

  it("refuses what it wouldn't act on, a webhook off its service's hosts, and two sites with one slug", () => {
    const site = { slug: "ex", name: "Example", url: "https://example.com" };
    expect(() => parseConfig({ sites: [{ ...site, journeys: [] }] })).toThrow(ConfigError);
    expect(() => parseConfig({ sites: [site], alerts: [{ kind: "discord", url: "https://evil.test/api/webhooks/1/x" }] })).toThrow(/not a discord webhook/);
    expect(() => parseConfig({ sites: [site], alerts: [{ kind: "slack", env: "NOPE" }] }, {})).toThrow(/NOPE isn't set/);
    expect(() => parseConfig({ sites: [site, site] })).toThrow(/two sites/);
  });

  it("reads a generic webhook with its signing secret, and refuses one without", () => {
    const site = { slug: "ex", name: "Example", url: "https://example.com" };
    const secret = newWebhookSecret();
    const { webhooks } = parseConfig({ sites: [site], alerts: [{ kind: "webhook", env: "HOOK", secretEnv: "HOOK_SECRET" }] }, { HOOK: "https://hooks.example.com/x", HOOK_SECRET: secret });
    expect(webhooks).toEqual([{ kind: "webhook", url: "https://hooks.example.com/x", secret }]);
    expect(() => parseConfig({ sites: [site], alerts: [{ kind: "webhook", url: "https://hooks.example.com/x" }] })).toThrow(/secretEnv/);
    expect(() => parseConfig({ sites: [site], alerts: [{ kind: "discord", env: "D", secretEnv: "S" }] }, { D: DISCORD })).toThrow(/secretEnv/);
    expect(() => parseConfig({ sites: [site], alerts: [{ kind: "webhook", url: "https://hooks.example.com/x", secretEnv: "S" }] }, { S: "hunter2" })).toThrow(/isn't a signing secret/);
    expect(() => parseConfig({ sites: [site], alerts: [{ kind: "webhook", url: "https://10.0.0.5/x", secretEnv: "S" }] }, { S: secret })).toThrow(/not a webhook webhook URL/);
    const fromEnv = configFromEnv({ SITES: "https://example.com", WEBHOOK_URL: "https://hooks.example.com/x" });
    expect(parseConfig(fromEnv, { WEBHOOK_URL: "https://hooks.example.com/x", WEBHOOK_SECRET: secret }).webhooks[0]!.kind).toBe("webhook");
  });

  it("can come from SITES and the webhook variables alone, and publishes a JSON schema", () => {
    const c = configFromEnv({ SITES: "https://www.example.com, https://docs.example.org", DISCORD_WEBHOOK_URL: DISCORD }) as { sites: Array<{ slug: string }> };
    expect(c.sites.map((s) => s.slug)).toEqual(["example-com", "docs-example-org"]);
    expect(parseConfig(c, { DISCORD_WEBHOOK_URL: DISCORD }).webhooks).toHaveLength(1);
    expect(JSON.stringify(jsonSchema())).toContain("homepageIntervalSeconds");
  });
});

describe("judging", () => {
  const home = siteTargets({ slug: "ex", name: "Ex", url: "https://example.com" }, parseConfig({ sites: [{ slug: "ex", name: "Ex", url: "https://example.com" }] }).config.defaults)[0]!;
  const at = (i: number) => new Date(Date.parse("2026-11-19T00:00:00Z") + i * 60_000).toISOString();
  const fail = (i: number) => ({ ok: false, checkedAt: at(i), error: "http_500", detail: "HTTP 500", ttfbMs: 12 });
  const pass = (i: number, extra = {}) => ({ ok: true, checkedAt: at(i), error: null, detail: null, ttfbMs: 40, ...extra });

  it("alerts down on the third failure in a row, once, and back up after", () => {
    let s = newTarget();
    const alerts: Alert[] = [];
    for (const [i, o] of [pass(0), fail(1), fail(2), fail(3), fail(4), pass(5)].entries()) {
      const r = judge(home, s, o, "Ex");
      s = r.state;
      alerts.push(...r.alerts.map((a) => ({ ...a, at: String(i) })));
    }
    expect(alerts.map((a) => `${a.at} ${a.kind}`)).toEqual(["3 down", "5 up"]);
    expect(alertDetail(alerts[1]!, "utc")).toBe("Down for 4 minutes. Since 00:01 UTC.");
  });

  it("announces each expiry threshold once, and again after a renewal", () => {
    let s = newTarget();
    const kinds: string[] = [];
    for (const days of [20, 13, 12, 2, 1, 90, 10]) {
      const r = judge(home, s, pass(0, { expiresAt: new Date(Date.parse(at(0)) + days * 86_400_000).toISOString() }), "Ex");
      s = r.state;
      kinds.push(r.alerts.map((a) => a.title).join("") || "-");
    }
    expect(kinds).toEqual(["-", "Ex's TLS certificate expires in 13 days", "-", "Ex's TLS certificate expires in 2 days", "-", "-", "Ex's TLS certificate expires in 10 days"]);
  });
});

describe("alerts", () => {
  const a: Alert = { kind: "down", site: "ex", target: "Homepage", title: "Ex: Homepage is down @everyone", detail: "<script> & <@here>", url: "https://example.com/", at: "2026-11-19T00:00:00Z" };

  it("never mention anyone on Discord, and escape Slack's markup", () => {
    expect(discordPayload(a)).toMatchObject({ allowed_mentions: { parse: [] } });
    expect((slackPayload(a) as { text: string }).text).toContain("&lt;script&gt; &amp; &lt;@here&gt;");
  });

  it("write a moment in each reader's timezone: Discord and Slack markup, UTC in logs", () => {
    const up: Alert = { kind: "up", site: "ex", target: "Homepage", title: "Ex: Homepage is back up", detail: "Down for 7 minutes.", when: { at: "2026-11-19T07:32:36.000Z", word: "Since", show: "time" }, url: "https://example.com/", at: "2026-11-19T07:39:36Z" };
    const unix = Date.parse("2026-11-19T07:32:36.000Z") / 1000;
    expect(alertDetail(up, "utc")).toBe("Down for 7 minutes. Since 07:32 UTC.");
    expect((discordPayload(up) as { embeds: Array<{ description: string }> }).embeds[0]!.description).toContain(`Down for 7 minutes. Since <t:${unix}:t>.`);
    expect((slackPayload(up) as { text: string }).text).toContain(`Since <!date^${unix}^{time}|07:32 UTC>.`);
    const expiring: Alert = { ...up, kind: "expiring", title: "Ex's TLS certificate expires in 3 days", detail: null, when: { at: "2026-11-22T12:00:00Z", word: "On", show: "date" } };
    expect(alertDetail(expiring, "utc")).toBe("On 2026-11-22.");
    expect((discordPayload(expiring) as { embeds: Array<{ description: string }> }).embeds[0]!.description).toContain(`On <t:${Date.parse("2026-11-22T12:00:00Z") / 1000}:D>.`);
    // The site's words stay escaped on Slack; only our date markup is markup.
    const hostile: Alert = { ...up, detail: "<!channel> & <x>" };
    expect((slackPayload(hostile) as { text: string }).text).toContain("&lt;!channel&gt; &amp; &lt;x&gt; Since <!date^");
  });

  it("go to a generic webhook as signed JSON", async () => {
    const secret = newWebhookSecret();
    const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (sent.push({ url, body: init.body as string, headers: init.headers as Record<string, string> }), new Response(null, { status: 204 }))) as unknown as typeof fetch;
    await webhookSender([{ kind: "webhook", url: "https://hooks.example.com/x", secret }], { fetchImpl })(a);
    const [s] = sent;
    const body = JSON.parse(s!.body);
    expect(body).toEqual(webhookPayload(a, body.id));
    expect(body).toMatchObject({ type: `alert.${a.kind}`, version: 1, site: a.site, title: a.title });
    expect(s!.headers["webhook-signature"]).toBe(signWebhook(secret, body.id, Number(s!.headers["webhook-timestamp"]), s!.body));
    expect(s!.headers["webhook-id"]).toBe(body.id);
  });

  it("go to each webhook, and never to a URL off its service's hosts", async () => {
    const posted: string[] = [];
    const fetchImpl = (async (url: string) => (posted.push(url), new Response(null, { status: 204 }))) as unknown as typeof fetch;
    const warnings: string[] = [];
    await webhookSender([{ kind: "discord", url: DISCORD }, { kind: "slack", url: "https://evil.test/hook" }], { fetchImpl, warn: (m) => warnings.push(m) })(a);
    expect(posted).toEqual([DISCORD]);
    expect(warnings[0]).toMatch(/not a slack webhook/);
  });
});

describe("the status page", () => {
  it("escapes a site's words, draws gaps as gaps, and carries the footer link once", () => {
    const { config } = parseConfig({ sites: [{ slug: "ex", name: "<img src=x onerror=alert(1)>", url: "https://example.com" }] });
    const now = Date.parse("2026-11-19T12:00:00Z");
    const page = renderPage(config, { version: 1, targets: {}, discovered: {}, history: {} }, [], now);
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(page).not.toContain("<img");
    expect(page.match(/sitesinthewoods\.com/g)).toHaveLength(1);
    expect(page).toContain("<title>agent-ready uptime monitoring</title>");
    const g = graph([[now - 3_600_000, 100], [now - 3_300_000, 120], [now - 600_000, 90], [now - 300_000, 95]], now).value;
    expect(g.match(/class="line"/)).toBeTruthy();
    expect(g.match(/d="M[^"]*"/g)![1]!.match(/M/g)!.length).toBe(2);
  });
});

describe("a run against local sites", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aru-"));
  });
  afterEach(() => {});

  it("watches the homepage, the sitemap, llms.txt and the MCP server; alerts down, up and a tool change; survives a restart", async () => {
    const mcp = await fakeMcpServer();
    const site = await testServer({
      "/": { body: "<html><head><title>Ex</title></head><body>hello</body></html>" },
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" },
      "/sitemap.xml": { headers: { "content-type": "application/xml" }, body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://x/a</loc></url></urlset>` },
      "/llms.txt": { headers: { "content-type": "text/plain" }, body: "# Ex\n\n> A small example site, watched by agent-ready-uptime in its tests.\n\n## Docs\n\n- [About](/about): who we are and what this site is for\n- [Contact](/contact): how to reach us\n" },
    });
    site.set("/.well-known/mcp.json", { headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ex", endpoint: mcp.url, url: mcp.url }) });
    const alerts: Alert[] = [];
    const lines: string[] = [];
    const statePath = join(dir, "state.json");
    const { config } = parseConfig({ sites: [{ slug: "ex", name: "Ex", url: site.url }] });
    const open = () => Runner.open(config, { statePath, send: async (a) => void alerts.push(a), out: (l) => lines.push(l), deps: { lookupDomain: noDomain } });
    try {
      let r = await open();
      await r.discover(true);
      const kinds = [...r.targets.values()].map((t) => `${t.kind}:${t.label}`);
      expect(kinds).toEqual(expect.arrayContaining(["homepage:Homepage", "sitemap:Sitemap /sitemap.xml", "agent:llms.txt", "agent:MCP server"]));
      await r.checkAll();
      expect(r.failing().map((t) => t.label)).toEqual([]);
      expect(alerts).toEqual([]);
      expect(r.state.targets[`ex:agent:mcp:${mcp.url}`]?.count).toBe(2);

      site.set("/", { status: 500, body: "oops" });
      for (let i = 0; i < 3; i++) await r.checkAll();
      expect(alerts.map((a) => a.kind)).toEqual(["down"]);
      // The probes fail with it, but only the homepage alerted.
      expect(r.failing().map((t) => t.label)).toContain("Homepage");

      // A restart reads the state: no second "down", and the recovery still comes.
      await r.stop();
      r = await open();
      site.set("/", { body: "<html><head><title>Ex</title></head><body>hello</body></html>" });
      mcp.state.tools = [{ name: "adopt_v2", inputSchema: { type: "object" } }, { name: "feed" }];
      await r.checkAll();
      // A changed tool list is held until it's read the same three times (confirmChange).
      expect(alerts.map((a) => a.kind)).toEqual(["down", "up"]);
      await r.checkAll();
      await r.checkAll();
      expect(alerts.map((a) => a.kind)).toEqual(["down", "up", "changed"]);
      expect(alerts[2]!.detail).toBe("removed `adopt`; added `adopt_v2`");
      expect(alerts[2]!.confirmed).toBe("3 times");
      expect(alerts[0]!.confirmed).toMatch(/^3 times/);
      await r.stop();

      const saved = await readState(statePath);
      expect(saved.history.ex!.length).toBeGreaterThanOrEqual(5);
      expect(lines.some((l) => JSON.parse(l).alert === "down")).toBe(true);

      // The page shows it all, read-only.
      const server = pageServer(r).listen(0, "127.0.0.1");
      await new Promise((ok) => server.once("listening", ok));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        const res = await fetch(`${base}/`);
        expect(res.headers.get("content-security-policy")).toContain("form-action 'none'");
        const body = await res.text();
        expect(body).toContain("MCP server · 2 tools, changed");
        expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
        expect((await fetch(`${base}/page.js`)).status).toBe(200);
      } finally {
        server.close();
      }
    } finally {
      await site.close();
      await mcp.close();
    }
  });

  it("init writes a config that runs at once, with alerts only for webhook variables that are set", async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    const saved = process.env.DISCORD_WEBHOOK_URL;
    try {
      delete process.env.DISCORD_WEBHOOK_URL;
      expect(await run(["init", "https://example.com"])).toBe(0);
      const file = JSON.parse(await readFile(join(dir, "monitor.config.json"), "utf8"));
      expect(file.alerts).toEqual([]);
      expect(parseConfig(file, {}).config.sites[0]!.slug).toBe("example-com");
      expect(await run(["init", "https://example.com"])).toBe(2);
    } finally {
      process.chdir(cwd);
      if (saved !== undefined) process.env.DISCORD_WEBHOOK_URL = saved;
    }
  });

  it("check mode exits 1 while something fails, 0 once it passes", async () => {
    const site = await testServer({ "/": { status: 503, body: "down" } });
    const cfg = join(dir, "monitor.config.json");
    await writeFile(cfg, JSON.stringify({ sites: [{ slug: "ex", name: "Ex", url: site.url, sitemaps: false, agent: false }] }));
    const check = () => run(["check", "--config", cfg, "--state", join(dir, "s.json")]);
    try {
      expect(await check()).toBe(1);
      site.set("/", { body: "<html><body>ok</body></html>" });
      expect(await check()).toBe(0);
      expect(JSON.parse(await readFile(join(dir, "s.json"), "utf8")).targets["ex:home"].ok).toBe(true);
      expect(await run(["check", "--config", join(dir, "missing.json")])).toBe(2);
    } finally {
      await site.close();
    }
  });

});
