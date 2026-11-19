import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { parseHead, headerNoindex } from "../src/html/head.js";
import { apexDomain, isHttpUrl, normalizeForCompare, sameUrl, siteUrl, normaliseUrl } from "../src/url.js";
import { safeHref } from "../src/html/template.js";
import { parseSitemap, SitemapParseError } from "../src/sitemap/parse.js";
import { parseRdap, badStatuses } from "../src/domain/rdap.js";
import { measureHtml, speculationRules } from "../src/html/weight.js";
import https from "node:https";

describe("url helpers", () => {
  it("normalizes for comparison", () => {
    expect(normalizeForCompare("https://www.Example.com/a/?x=1#y")).toBe("example.com/a");
    expect(normalizeForCompare("https://example.com")).toBe("example.com/");
    expect(sameUrl("https://example.com/", "http://www.example.com")).toBe(true);
    expect(sameUrl("https://example.com/a", "https://example.com/b")).toBe(false);
  });
  it("derives apex domains and joins paths", () => {
    expect(apexDomain("docs.example.ai")).toBe("example.ai");
    expect(apexDomain("example.com")).toBe("example.com");
    expect(apexDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(apexDomain("localhost")).toBe("localhost");
    expect(siteUrl("https://a.com", "/about")).toBe("https://a.com/about");
    expect(siteUrl("https://a.com", "https://b.com/x")).toBe("https://b.com/x");
  });
  it("accepts only absolute http(s) URLs as links", () => {
    for (const ok of ["https://a.com/x", "http://a.com", "HTTPS://A.COM/"]) {
      expect(isHttpUrl(ok)).toBe(true);
      expect(safeHref(ok)).toBe(ok);
    }
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "data:text/html,x", "/relative", "https://", "", null]) {
      if (bad !== null) expect(isHttpUrl(bad)).toBe(false);
      expect(safeHref(bad)).toBe("#");
    }
  });
});

describe("parseHead", () => {
  it("extracts title, noindex and canonical", () => {
    const h = parseHead(
      `<html><head><title> Into the Hum &middot; satchitananda </title><meta name="ROBOTS" content="noindex,follow"><link rel="canonical" href="/x/"></head><body><title>no</title></body></html>`,
    );
    expect(h).toEqual({ title: "Into the Hum · satchitananda", metaNoindex: true, canonical: "/x/", description: null, ogTitle: null, ogImage: null });
  });
  it("handles missing tags; chart labels inside <svg> don't count", () => {
    const h = parseHead(`<html><head></head><body><svg><title>Hunger 90 to 100</title><link rel="canonical" href="/no"/></svg></body></html>`);
    expect(h).toEqual({ title: null, metaNoindex: false, canonical: null, description: null, ogTitle: null, ogImage: null });
  });
  it("reads metadata Next.js streams at the end of the body", () => {
    const h = parseHead(
      `<html><head><title></title></head><body><svg><title>chart</title></svg><script>self.__next_f.push([1,"x"])</script><title>Crescent the Owl | example.ai</title><meta name="robots" content="noindex"/><link rel="canonical" href="/creatures/c"/></body></html>`,
    );
    expect(h).toEqual({ title: "Crescent the Owl | example.ai", metaNoindex: true, canonical: "/creatures/c", description: null, ogTitle: null, ogImage: null });
  });
  it("reads X-Robots-Tag", () => {
    expect(headerNoindex("googlebot: noindex")).toBe(true);
    expect(headerNoindex(["index, follow"])).toBe(false);
    expect(headerNoindex(undefined)).toBe(false);
  });
});

describe("parseSitemap", () => {
  it("parses a urlset with lastmod, ignoring image:loc", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <url><loc>https://a.com/one</loc><lastmod>2026-11-10</lastmod><image:image><image:loc>https://a.com/img.png</image:loc></image:image></url>
      <url><loc>https://a.com/two</loc></url></urlset>`;
    const p = parseSitemap(Buffer.from(xml), { url: "https://a.com/sitemap.xml", contentType: "application/xml" });
    expect(p.kind).toBe("urlset");
    if (p.kind !== "urlset") return;
    expect(p.entries.map((e) => e.url)).toEqual(["https://a.com/one", "https://a.com/two"]);
    expect(p.entries[0]!.lastmod).toBe("2026-11-10T00:00:00.000Z");
  });

  it("parses news sitemaps with titles and publication dates", () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url><loc>https://n.com/a</loc><news:news><news:publication><news:name>N</news:name></news:publication>
      <news:publication_date>2026-11-11T21:17:30.578+00:00</news:publication_date><news:title><![CDATA[Remains & more]]></news:title></news:news></url></urlset>`;
    const p = parseSitemap(Buffer.from(xml), { url: "https://n.com/news-sitemap.xml", contentType: "text/xml" });
    expect(p.format).toBe("news");
    if (p.kind !== "urlset") return;
    expect(p.entries[0]).toMatchObject({ url: "https://n.com/a", title: "Remains & more", publishedAt: "2026-11-11T21:17:30.578Z" });
  });

  it("parses sitemap indexes and gzip", () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://a.com/s1.xml</loc></sitemap><sitemap><loc>https://a.com/s2.xml</loc></sitemap></sitemapindex>`;
    const p = parseSitemap(gzipSync(xml), { url: "https://a.com/sitemap.xml.gz", contentType: "application/x-gzip" });
    expect(p).toEqual({ kind: "index", format: "sitemapindex", children: ["https://a.com/s1.xml", "https://a.com/s2.xml"] });
  });

  it("refuses a gzip sitemap that expands past maxBytes", () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024));
    let err: unknown;
    try {
      parseSitemap(bomb, { url: "https://a.com/sitemap.xml.gz", contentType: "application/x-gzip", maxBytes: 64 * 1024 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SitemapParseError);
    expect((err as SitemapParseError).code).toBe("too_large");
  });

  it("parses both sitemap.json shapes", () => {
    const pages = JSON.stringify({ fields: {}, pages: [{ url: "https://s.com/m/", title: "M", created: "2026-11-11", contentUpdated: "2026-11-11", pageUpdated: "2026-11-12" }] });
    const docs = JSON.stringify({ site: "https://c.ai", count: 1, documents: [{ url: "https://c.ai/docs/x", title: "X", created: "2026-01-24" }] });
    const a = parseSitemap(Buffer.from(pages), { url: "https://s.com/sitemap.json", contentType: "application/json" });
    const b = parseSitemap(Buffer.from(docs), { url: "https://c.ai/sitemap.json", contentType: "application/json; charset=utf-8" });
    expect(a.kind === "json" && a.entries[0]).toMatchObject({ title: "M", created: "2026-11-11T00:00:00.000Z", lastmod: "2026-11-12T00:00:00.000Z" });
    expect(b.kind === "json" && b.entries[0]).toMatchObject({ url: "https://c.ai/docs/x", created: "2026-01-24T00:00:00.000Z" });
  });

  it("rejects HTML served as sitemap.json or sitemap.xml", () => {
    const htmlPage = Buffer.from("<!doctype html><html><body>app</body></html>");
    expect(() => parseSitemap(htmlPage, { url: "https://x.com/sitemap.json", contentType: "text/html" })).toThrowError(SitemapParseError);
    try {
      parseSitemap(htmlPage, { url: "https://x.com/sitemap.json", contentType: "text/html" });
    } catch (e) {
      expect((e as SitemapParseError).code).toBe("not_json");
    }
    expect(() => parseSitemap(htmlPage, { url: "https://x.com/sitemap.xml", contentType: "text/html" })).toThrowError(/HTML/);
    expect(() => parseSitemap(Buffer.from("<urlset><url><loc>x</loc></urlset>"), { url: "https://x.com/s.xml", contentType: "text/xml" })).toThrowError(/invalid XML/);
  });
});

describe("rdap", () => {
  it("parses expiry, registrar, nameservers and status", () => {
    const r = parseRdap("drifts.bot", {
      events: [{ eventAction: "registration", eventDate: "2025-02-21T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-02-21T12:00:00Z" }],
      entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "NameCheap, Inc"]]] }],
      nameservers: [{ ldhName: "FRANK.NS.CLOUDFLARE.COM" }, { ldhName: "autumn.ns.cloudflare.com" }],
      status: ["client transfer prohibited", "client hold"],
    });
    expect(r).toMatchObject({
      expiresAt: "2027-02-21T12:00:00.000Z",
      registrar: "NameCheap, Inc",
      nameservers: ["autumn.ns.cloudflare.com", "frank.ns.cloudflare.com"],
    });
    expect(badStatuses(r.statusFlags)).toEqual(["client hold"]);
  });
});

describe("measureHtml: links as a reader meets them (dead ends plan, part 4)", () => {
  const html = `<html lang="pt-BR"><body><header><nav><a href="/a">Início</a></nav><a href="/logo"><img src="x.png" alt="Logo"></a></header>
<main><article><header><a href="/byline">Autor</a></header><p>Leia <a href="/b">clique aqui</a> e <a href="/c">&Aacute;rea &aacute;</a> <a href="/d"><img src="y"></a> <a href="/e" aria-label="Fechar"></a> <a href="/f" aria-labelledby="x"></a> <a href="mailto:x@y.z">mail</a></p><form><input name="q"></form></article></main>
<div role="navigation"><div><a href="/g">G</a></div></div><a href="/h">H <svg><title>seta</title><path d="M0"/></svg></a><script>var s='<a href="/no">no</a>'</script><footer><a href="/i">I</a></footer></body></html>`;
  const w = measureHtml(html, "https://x.test/p/q");

  it("reads the language and a search form", () => {
    expect(w.lang).toBe("pt");
    expect(w.searchForm).toBe(true);
    expect(measureHtml("<html><body><form><input name='email'></form></body></html>", "https://x.test/").searchForm).toBe(false);
  });

  it("labels each link by its text, aria-label, image alt or aria-labelledby, decoding accents by case", () => {
    expect(w.anchors.map((a) => [a.href.replace("https://x.test", ""), a.label])).toEqual([
      ["/a", "Início"], ["/logo", "Logo"], ["/byline", "Autor"], ["/b", "clique aqui"], ["/c", "Área á"], ["/d", ""], ["/e", "Fechar"], ["/f", "(labelled by id)"], ["/g", "G"], ["/h", "H seta"], ["/i", "I"],
    ]);
  });

  it("counts <nav>, role=navigation and the page's own header and footer as navigation, not an article's header", () => {
    expect(w.anchors.filter((a) => a.inChrome).map((a) => a.href.replace("https://x.test", ""))).toEqual(["/a", "/logo", "/g", "/i"]);
  });
});

describe("prefetches", () => {
  it("reads speculation rules from the HTML, with the spec's default eagerness", () => {
    const rules = (json: string) => `<script type="speculationrules">${json}</script>`;
    const page = `<html><head>${rules(`{"prefetch":[{"where":{"href_matches":"/*"},"eagerness":"moderate"}],"prerender":[{"where":{"href_matches":"/*"}}]}`)}${rules(`{"prefetch":[{"urls":["/next"]},{"where":{"href_matches":"/a"},"eagerness":"moderate"}]}`)}</head></html>`;
    expect(measureHtml(page, "https://s.example/").speculation).toEqual([
      { action: "prefetch", eagerness: "moderate" },
      { action: "prerender", eagerness: "conservative" },
      { action: "prefetch", eagerness: "immediate" },
    ]);
    expect(speculationRules("not json")).toEqual([]);
    expect(measureHtml("<p>none</p>", "https://s.example/").speculation).toEqual([]);
  });

  it("decodes entities in link hrefs, as a browser does (&amp; is &)", () => {
    const w = measureHtml(`<a href="https://www.akleg.gov/basis/aac.asp?media=print&amp;secStart=5.24.370&#38;secEnd=5.24.370">AAC</a><a href="/a?x=1&amp;y=2">a</a>`, "https://s.example/");
    expect(w.links).toEqual(["https://www.akleg.gov/basis/aac.asp?media=print&secStart=5.24.370&secEnd=5.24.370", "https://s.example/a?x=1&y=2"]);
    expect(parseHead(`<head><link rel="canonical" href="https://s.example/?p=1&amp;q=2"></head>`).canonical).toBe("https://s.example/?p=1&q=2");
  });
});

describe("page weight from HTML", () => {
  it("counts scripts, repeated framework data, assets, images, svg and links", () => {
    const html = `<html><head>
      <script src="/a.js"></script><script src="https://cdn.other.net/x.js"></script><script src="/a.js"></script>
      <link rel="stylesheet" href="/s.css"><link rel="preload" href="/f.woff2">
      </head><body>
      <script>self.__next_f.push([1,"page data"])</script><script>var x = 1;</script>
      <script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
      <img src="a.png"><img src="b.png" loading="lazy">
      <svg viewBox="0 0 1 1"><path d="M0 0"/></svg>
      <a href="/about#team">About</a><a href="/about">Again</a><a href="mailto:x@y.z">Mail</a><a href="#top">Top</a><a href="https://elsewhere.org/">Out</a>
      </body></html>`;
    const w = measureHtml(html, "https://news.example/");
    expect(w.scripts).toBe(6);
    expect(w.jsUrls).toEqual(["https://news.example/a.js", "https://cdn.other.net/x.js"]);
    expect(w.cssUrls).toEqual(["https://news.example/s.css"]);
    expect(w.frameworkBytes).toBe(Buffer.byteLength('self.__next_f.push([1,"page data"])') + Buffer.byteLength('{"props":{}}'));
    expect(w.inlineScriptBytes).toBe(w.frameworkBytes + Buffer.byteLength("var x = 1;"));
    expect([w.images, w.lazyImages]).toEqual([2, 1]);
    expect(w.svgBytes).toBe(Buffer.byteLength('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'));
    expect(w.links).toEqual(["https://news.example/about", "https://elsewhere.org/"]);
  });
});

describe("the form's config", () => {
  it("normalises addresses", () => {
    expect(normaliseUrl("example.com")).toBe("https://example.com");
    expect(normaliseUrl("http://a.test/x/")).toBe("http://a.test/x");
    expect(normaliseUrl("ftp://a.test")).toBeNull();
    expect(normaliseUrl("localhost")).toBeNull();
  });
});
