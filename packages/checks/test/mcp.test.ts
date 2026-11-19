import { afterEach, describe, expect, it } from "vitest";
import { checkMcp, canonicalJson, FINGERPRINT_VERSION } from "../src/mcp/check.js";
import { fakeMcpServer, testServer } from "../src/testing/servers.js";

describe("checkMcp", () => {
  let mcp: Awaited<ReturnType<typeof fakeMcpServer>> | null = null;
  afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  it("does the handshake, lists tools, fingerprints them and closes the session", async () => {
    mcp = await fakeMcpServer();
    const r = await checkMcp(mcp.url);
    expect(r).toMatchObject({ ok: true, statusCode: 200, title: "2 tools", hasTitle: true });
    expect((r.fingerprintData as Array<{ name: string }>).map((t) => t.name)).toEqual(["adopt", "feed"]);
    expect(mcp.calls).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"]);
    expect(mcp.sessions.size).toBe(0);
    expect(r.timings.ttfbMs).toBeGreaterThanOrEqual(0);
  });

  it("reads event-stream replies, and changes its fingerprint when a tool or schema changes", async () => {
    mcp = await fakeMcpServer({ sse: true });
    const a = await checkMcp(mcp.url);
    expect(a.ok).toBe(true);
    mcp.state.tools = [{ name: "adopt", inputSchema: { type: "object", required: ["species"] } }, { name: "feed" }];
    const b = await checkMcp(mcp.url);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(await checkMcp(mcp.url)).toMatchObject({ fingerprint: b.fingerprint });
  });

  it("names what went wrong", async () => {
    mcp = await fakeMcpServer({ auth: true });
    expect(await checkMcp(mcp.url)).toMatchObject({ ok: false, error: "mcp_auth_required" });
    mcp.state.auth = false;
    mcp.state.tools = [];
    expect(await checkMcp(mcp.url)).toMatchObject({ ok: false, error: "mcp_no_tools" });
    mcp.state.garbage = true;
    expect(await checkMcp(mcp.url)).toMatchObject({ ok: false, error: "mcp_bad_response" });
    mcp.state.status = 503;
    expect(await checkMcp(mcp.url)).toMatchObject({ ok: false, error: "http_503" });
  });

  it("times out like any check", async () => {
    const srv = await testServer({ "/mcp": { delayMs: 500, body: "{}" } });
    try {
      expect(await checkMcp(`${srv.url}/mcp`, { timeoutMs: 100 })).toMatchObject({ ok: false, error: "timeout" });
    } finally {
      await srv.close();
    }
  });
});

describe("MCP fingerprints", () => {
  it("are canonical: the same schema with its keys in another order fingerprints the same", async () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 }));
    const mcp = await fakeMcpServer({ tools: [{ name: "feed", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }] });
    try {
      const a = await checkMcp(mcp.url);
      mcp.state.tools = [{ name: "feed", inputSchema: { required: ["id"], properties: { id: { type: "string" } }, type: "object" } }];
      const b = await checkMcp(mcp.url);
      expect(a.fingerprint).toMatch(new RegExp(`^${FINGERPRINT_VERSION}[0-9a-f]{16}$`));
      expect(b.fingerprint).toBe(a.fingerprint);
    } finally {
      await mcp.close();
    }
  });
});
