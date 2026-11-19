import { describe, expect, it } from "vitest";
import { looksLikeAction, looksLikeLinkAction } from "../../src/checks/actions.js";
import { measureHtml } from "../../src/checks/html/weight.js";
import { fetchUrl } from "../../src/checks/http/request.js";
import { crawlDelay, namesAgent, parseRobots } from "../../src/checks/robots.js";
import { discoverSitemaps } from "../../src/checks/sitemap/fetch.js";
import { isPublicSuffix, journeyHosts, pageKey, pathPattern, sameRegistrable, scanKey, sharedHost, stripTracking, toALabel } from "../../src/checks/url.js";
import { testServer, urlset } from "../../src/checks/testing/servers.js";

describe("URL keys (0.8)", () => {
  it("one page key: no www, query, hash, trailing slash or index.html; a non-default port kept", () => {
    expect(pageKey("https://WWW.X.test/a/b/?q=1#h")).toBe("x.test/a/b");
    expect(pageKey("https://x.test/a/index.html")).toBe("x.test/a");
    expect(pageKey("https://x.test/index.html")).toBe("x.test/");
    expect(pageKey("https://x.test:8443/a")).toBe("x.test:8443/a");
    expect(pageKey("not a url")).toBeNull();
  });

  it("strips tracking parameters, and keys a URL by its page plus its sorted query", () => {
    expect(stripTracking("https://x.test/a?utm_source=n&b=2&gclid=1&fbclid=2&mc_cid=3&ref=x#top")).toBe("https://x.test/a?b=2");
    expect(scanKey("https://x.test/a?b=2&a=1&utm_medium=x")).toBe("x.test/a?a=1&b=2");
    expect(scanKey("https://x.test/a?a=1&b=2")).toBe(scanKey("https://www.x.test/a/?b=2&a=1"));
    expect(scanKey("https://x.test/a")).toBe("x.test/a");
  });

  it("gives a path's pattern, ids replaced", () => {
    expect(pathPattern("/posts/123/comments")).toBe("/posts/:id/comments");
    expect(pathPattern("/u/3f9a2b7c1d/profile")).toBe("/u/:id/profile");
    expect(pathPattern("/about/team")).toBe("/about/team");
  });
});

describe("shared hosts and the same site (0.9)", () => {
  it("knows hosting suffixes and two-label country suffixes, as A-labels", () => {
    expect(sharedHost("foo.github.io")).toBe(true);
    expect(sharedHost("github.io")).toBe(true);
    expect(sharedHost("co.uk")).toBe(true);
    expect(sharedHost("example.com")).toBe(false);
    expect(isPublicSuffix("github.io")).toBe(true);
    expect(isPublicSuffix("foo.github.io")).toBe(false);
    expect(toALabel("Bücher.Example.")).toBe("xn--bcher-kva.example");
  });

  it("two subdomains of a shared host are two sites; www and the apex are one", () => {
    expect(sameRegistrable("a.github.io", "b.github.io")).toBe(false);
    expect(sameRegistrable("www.a.github.io", "a.github.io")).toBe(true);
    expect(sameRegistrable("shop.example.co.uk", "example.co.uk")).toBe(true);
    expect(sameRegistrable("a.co.uk", "b.co.uk")).toBe(false);
    expect(sameRegistrable("blog.example.com", "example.com")).toBe(true);
    expect(sameRegistrable("example.com", "example.org")).toBe(false);
  });

  it("journeyHosts: the host and its www twin", () => {
    expect([...journeyHosts("https://www.x.test:8080/a")]).toEqual(["www.x.test", "x.test"]);
  });
});

describe("fetchUrl stayOn (0.1)", () => {
  it("follows a redirect on the host, and stops at one that leaves it without fetching it", async () => {
    const srv = await testServer({
      "/a": { status: 301, headers: { location: "/b" } },
      "/b": { status: 200, body: "here" },
      "/off": { status: 302, headers: { location: "http://elsewhere.test/x" } },
    });
    try {
      const host = new URL(srv.url).hostname;
      const on = await fetchUrl(`${srv.url}/a`, { stayOn: new Set([host]) });
      expect(on).toMatchObject({ statusCode: 200, error: null, finalUrl: `${srv.url}/b` });
      const off = await fetchUrl(`${srv.url}/off`, { stayOn: new Set([host]) });
      expect(off).toMatchObject({ statusCode: 302, error: "redirect_off_host", finalUrl: "http://elsewhere.test/x" });
      expect(off.redirects).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });
});

describe("action words (0.6)", () => {
  it("keeps the API set as it was, and adds links that change things, in three languages", () => {
    expect(looksLikeAction("exportUsers")).toBe(true);
    expect(looksLikeAction("listUsers", "Every user", "/api/users")).toBe(false);
    expect(looksLikeLinkAction("/account/logout")).toBe(true);
    expect(looksLikeLinkAction("/x", "Log out")).toBe(true);
    expect(looksLikeLinkAction("/carrinho", "Adicionar ao carrinho")).toBe(true);
    expect(looksLikeLinkAction("/x", "Cerrar sesión")).toBe(true);
    expect(looksLikeLinkAction("/blog/how-we-vote-on-features", "Read more")).toBe(true);
    expect(looksLikeLinkAction("/about", "About us")).toBe(false);
  });

  it("marks anchors that act: by words, data-method, data-confirm, or a token in the query", () => {
    const w = measureHtml(
      `<main><a href="/about">About</a><a href="/logout">Log out</a><a href="/x" data-method="delete">Remove</a><a href="/y" data-confirm="Sure?">Go</a><a href="/u?token=abcdef123456">Unsub</a><a href="/z?t=1">Short t</a></main>`,
      "https://x.test/",
    );
    expect(w.anchors.map((a) => [a.href.replace("https://x.test", ""), a.action])).toEqual([
      ["/about", false],
      ["/logout", true],
      ["/x", true],
      ["/y", true],
      ["/u?token=abcdef123456", true],
      ["/z?t=1", false],
    ]);
  });
});

describe("robots.txt (0.17, 0.18)", () => {
  it("reads Crawl-delay per group and knows whether a crawler is named", () => {
    const r = parseRobots("User-agent: *\nCrawl-delay: 2\nDisallow: /private\n\nUser-agent: site-monitor-scan\nCrawl-delay: 30\nDisallow: /");
    expect(crawlDelay(r, "site-monitor-scan")).toBe(30);
    expect(crawlDelay(r, "other")).toBe(2);
    expect(namesAgent(r, "Site-Monitor-Scan")).toBe(true);
    expect(namesAgent(r, "other")).toBe(false);
    expect(crawlDelay(parseRobots("User-agent: *\nDisallow:"), "x")).toBeNull();
  });

  it("discoverSitemaps hands back the robots.txt it read, with the caller's headers sent", async () => {
    let seen = "";
    const srv = await testServer({
      "/robots.txt": (req) => ((seen = String(req.headers["x-scan-id"] ?? "")), { body: "User-agent: *\nCrawl-delay: 1\nSitemap: /s.xml", headers: { "content-type": "text/plain" } }),
      "/s.xml": { body: urlset([{ loc: "/a" }]), headers: { "content-type": "application/xml" } },
    });
    try {
      const r = await discoverSitemaps(srv.url, { probeJson: false, headers: { "x-scan-id": "s1" } });
      expect(r.urls).toEqual([`${srv.url}/s.xml`]);
      expect(r.robots && crawlDelay(r.robots, "x")).toBe(1);
      expect(seen).toBe("s1");
    } finally {
      await srv.close();
    }
  });
});
