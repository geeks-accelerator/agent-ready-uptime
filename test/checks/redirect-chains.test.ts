import { describe, expect, it } from "vitest";
import { checkPage } from "../../src/checks/http/page-check.js";
import { cacheOf, hopOf, type Hop } from "../../src/checks/http/request.js";
import { fetchOnHost } from "../../src/checks/http/same-host.js";
import { fetchUrl } from "../../src/checks/http/request.js";
import { chainWords } from "../../src/checks/format.js";
import { judgeChain } from "../../src/checks/rules.js";
import { isLoginPath } from "../../src/checks/url.js";
import { page, testServer } from "../../src/checks/testing/servers.js";

const hop = (url: string, statusCode: number | null, extra: Partial<Hop> = {}): Hop => ({ url, statusCode, cache: null, noindex: false, ...extra });

describe("redirect chains", () => {
  it("records each step's status, cache and noindex: a renamed story whose old address leads to a 404", async () => {
    const s = await testServer({
      "/old": { status: 307, headers: { location: "/old/preview", "cf-cache-status": "HIT" } },
      "/old/preview": { status: 404, headers: { "x-nextjs-cache": "HIT", "x-robots-tag": "noindex" }, body: "gone" },
    });
    try {
      const r = await checkPage(`${s.url}/old`);
      expect(r.ok).toBe(false);
      expect(r.hops).toEqual([
        { url: `${s.url}/old`, statusCode: 307, cache: "HIT", noindex: false },
        { url: `${s.url}/old/preview`, statusCode: 404, cache: "HIT", noindex: true },
      ]);
      expect(judgeChain(r.hops)).toEqual({ kind: "hop_failed", step: 2, status: 404 });
      expect(chainWords(r.hops)).toBe("307 (cache HIT) → /old/preview 404 (cache HIT)");
    } finally {
      await s.close();
    }
  });

  it("fetchOnHost records the same steps as fetchUrl", async () => {
    const s = await testServer({
      "/a": { status: 301, headers: { location: "/b", "cf-cache-status": "MISS" } },
      "/b": { status: 200, body: page({ title: "B" }) },
    });
    try {
      const one = await fetchUrl(`${s.url}/a`);
      const two = (await fetchOnHost(`${s.url}/a`, (u) => fetchUrl(u, { maxRedirects: 0 }))).res;
      expect(two.redirects).toEqual(one.redirects);
      const r = await checkPage(`${s.url}/a`);
      expect(r.hops.map((h) => h.statusCode)).toEqual([301, 200]);
    } finally {
      await s.close();
    }
  });

  it("has no hops without a redirect", async () => {
    const s = await testServer({ "/": { status: 200, body: page({ title: "Home" }) } });
    try {
      expect((await checkPage(`${s.url}/`)).hops).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("keeps cache values from a closed list only", () => {
    expect(cacheOf({ "cf-cache-status": "hit" })).toBe("HIT");
    expect(cacheOf({ "cf-cache-status": "something else", "x-vercel-cache": "STALE" })).toBe("STALE");
    expect(cacheOf({ "x-cache": "HIT" })).toBeNull();
    expect(hopOf("https://x.test/", 200, { "x-robots-tag": "googlebot: noindex" }).noindex).toBe(true);
  });

  describe("judgeChain", () => {
    const base = "https://news.test";
    it("passes one permanent redirect", () => {
      expect(judgeChain([hop(`${base}/old`, 308), hop(`${base}/new`, 200)])).toBeNull();
      expect(judgeChain([hop(`${base}/old`, 301), hop(`${base}/new`, 200)])).toBeNull();
    });
    it("flags a temporary redirect to another path on the site", () => {
      expect(judgeChain([hop(`${base}/old`, 307), hop(`${base}/new`, 200)])).toEqual({ kind: "temporary", step: 1, status: 307 });
      expect(judgeChain([hop(`${base}/old`, 302), hop(`https://www.news.test/new`, 200)])).toEqual({ kind: "temporary", step: 1, status: 302 });
    });
    it("flags the stuck chain after the fix: 307 to /preview, then 308 to the story", () => {
      expect(judgeChain([hop(`${base}/old`, 307), hop(`${base}/old/preview`, 308), hop(`${base}/new`, 200)])).toEqual({ kind: "temporary", step: 1, status: 307 });
    });
    it("flags more than one redirect", () => {
      expect(judgeChain([hop(`${base}/a`, 301), hop(`${base}/b`, 308), hop(`${base}/c`, 200)])).toEqual({ kind: "chain", redirects: 2 });
    });
    it("doesn't count the HTTPS and www. hop", () => {
      expect(judgeChain([hop("http://news.test/a", 301), hop("https://news.test/a", 301), hop("https://www.news.test/a", 301), hop("https://www.news.test/b", 301), hop("https://www.news.test/c", 200)])).toEqual({ kind: "chain", redirects: 2 });
      expect(judgeChain([hop("http://news.test/a", 307), hop("https://news.test/a", 302), hop("https://www.news.test/a", 200)])).toBeNull();
    });
    it("passes a page behind a sign-in", () => {
      expect(judgeChain([hop(`${base}/account`, 302), hop(`${base}/login?next=/account`, 200)])).toBeNull();
    });
    it("flags a step marked noindex on the way", () => {
      expect(judgeChain([hop(`${base}/old`, 301), hop(`${base}/old/preview`, 308, { noindex: true }), hop(`${base}/new`, 200)])).toEqual({ kind: "through_noindex", step: 2 });
    });
    it("flags a step that doesn't answer", () => {
      expect(judgeChain([hop(`${base}/old`, 301), hop(`${base}/new`, null)])).toEqual({ kind: "hop_failed", step: 2, status: null });
    });
    it("ignores a redirect to another site for temporary", () => {
      expect(judgeChain([hop(`${base}/go`, 302), hop("https://other.test/x", 200)])).toBeNull();
    });
  });

  it("chainWords names another host and writes paths through place", () => {
    expect(chainWords([hop("https://a.test/x", 301), hop("https://b.test/y?q=1", 200, { cache: "MISS" })], (p) => p.split("?")[0]!)).toBe("301 → b.test/y 200 (cache MISS)");
    expect(chainWords([hop("https://a.test/x", 301), hop("https://a.test/y", null)])).toBe("301 → /y no answer");
  });

  it("isLoginPath", () => {
    for (const p of ["/login", "/wp-login.php", "/users/sign_in", "/signin.html", "/oauth/authorize", "/sso"]) expect(isLoginPath(p), p).toBe(true);
    for (const p of ["/author/pat", "/", "/blog/logic"]) expect(isLoginPath(p), p).toBe(false);
  });
});
