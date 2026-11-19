import { describe, expect, it } from "vitest";
import { fetchOnHost } from "../../src/checks/http/same-host.js";
import { fetchUrl } from "../../src/checks/http/request.js";
import { jsonLd, pageMeta } from "../../src/checks/html/head.js";
import { decidingRule, parseRobots, robotsState } from "../../src/checks/robots.js";
import { testServer } from "../../src/checks/testing/servers.js";

describe("fetchOnHost: redirects only on the site's own host", () => {
  it("follows the host's own redirects, stops at another host's without fetching it, and stops after the hop limit", async () => {
    const other = await testServer({ "/": { body: "elsewhere" } });
    const site = await testServer({
      "/a": { status: 301, headers: { location: "/b" } },
      "/b": { body: "here" },
      "/away": { status: 302, headers: { location: other.url.replace("127.0.0.1", "localhost") + "/" } },
      "/loop": { status: 302, headers: { location: "/loop" } },
      "/bad": { status: 302, headers: { location: "http://[::1" } },
    });
    const get = (u: string) => fetchUrl(u, { maxRedirects: 0 });
    const a = await fetchOnHost(`${site.url}/a`, get);
    expect([a.res.statusCode, a.res.finalUrl, a.res.url, a.offHost, a.res.redirects.length]).toEqual([200, `${site.url}/b`, `${site.url}/a`, null, 1]);
    const away = await fetchOnHost(`${site.url}/away`, get);
    expect(away.offHost).toContain("localhost");
    expect(other.hits("/")).toBe(0);
    const loop = await fetchOnHost(`${site.url}/loop`, get, 3);
    expect([loop.res.statusCode, site.hits("/loop")]).toEqual([302, 4]);
    expect((await fetchOnHost(`${site.url}/bad`, get)).badLocation).toBe(true);
    await Promise.all([site.close(), other.close()]);
  });
});

describe("bounded parsing of hostile bodies", () => {
  const fast = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  it("a megabyte of unclosed <script tags, and of unclosed JSON-LD blocks, parses in well under a second", () => {
    expect(fast(() => pageMeta("<script type".repeat(87_000)))).toBeLessThan(500);
    expect(fast(() => pageMeta("<script type=application/ld+json>".repeat(31_000)))).toBeLessThan(500);
  });
  it("JSON-LD is still found in the head and body, with odd spacing and comments, and broken blocks are counted", () => {
    const html = `<script type = 'application/ld+json'><!--{"@type":"A"}--></script><SCRIPT TYPE="application/ld+json">{"@graph":[{"@type":["B","C"]}]}</SCRIPT><script type="application/ld+json">{bad</script><script>var x="<script type=application/ld+json>"</script>`;
    expect(jsonLd(html)).toEqual({ types: ["A", "B", "C"], invalid: 1 });
  });
  it("a robots.txt rule of 100,000 wildcards neither overflows the stack nor stalls", () => {
    const rules = `User-agent: *\nDisallow: /${"*a".repeat(100_000)}\n`;
    expect(fast(() => robotsState(rules, ["/", "/llms.txt"]))).toBeLessThan(500);
    expect(fast(() => robotsState(`User-agent: *\n${"Disallow: /*a*b*c*d*e*f*g\n".repeat(10_000)}`, ["/", "/llms.txt"]))).toBeLessThan(500);
  });
  it("wildcards and $ still decide as before", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /priv*te\nAllow: /private/ok\n");
    expect(decidingRule(r, "x", "/a/b.pdf").allowed).toBe(false);
    expect(decidingRule(r, "x", "/a/b.pdf?x").allowed).toBe(true);
    expect(decidingRule(r, "x", "/private/no").allowed).toBe(false);
    expect(decidingRule(r, "x", "/private/ok/1").allowed).toBe(true);
    expect(decidingRule(r, "x", "/public").allowed).toBe(true);
  });
});
