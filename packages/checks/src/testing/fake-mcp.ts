/**
 * A tiny streamable-HTTP MCP server: initialize, notifications/initialized,
 * tools/list, tools/call, DELETE. Used by the dev fake site (/mcp) and by the tests.
 */
import type http from "node:http";

export interface FakeMcpState {
  tools: Array<{ name: string; inputSchema?: unknown }>;
  /** Answer with text/event-stream instead of JSON. */
  sse: boolean;
  /** Require a bearer token (answers 401 without one). */
  auth: boolean;
  /** HTTP status for every request (e.g. 503); 0 = normal. */
  status: number;
  /** Reply with something that isn't JSON-RPC. */
  garbage: boolean;
  /** Tools whose calls return isError. */
  failing: string[];
}

export function createFakeMcp(initial: Partial<FakeMcpState> = {}) {
  const state: FakeMcpState = {
    tools: [{ name: "adopt", inputSchema: { type: "object" } }, { name: "feed" }],
    sse: false,
    auth: false,
    status: 0,
    garbage: false,
    failing: [],
    ...initial,
  };
  const sessions = new Set<string>();
  const calls: string[] = [];
  let next = 0;

  const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (state.status) return void res.writeHead(state.status).end("unavailable");
      if (state.auth && !req.headers.authorization) return void res.writeHead(401).end("auth required");
      if (req.method === "DELETE") {
        sessions.delete(String(req.headers["mcp-session-id"]));
        calls.push("DELETE");
        return void res.writeHead(200).end();
      }
      if (req.method !== "POST") return void res.writeHead(405).end();
      let msg: { id?: number; method?: string; params?: { name?: string; arguments?: unknown } } = {};
      try {
        msg = JSON.parse(body || "{}");
      } catch {
        return void res.writeHead(400).end("bad json");
      }
      calls.push(msg.method ?? "?");
      if (state.garbage) return void res.writeHead(200, { "content-type": "application/json" }).end("<html>oops</html>");
      if (msg.method !== "initialize" && !sessions.has(String(req.headers["mcp-session-id"]))) return void res.writeHead(400).end("no session");
      if (msg.id === undefined) return void res.writeHead(202).end();
      const headers: Record<string, string> = {};
      let result: unknown;
      if (msg.method === "initialize") {
        const id = `s${++next}`;
        sessions.add(id);
        headers["mcp-session-id"] = id;
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
      } else if (msg.method === "tools/list") result = { tools: state.tools };
      else if (msg.method === "tools/call") {
        const name = msg.params?.name ?? "?";
        calls.push(`call:${name}`);
        result = state.failing.includes(name)
          ? { isError: true, content: [{ type: "text", text: `${name} failed` }] }
          : { content: [{ type: "text", text: `${name} done: ${JSON.stringify(msg.params?.arguments ?? {})}` }] };
      }
      const reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      if (state.sse) res.writeHead(200, { ...headers, "content-type": "text/event-stream" }).end(`event: message\ndata: ${reply}\n\n`);
      else res.writeHead(200, { ...headers, "content-type": "application/json" }).end(reply);
    });
  };
  return { state, sessions, calls, handle };
}
