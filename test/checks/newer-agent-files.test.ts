import { describe, expect, it } from "vitest";
import { discoverAgentFiles } from "../../src/checks/agent/discover.js";
import { AGENT_FILE_KINDS, DISCOVERED_FILE_KINDS, EMERGING_FILE_KINDS, llmsTxtLinks, validateAgentFile } from "../../src/checks/agent/validate.js";
import { jsonLd, organizationFacts } from "../../src/checks/html/head.js";
import { testServer } from "../../src/checks/testing/servers.js";

const json = "application/json";
const site = "https://example.com/x";

describe("the newer agent files", () => {
  it("grades an API catalog (RFC 9727)", () => {
    expect(validateAgentFile("api_catalog", JSON.stringify({ linkset: [{ anchor: "https://example.com/api", "service-desc": [{ href: "/openapi.json" }] }] }), "application/linkset+json", site)).toMatchObject({ error: null, summary: "1 entry" });
    expect(validateAgentFile("api_catalog", JSON.stringify({ linkset: [] }), json, site).reason).toBe("no_linkset");
    expect(validateAgentFile("api_catalog", JSON.stringify({ linkset: [{ href: "x" }] }), json, site).reason).toBe("no_linkset");
    expect(validateAgentFile("api_catalog", "nope", "text/plain", site).reason).toBe("not_json");
  });

  it("grades an agent skills index", () => {
    expect(validateAgentFile("skills_index", JSON.stringify({ skills: [{ name: "a" }, { name: "b" }] }), json, site).summary).toBe("2 skills");
    expect(validateAgentFile("skills_index", JSON.stringify({ skills: [{ description: "no name" }] }), json, site).reason).toBe("no_skills");
  });

  it("grades an AI catalog", () => {
    expect(validateAgentFile("ai_catalog", JSON.stringify({ specVersion: "1.0", entries: [{ identifier: "x" }, { identifier: "y" }] }), "application/ai-catalog+json", site).summary).toBe("2 entries");
    expect(validateAgentFile("ai_catalog", JSON.stringify({ entries: [] }), json, site).reason).toBe("no_entries");
  });

  it("grades an MCP server card: a name and an endpoint", () => {
    const ok = validateAgentFile("mcp_server_card", JSON.stringify({ name: "com.example/x", remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }] }), "application/mcp-server-card+json", site);
    expect(ok).toMatchObject({ error: null, summary: "MCP at /mcp", mcpEndpoint: "https://example.com/mcp" });
    expect(validateAgentFile("mcp_server_card", JSON.stringify({ remotes: [{ url: "https://example.com/mcp" }] }), json, site).reason).toBe("no_name");
    expect(validateAgentFile("mcp_server_card", JSON.stringify({ name: "x" }), json, site).reason).toBe("no_endpoint");
    expect(validateAgentFile("mcp_server_card", JSON.stringify({ name: "x", remotes: [{ url: "ftp://example.com" }] }), json, site).reason).toBe("bad_endpoint");
  });

  it("an HTML fallback is never one of them", () => {
    for (const k of EMERGING_FILE_KINDS) expect(validateAgentFile(k, "<!doctype html><p>app</p>", "text/html", site).reason).toBe("html_fallback");
  });

  it("discovery reads only the settled files unless asked", () => {
    expect(DISCOVERED_FILE_KINDS).toEqual(["llms_txt", "agent_card", "openapi", "mcp_manifest", "robots_txt", "security_txt"]);
    expect(AGENT_FILE_KINDS).toEqual([...DISCOVERED_FILE_KINDS, ...EMERGING_FILE_KINDS]);
  });

  it("reads the AI catalog at ard.json when ai-catalog.json isn't there", async () => {
    const s = await testServer({ "/.well-known/ard.json": { headers: { "content-type": "application/ai-catalog+json" }, body: JSON.stringify({ entries: [{ identifier: "x" }] }) } });
    try {
      const r = await discoverAgentFiles(`${s.url}/`, { kinds: ["ai_catalog"], probes: false });
      expect(r.files[0]!.url).toBe(`${s.url}/.well-known/ard.json`);
      expect(r.files[0]!.result.ok).toBe(true);
      expect(s.hits("/.well-known/ai-catalog.json")).toBe(1);
    } finally {
      await s.close();
    }
  });
});

describe("llms.txt's links", () => {
  it("keeps the site's own links, absolute, once each, without fragments, at most ten", () => {
    const body = ["# Site", "", "- [Docs](/docs)", "- [Docs again](https://example.com/docs#top)", "- [Away](https://other.example/page)", "- [WWW](https://www.example.com/about \"About us\")", "- [Mail](mailto:hi@example.com)", ...Array.from({ length: 20 }, (_, i) => `- [P${i}](/p/${i})`)].join("\n");
    const links = llmsTxtLinks(body, "https://example.com/llms.txt");
    expect(links.slice(0, 3)).toEqual(["https://example.com/docs", "https://www.example.com/about", "https://example.com/p/0"]);
    expect(links).toHaveLength(10);
  });
});

describe("Organization facts", () => {
  const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

  it("says what the Organization gives, never its values", () => {
    const html = ld({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "x" }, { "@type": "Organization", name: "Example", description: "We make things.", logo: "https://example.com/l.png", sameAs: ["https://github.com/example", "https://x.com/example"], contactPoint: { "@type": "ContactPoint", email: "hi@example.com" } }] });
    expect(organizationFacts(html)).toEqual({ found: true, name: true, description: true, logo: true, sameAs: 2, contact: true });
  });

  it("counts kinds of Organization, and none at all", () => {
    expect(organizationFacts(ld({ "@type": "LocalBusiness", name: "Shop", telephone: "+1 555" }))).toMatchObject({ found: true, contact: true, description: false, sameAs: 0 });
    expect(organizationFacts(ld({ "@type": "NewsMediaOrganization", name: "News" })).found).toBe(true);
    expect(organizationFacts(ld({ "@type": "WebSite", name: "x" })).found).toBe(false);
    expect(organizationFacts("<p>no data</p>").found).toBe(false);
  });

  it("jsonLd still reads the same types after the shared walk", () => {
    expect(jsonLd(ld({ "@graph": [{ "@type": ["Organization", "Brand"] }, { "@type": "WebSite" }] }) + "<script type=\"application/ld+json\">{bad</script>")).toEqual({ types: ["Brand", "Organization", "WebSite"], invalid: 1 });
  });
});
