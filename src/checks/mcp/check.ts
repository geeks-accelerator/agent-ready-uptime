/**
 * MCP server check (streamable HTTP): the handshake an agent does on
 * connect, then `tools/list`. Plain JSON-RPC over fetchUrl, so it gets the
 * same timeouts, size caps and timing as every other check, and returns a
 * normal PageCheckResult (timings and status from `initialize`) so the
 * engine handles it like any page.
 */
import { createHash } from "node:crypto";
import { evaluate, type PageCheckResult } from "../http/page-check.js";
import { fetchUrl, headerValue, type FetchResult, type RequestProfile } from "../http/request.js";

/** The protocol version we ask for; servers answer with the one they speak. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOL_PAGES = 5;

export interface McpTool {
  name: string;
  /** Short hash of the input schema: a change here can break callers. */
  schema: string;
}

export interface McpCheckOptions {
  timeoutMs?: number;
  profile?: RequestProfile;
}

/** A tool as the server lists it, for an agent that will call it. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type RpcOutcome = { ok: true; result: unknown; res: FetchResult } | { ok: false; error: string; res: FetchResult };

/**
 * One MCP session over streamable HTTP: the handshake an agent does on
 * connect, `tools/list`, `tools/call` and a polite close. Plain JSON-RPC over
 * fetchUrl, so it gets the same timeouts, size caps and timing as every other
 * check. Used by the MCP check and by agent journeys.
 */
export class McpSession {
  private id = 0;
  private session: string | null = null;

  constructor(
    readonly url: string,
    private readonly opts: McpCheckOptions & { headers?: Record<string, string> } = {},
  ) {}

  private post(method: string, params: unknown, notification = false): Promise<FetchResult> {
    return fetchUrl(this.url, {
      method: "POST",
      timeoutMs: this.opts.timeoutMs ?? 15_000,
      maxBytes: 2 * 1024 * 1024,
      ...(this.opts.profile ? { profile: this.opts.profile } : {}),
      accept: "application/json, text/event-stream",
      headers: {
        ...this.opts.headers,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(this.session ? { "mcp-session-id": this.session } : {}),
      },
      body: JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++this.id, method, params }),
    });
  }

  /** A request and its JSON-RPC result (an HTTP error or a JSON-RPC error is not ok). */
  async request(method: string, params: unknown): Promise<RpcOutcome> {
    const res = await this.post(method, params);
    if (res.error || (res.statusCode ?? 0) >= 400) return { ok: false, error: res.errorMessage ?? `HTTP ${res.statusCode}`, res };
    const r = rpcResult(res, this.id);
    return r.ok ? { ok: true, result: r.result, res } : { ok: false, error: r.error, res };
  }

  /** `initialize`, keeping the session id; the raw response is returned for the check's timings and status. */
  async initialize(): Promise<{ res: FetchResult; hello: { ok: true; result: unknown } | { ok: false; error: string } }> {
    const res = await this.post("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "site-monitor", version: "1.0" } });
    const hello = rpcResult(res, this.id);
    if (hello.ok) this.session = headerValue(res.headers["mcp-session-id"]) ?? null;
    return { res, hello };
  }

  /** `notifications/initialized`: null when sent, else the error. */
  async initialized(): Promise<string | null> {
    const ack = await this.post("notifications/initialized", {}, true);
    return ack.error ? (ack.errorMessage ?? ack.error) : null;
  }

  /** Every tool, following `nextCursor` (at most MAX_TOOL_PAGES pages). */
  async listTools(): Promise<{ ok: true; tools: McpToolDef[] } | { ok: false; error: string }> {
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      if (!r.ok) return { ok: false, error: r.error };
      const list = r.result as { tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>; nextCursor?: unknown };
      for (const t of list.tools ?? []) {
        if (typeof t.name === "string") tools.push({ name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), inputSchema: t.inputSchema });
      }
      cursor = typeof list.nextCursor === "string" && list.nextCursor ? list.nextCursor : undefined;
      if (!cursor) break;
    }
    return { ok: true, tools };
  }

  callTool(name: string, args: unknown): Promise<RpcOutcome> {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  /** Close the session politely; nothing depends on it. */
  async close(): Promise<void> {
    if (this.session) await fetchUrl(this.url, { method: "DELETE", timeoutMs: 5000, headers: { ...this.opts.headers, "mcp-session-id": this.session, "mcp-protocol-version": MCP_PROTOCOL_VERSION } });
  }
}

export async function checkMcp(url: string, opts: McpCheckOptions = {}): Promise<PageCheckResult> {
  const checkedAt = new Date().toISOString();
  const s = new McpSession(url, opts);
  const { res: init, hello } = await s.initialize();
  const result = evaluate(init, checkedAt, { seoChecks: false });
  const fail = (error: string, detail: string): PageCheckResult => ({ ...result, ok: false, error, errorDetail: detail });
  if (!result.ok) {
    if (init.statusCode === 401 || init.statusCode === 403) return fail("mcp_auth_required", `MCP server requires auth (HTTP ${init.statusCode})`);
    return result;
  }
  if (!hello.ok) return fail("mcp_bad_response", `initialize: ${hello.error}`);

  try {
    const ackError = await s.initialized();
    if (ackError) return fail("mcp_bad_response", `notifications/initialized: ${ackError}`);
    const listed = await s.listTools();
    if (!listed.ok) return fail("mcp_bad_response", `tools/list: ${listed.error}`);
    const tools: McpTool[] = listed.tools.map((t) => ({ name: t.name, schema: hash(canonicalJson(t.inputSchema ?? null)).slice(0, 12) }));
    if (tools.length === 0) return fail("mcp_no_tools", "tools/list returned no tools");

    tools.sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...result,
      title: `${tools.length} tool${tools.length === 1 ? "" : "s"}`,
      hasTitle: true,
      fingerprint: FINGERPRINT_VERSION + hash(canonicalJson(tools)).slice(0, 16),
      fingerprintData: tools,
    };
  } finally {
    await s.close();
  }
}

/** The JSON-RPC result for request `id`, from a JSON body or a text/event-stream body. */
function rpcResult(res: FetchResult, id: number): { ok: true; result: unknown } | { ok: false; error: string } {
  const text = res.body.toString("utf8");
  const type = headerValue(res.headers["content-type"])?.toLowerCase() ?? "";
  const messages: unknown[] = [];
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) messages.push(parse(data));
    }
  } else {
    const v = parse(text);
    messages.push(...(Array.isArray(v) ? v : [v]));
  }
  const msg = messages.find((m): m is Record<string, unknown> => !!m && typeof m === "object" && (m as { id?: unknown }).id === id);
  if (!msg) return { ok: false, error: messages.length ? "no response for our request" : "not JSON-RPC" };
  if (msg.error) {
    const e = msg.error as { code?: unknown; message?: unknown };
    return { ok: false, error: `error ${String(e.code ?? "")} ${String(e.message ?? "")}`.trim() };
  }
  if (!("result" in msg)) return { ok: false, error: "response has no result" };
  return { ok: true, result: msg.result };
}

function parse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * JSON with object keys sorted at every level, so a server that sends the same schema
 * with its keys in another order gets the same fingerprint. Array order is kept: it
 * can matter (enum order, required lists are compared as written).
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Marks fingerprints made from canonical JSON. A stored fingerprint without it was made
 * the old way (key order as sent), so it's replaced quietly the first time, not reported
 * as a change.
 */
export const FINGERPRINT_VERSION = "c1:";

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
