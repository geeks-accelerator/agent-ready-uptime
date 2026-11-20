import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { isWebhook, maskWebhook, newWebhookSecret, postWithRetries, publicFetch, signWebhook, webhookHeaders, WEBHOOK_KINDS, WEBHOOK_URL_MAX } from "../../src/checks/webhook.js";
import { testServer } from "../../src/checks/testing/servers.js";

const read = (req: http.IncomingMessage) =>
  new Promise<string>((ok) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => ok(s));
  });

describe("generic webhooks: the URL rule", () => {
  it("takes any public HTTPS name, and refuses what could reach somewhere else", () => {
    expect(WEBHOOK_KINDS).toContain("webhook");
    for (const ok of ["https://hooks.zapier.com/hooks/catch/123/abc/", "https://example.com/hook?team=1", "https://n8n.example.org:8443/webhook/x"]) expect(isWebhook("webhook", ok)).toBe(true);
    for (const bad of [
      "http://example.com/hook", // not HTTPS
      "https://user:pass@example.com/hook", // user info
      "https://example.com/hook#frag",
      "https://127.0.0.1/hook", // raw IPs, any spelling
      "https://[::1]/hook",
      "https://169.254.169.254/latest",
      "https://localhost/hook", // a name with no dot
      "https://example.com./hook",
      `https://example.com/${"a".repeat(WEBHOOK_URL_MAX)}`,
      "https://exa mple.com/",
      "not a url",
    ])
      expect(isWebhook("webhook", bad), bad).toBe(false);
    // Discord's and Slack's own rules are unchanged: a generic URL isn't one of theirs.
    expect(isWebhook("discord", "https://example.com/api/webhooks/1/x")).toBe(false);
  });

  it("masks a short URL to its origin", () => {
    expect(maskWebhook("https://example.com/hook")).toBe("https://example.com/…");
    expect(maskWebhook("https://hooks.zapier.com/hooks/catch/123456/abcdef/")).toMatch(/^https:\/\/hooks\.zapier\.com\/hooks\/catch\/123456…\//);
  });
});

describe("Standard Webhooks signing", () => {
  it("matches the spec's published example", () => {
    // From https://github.com/standard-webhooks/standard-webhooks (the spec's test vector).
    expect(signWebhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}')).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("makes secrets of 32 random bytes and headers in seconds", () => {
    const s = newWebhookSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(s.slice(6), "base64")).toHaveLength(32);
    expect(newWebhookSecret()).not.toBe(s);
    const h = webhookHeaders(s, "msg_1", "{}", 1_700_000_000_500);
    expect(h["webhook-timestamp"]).toBe("1700000000");
    expect(h["webhook-signature"]).toBe(signWebhook(s, "msg_1", 1_700_000_000, "{}"));
    expect(h["content-type"]).toBe("application/json");
  });
});

describe("publicFetch", () => {
  const allow = process.env.MONITOR_ALLOW_LOCAL;
  afterEach(() => {
    process.env.MONITOR_ALLOW_LOCAL = allow;
  });

  it("posts the body and headers, answers as a Response, and never follows a redirect", async () => {
    let got: { body: string; headers: http.IncomingHttpHeaders } | null = null;
    const site = await testServer({
      "/hook": async (req) => ((got = { body: await read(req), headers: req.headers }), { status: 202, body: "queued" }),
      "/moved": { status: 302, headers: { location: "/hook" } },
    });
    const res = await publicFetch(`${site.url}/hook`, { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json", "user-agent": "test-hooks/1" } });
    expect([res.status, await res.text()]).toEqual([202, "queued"]);
    expect(got!.body).toBe('{"a":1}');
    expect(got!.headers["user-agent"]).toBe("test-hooks/1");
    const moved = await publicFetch(`${site.url}/moved`, { method: "POST", body: "{}" });
    expect(moved.status).toBe(302);
    expect(site.hits("/hook")).toBe(1);
    await site.close();
  });

  it("refuses a private address without retrying, through postWithRetries", async () => {
    const site = await testServer({ "/hook": { status: 200 } });
    delete process.env.MONITOR_ALLOW_LOCAL;
    const warnings: string[] = [];
    const r = await postWithRetries("Webhook", publicFetch, async () => {}, `${site.url}/hook`, () => ({ body: "{}", headers: {} }), 5_000, (m) => warnings.push(m));
    expect(r).toEqual({ rejected: "the webhook's address is private" });
    expect(site.hits("/hook")).toBe(0);
    expect(warnings).toHaveLength(1);
    await site.close();
  });
});
