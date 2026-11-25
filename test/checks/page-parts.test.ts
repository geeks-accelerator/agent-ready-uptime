import { describe, expect, it } from "vitest";
import { cdnScriptOf, measureHtml } from "../../src/checks/html/weight.js";
import { usesXslt } from "../../src/checks/sitemap/fetch.js";

describe("scripts, data blocks and what the CDN added", () => {
  const page = `<!doctype html><html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"X"}</script>
    <script type="application/ld+json">{"@type":"WebSite"}</script>
    <script type="importmap">{"imports":{}}</script>
    <script type="speculationrules">{"prefetch":[{"source":"document","eagerness":"moderate"}]}</script>
    <script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
    <script>console.log("hi")</script>
    <script src="/app.js"></script>
    <script src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>
    <script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>
  </head><body></body></html>`;
  const w = measureHtml(page, "https://patent.test/");

  it("counts JSON-LD, JSON, import maps and speculation rules as data, never as scripts", () => {
    expect(w.dataBlocks).toBe(4);
    expect(w.dataBytes).toBeGreaterThan(0);
    // __NEXT_DATA__, the inline script, the site's file and Cloudflare's two.
    expect(w.scripts).toBe(5);
    expect(w.inlineScriptBytes).toBe(Buffer.byteLength('{"props":{}}') + Buffer.byteLength('console.log("hi")'));
    expect(w.speculation).toHaveLength(1); // still read
    expect(w.frameworkBytes).toBe(Buffer.byteLength('{"props":{}}'));
  });

  it("names the scripts Cloudflare added", () => {
    expect(w.cdnScripts).toEqual(["email_protection", "web_analytics"]);
    expect(cdnScriptOf("https://x.test/cdn-cgi/scripts/7d0fa10a/cloudflare-static/rocket-loader.min.js")).toBe("rocket_loader");
    expect(cdnScriptOf("https://x.test/cdn-cgi/challenge-platform/scripts/jsd/main.js")).toBe("challenge");
    expect(cdnScriptOf("https://x.test/app.js")).toBeNull();
  });
});

describe("usesXslt", () => {
  const xml = (pi: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${pi}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`);
  it("finds an XSLT stylesheet by its type or its file", () => {
    expect(usesXslt(xml(`<?xml-stylesheet type="text/xsl" href="//x.test/main-sitemap.xsl"?>`))).toBe(true);
    expect(usesXslt(xml(`<?xml-stylesheet href="/wp-sitemap.xsl" type="text/xsl"?>`))).toBe(true);
    expect(usesXslt(xml(`<?xml-stylesheet href="/sitemap.xslt"?>`))).toBe(true);
  });
  it("leaves CSS stylesheets and plain sitemaps alone", () => {
    expect(usesXslt(xml(`<?xml-stylesheet type="text/css" href="/sitemap.css"?>`))).toBe(false);
    expect(usesXslt(xml(""))).toBe(false);
  });
});
