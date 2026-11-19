import { describe, expect, it } from "vitest";
import { carryRobotsState, decidingRule, lostPairs, parseRobots, robotsDiff, robotsState, robotsSummary, probeCrawler, probeName, probeUrl } from "../../src/checks/robots.js";
import { page } from "../../src/checks/testing/servers.js";
import { requestHeaders } from "../../src/checks/http/request.js";

describe("robots.txt parsing (RFC 9309, Google's precedence)", () => {
  it("groups user-agents, ignores comments and unknown lines, reads Sitemap lines", () => {
    const r = parseRobots("# hi\nUser-agent: a\nUser-agent: B # two agents, one group\nDisallow: /x\nCrawl-delay: 5\n\nUser-agent: *\nAllow: /\nSitemap: https://e.com/s.xml\n");
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]!.agents).toEqual(["a", "b"]);
    expect(r.groups[0]!.rules.map((x) => x.line)).toEqual(["Disallow: /x"]);
    expect(r.sitemaps).toEqual(["https://e.com/s.xml"]);
  });

  it("the named group beats *, and groups for one agent merge", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /private\n\nUser-agent: googlebot\nDisallow: /tmp\n");
    expect(decidingRule(r, "Googlebot", "/").allowed).toBe(true);
    expect(decidingRule(r, "Googlebot", "/tmp/a").allowed).toBe(false);
    expect(decidingRule(r, "Bingbot", "/").allowed).toBe(false);
  });

  it("longest match wins, Allow wins a tie, * and $ work, an empty Disallow allows", () => {
    const r = parseRobots("User-agent: *\nDisallow: /p\nAllow: /p/ok\nDisallow: /*.pdf$\nAllow: /page\nDisallow: /page\n");
    expect(decidingRule(r, "x", "/p/ok/1").allowed).toBe(true);
    expect(decidingRule(r, "x", "/p/no").rule?.line).toBe("Disallow: /p");
    expect(decidingRule(r, "x", "/a/b.pdf").allowed).toBe(false);
    expect(decidingRule(r, "x", "/a/b.pdf?x").allowed).toBe(true);
    expect(decidingRule(r, "x", "/page").allowed).toBe(true);
    expect(decidingRule(parseRobots("User-agent: *\nDisallow:\n"), "x", "/").allowed).toBe(true);
  });

  it("an empty file, or an HTML page, allows everything", () => {
    expect(decidingRule(parseRobots(""), "Googlebot", "/").allowed).toBe(true);
    expect(decidingRule(parseRobots("<!doctype html><html><body>Not found</body></html>"), "Googlebot", "/").allowed).toBe(true);
  });
});

describe("robots.txt state", () => {
  const paths = ["/", "/pricing"];
  it("lists what's blocked for the crawlers that bring readers, with the deciding rule", () => {
    const s = robotsState("User-agent: *\nDisallow: /pricing\n\nUser-agent: GPTBot\nDisallow: /\n", paths);
    expect(s.blocked.map((b) => b.pair)).toEqual(["Googlebot /pricing", "Bingbot /pricing", "OAI-SearchBot /pricing", "Claude-SearchBot /pricing", "PerplexityBot /pricing"]);
    expect(s.blocked[0]).toMatchObject({ rule: "Disallow: /pricing", agents: "*" });
    // GPTBot (training) isn't one of them, so its group isn't in the rules either.
    expect(s.rules).toEqual(["User-agent: *", "Disallow: /pricing"]);
    expect(robotsSummary(s)).toBe("blocks Googlebot from /pricing and 4 more");
    expect(robotsSummary(robotsState("", paths))).toBe("allows search crawlers");
  });

  it("only pairs once allowed are lost; the carried state remembers them and the last good rules", () => {
    const first = carryRobotsState(robotsState("User-agent: *\nDisallow: /pricing\n", paths), null);
    expect(lostPairs(first, null)).toEqual([]); // blocked from the start: a choice
    const broken = robotsState("User-agent: *\nDisallow: /\n", paths);
    expect(lostPairs(broken, first).map((b) => b.pair)).toEqual(["Googlebot /", "Bingbot /", "OAI-SearchBot /", "Claude-SearchBot /", "PerplexityBot /"]);
    const carried = carryRobotsState(broken, first);
    expect(carried.goodRules).toEqual(["User-agent: *", "Disallow: /pricing"]);
    expect(lostPairs(broken, carried)).toHaveLength(5); // still lost on the next check
    expect(robotsDiff(carried.goodRules!, broken.rules)).toEqual({ added: ["Disallow: /"], removed: ["Disallow: /pricing"] });
  });
});

describe("crawler probes", () => {
  it("are named by a fragment and fetched with the crawler's user agent and plain bot headers", () => {
    const u = probeUrl("https://e.com/", "GPTBot");
    expect(u).toBe("https://e.com/#as-GPTBot");
    expect(probeName(u)).toBe("GPTBot");
    expect(probeCrawler("GPTBot")!.userAgent).toMatch(/GPTBot\/1\.\d/);
    expect(probeCrawler("Mine", [{ name: "Mine", userAgent: "MineBot/2" }])!.userAgent).toBe("MineBot/2");
    const h = requestHeaders({ userAgent: "MineBot/2" });
    expect(h).toMatchObject({ "user-agent": "MineBot/2", accept: "*/*" });
    expect(h["sec-fetch-mode"]).toBeUndefined();
  });
});
