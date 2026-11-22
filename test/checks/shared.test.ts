import { describe, expect, it } from "vitest";
import { z } from "zod";
import { linePaths, msAxis } from "../../src/checks/chart.js";
import { openDefaultsShape, openSiteSchema } from "../../src/checks/config.js";
import { ms } from "../../src/checks/format.js";
import { esc, html, raw, safeHref } from "../../src/checks/html/template.js";
import { addFailure, bucketFor, CHANGE_CONFIRM, confirmChange, confirmWords, daysUntil, isDown, NO_STREAK, PAGE_RETRIES, type PendingChange } from "../../src/checks/rules.js";
import { runSpec, specSchema, type Checkers } from "../../src/checks/spec.js";
import { isWebhook, maskWebhook, postWithRetries } from "../../src/checks/webhook.js";
import { testServer } from "../../src/checks/testing/servers.js";
import { syntheticResult } from "../../src/checks/http/page-check.js";

describe("a check from a spec", () => {
  it("runs each kind with its own checker", async () => {
    const seen: string[] = [];
    const fake = (kind: string) => async (url: string) => (seen.push(`${kind} ${url}`), syntheticResult(url, new Date().toISOString(), { ok: true }));
    const c = { checkPage: fake("page"), checkMcp: fake("mcp"), checkPort: fake("port"), checkDns: fake("dns") } as unknown as Checkers;
    await runSpec({ kind: "page", url: "https://example.com/", options: {} }, c);
    await runSpec({ kind: "mcp", url: "https://example.com/mcp", options: {} }, c);
    await runSpec({ kind: "port", url: "tcp://example.com:25", options: {} }, c);
    await runSpec({ kind: "dns", url: "dns://example.com/MX", options: {} }, c);
    expect(seen).toEqual(["page https://example.com/", "mcp https://example.com/mcp", "port tcp://example.com:25", "dns dns://example.com/MX"]);
  });

  it("accepts only well-formed specs", () => {
    expect(specSchema.safeParse({ kind: "page", url: "https://example.com/", options: { timeoutMs: 5000 } }).success).toBe(true);
    expect(specSchema.safeParse({ kind: "page", url: "file:///etc/passwd", options: {} }).success).toBe(false);
    expect(specSchema.safeParse({ kind: "port", url: "tcp://example.com", options: {} }).success).toBe(false);
    expect(specSchema.safeParse({ kind: "page", url: "https://example.com/", options: { cookie: "x" } }).success).toBe(false);
  });
});

describe("rules", () => {
  it("with no second location, a page is down after confirmFailures in a row", () => {
    let s = NO_STREAK;
    s = addFailure(s, "unavailable");
    s = addFailure(s, "unavailable");
    expect(isDown(s, { confirmFailures: 3 })).toBe(false);
    s = addFailure(s, "unavailable");
    expect(isDown(s, { confirmFailures: 3 })).toBe(true);
  });

  it("holds a changed fingerprint until it's read the same three times, retried on the page schedule", () => {
    const at = (m: number) => new Date(Date.parse("2026-11-21T10:00:00Z") + m * 60_000).toISOString();
    expect(CHANGE_CONFIRM).toBe(PAGE_RETRIES.length + 1);
    // The first fingerprint ever, a new recipe, or the same one: nothing to say.
    expect(confirmChange(null, null, "c1:a", at(0))).toEqual({ state: "same", blip: false });
    expect(confirmChange("c0:a", null, "c1:b", at(0))).toEqual({ state: "same", blip: false });
    let v = confirmChange("c1:a", null, "c1:b", at(0));
    expect(v).toEqual({ state: "pending", pending: { fingerprint: "c1:b", reads: 1, firstAt: at(0) }, retryInS: PAGE_RETRIES[0] });
    // Back to the stored one: a blip, never announced.
    expect(confirmChange("c1:a", (v as { pending: PendingChange }).pending, "c1:a", at(1))).toEqual({ state: "same", blip: true });
    // Another new value starts the count again.
    v = confirmChange("c1:a", (v as { pending: PendingChange }).pending, "c1:c", at(1));
    expect(v).toMatchObject({ state: "pending", pending: { fingerprint: "c1:c", reads: 1 } });
    v = confirmChange("c1:a", (v as { pending: PendingChange }).pending, "c1:c", at(2));
    expect(v).toMatchObject({ state: "pending", pending: { reads: 2 }, retryInS: PAGE_RETRIES[1] });
    expect(confirmChange("c1:a", (v as { pending: PendingChange }).pending, "c1:c", at(7))).toEqual({ state: "changed", reads: 3, firstAt: at(1) });
  });

  it("says how a failure was confirmed in one line", () => {
    expect(confirmWords({ times: 3, overMs: 6 * 60_000, from: ["US West", "US East"] })).toBe("3 times over 6 minutes, from US West and US East");
    expect(confirmWords({ times: 3, overMs: 5_000 })).toBe("3 times");
    expect(confirmWords({ times: 1, overMs: 0, from: ["US West"] })).toBe("1 time, from US West");
    expect(confirmWords({ days: 2 })).toBe("2 days running");
  });

  it("puts days left in the tightest bucket", () => {
    const now = Date.parse("2026-11-19T00:00:00Z");
    expect(Math.round(daysUntil("2026-11-29T00:00:00Z", now))).toBe(10);
    expect(bucketFor(10, [30, 14, 7, 1])).toBe(14);
    expect(bucketFor(40, [30, 14, 7, 1])).toBeNull();
  });
});

describe("webhooks", () => {
  it("accepts only each service's own hosts, over HTTPS", () => {
    expect(isWebhook("discord", "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(isWebhook("discord", "https://discord.com.evil.test/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isWebhook("slack", "https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(isWebhook("slack", "http://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx")).toBe(false);
    expect(maskWebhook("https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefgh");
  });

  it("retries a 5xx, honours a 429, and names a webhook that's gone", async () => {
    let n = 0;
    const srv = await testServer({
      "/flaky": () => (++n < 2 ? { status: 503 } : { status: 204 }),
      "/limited": () => (++n < 4 ? { status: 429, headers: { "content-type": "application/json" }, body: '{"retry_after":0.01}' } : { status: 200 }),
      "/gone": { status: 404, body: "Unknown Webhook" },
    });
    const warnings: string[] = [];
    const post = (path: string) => postWithRetries("Discord", fetch, async () => {}, `${srv.url}${path}`, () => ({ body: "{}", headers: { "content-type": "application/json" } }), 5000, (m) => warnings.push(m));
    try {
      expect(await post("/flaky")).toBe("ok");
      expect(await post("/limited")).toBe("ok");
      expect(await post("/gone")).toEqual({ rejected: "the Discord webhook no longer exists (HTTP 404)" });
      expect(warnings.some((w) => w.includes("rate limited"))).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe("chart geometry", () => {
  it("leaves a gap as a gap, and starts a millisecond axis at zero", () => {
    const p = linePaths([100, 120, null, null, null, null, null, 110, 130], 100, 40)!;
    expect(p.line.match(/M/g)!.length).toBe(2);
    const axis = msAxis([180, 220, 260]);
    expect(axis.ticks[0]!.v).toBe(0);
    expect(axis.ticks.at(-1)!.text).toBe(ms(axis.yMax));
  });
});

describe("safe HTML", () => {
  it("escapes interpolations unless they're raw, and links only http(s)", () => {
    const name = `<script>alert("x")</script>`;
    expect(html`<b>${name}</b>`.value).toBe(`<b>${esc(name)}</b>`);
    expect(html`<b>${raw("<i>ok</i>")}</b>`.value).toBe("<b><i>ok</i></b>");
    expect(html`${[html`<i>${"&"}</i>`, false, null]}`.value).toBe("<i>&amp;</i>");
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("https://example.com/")).toBe("https://example.com/");
  });
});

describe("the open site config", () => {
  it("reads a site with only the keys both agent-ready-uptime and the hosted service act on", () => {
    expect(openSiteSchema.parse({ slug: "ex", name: "Example", url: "https://example.com", agent: true, sitemaps: { urls: ["/sitemap.xml"] } }).slug).toBe("ex");
    expect(openSiteSchema.safeParse({ slug: "ex", name: "Example", url: "https://example.com", journeys: [] }).success).toBe(false);
    expect(z.strictObject(openDefaultsShape).parse({}).homepageIntervalSeconds).toBe(60);
  });

  it("makes a JSON schema", () => {
    const s = z.toJSONSchema(openSiteSchema) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(["slug", "url", "homepage", "agent", "ports", "dns"]));
    expect(s.required).toEqual(expect.arrayContaining(["slug", "name", "url"]));
  });
});
