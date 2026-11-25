/**
 * Test servers and fake results for the checks: a local HTTP site whose routes a test
 * can change, a tiny MCP server, and fetch results without a network. Local addresses
 * need MONITOR_ALLOW_LOCAL=1 (tests only, never set when deployed).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { hopOf, type FetchResult } from "../http/request.js";
import { createFakeMcp, type FakeMcpState } from "./fake-mcp.js";

export interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  gzip?: boolean;
  delayMs?: number;
}

/** A tiny HTTP server whose routes can be changed during a test. */
export async function testServer(routes: Record<string, Route | ((req: http.IncomingMessage) => Route | Promise<Route>)> = {}) {
  const table = new Map(Object.entries(routes));
  const hits = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const entry = table.get(path);
    const r: Route = typeof entry === "function" ? await entry(req) : entry ?? { status: 404, body: "not found" };
    if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    let body = typeof r.body === "string" ? Buffer.from(r.body) : r.body ?? Buffer.alloc(0);
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", ...r.headers };
    if (r.gzip) {
      body = zlib.gzipSync(body);
      headers["content-encoding"] = "gzip";
    }
    res.writeHead(r.status ?? 200, headers);
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    set(path: string, r: Route | ((req: http.IncomingMessage) => Route | Promise<Route>)) {
      table.set(path, r);
    },
    hits: (path: string) => hits.get(path) ?? 0,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

export function page(opts: { title?: string | null; noindex?: boolean; canonical?: string | null; body?: string } = {}): string {
  const title = opts.title === null ? "" : `<title>${opts.title ?? "Test page"}</title>`;
  const robots = opts.noindex ? `<meta name="robots" content="noindex, follow">` : "";
  const canonical = opts.canonical ? `<link rel="canonical" href="${opts.canonical}">` : "";
  return `<!doctype html><html><head>${title}${robots}${canonical}</head><body>${opts.body ?? "x".repeat(4000)}</body></html>`;
}

export function urlset(urls: Array<{ loc: string; lastmod?: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`)
    .join("")}</urlset>`;
}

/** A tiny streamable-HTTP MCP server on its own port (the handler is shared with the dev fake site). */
export async function fakeMcpServer(initial: Partial<FakeMcpState> = {}) {
  const mcp = createFakeMcp(initial);
  const server = http.createServer((req, res) => mcp.handle(req, res));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, state: mcp.state, calls: mcp.calls, sessions: mcp.sessions, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** A fetchUrl result without a network: what a fake fetch hands the code under test. */
export function fakeFetchResult(url: string, statusCode: number | null, body = "", headers: Record<string, string> = {}): FetchResult {
  const buf = Buffer.from(body);
  return {
    url, finalUrl: url, statusCode, headers, redirects: [], body: buf, bytes: buf.length, wireBytes: buf.length, truncated: false,
    error: statusCode === null ? "timeout" : null, errorMessage: statusCode === null ? "timed out" : null, tls: null,
    timings: { dnsMs: null, connectMs: null, tlsMs: null, ttfbMs: 1, downloadMs: 1, totalMs: 2 },
  } as unknown as FetchResult;
}

/**
 * A fake fetch that follows redirects the way fetchUrl does (maxRedirects, stayOn, a bad
 * Location), over `answer` for each single request: for code that hands fetchUrl's
 * redirect options to an injected fetch.
 */
export function redirecting(answer: (url: string) => FetchResult | Promise<FetchResult>) {
  return async (url: string, opts: { maxRedirects?: number; stayOn?: ReadonlySet<string> } = {}): Promise<FetchResult> => {
    const max = opts.maxRedirects ?? 10;
    const redirects: FetchResult["redirects"] = [];
    let current = url;
    for (let hop = 0; ; hop++) {
      const res = await answer(current);
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      if (res.statusCode === null || res.statusCode < 300 || res.statusCode >= 400 || !location) return { ...res, url, finalUrl: current, redirects };
      if (hop >= max) return { ...res, url, finalUrl: current, redirects, error: "too_many_redirects", errorMessage: `more than ${max} redirects` };
      redirects.push(hopOf(current, res.statusCode, res.headers));
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { ...res, url, finalUrl: current, redirects, error: "invalid_url", errorMessage: `bad Location: ${location}` };
      }
      current = next.toString();
      if (opts.stayOn && !opts.stayOn.has(next.hostname.toLowerCase())) return { ...res, url, finalUrl: current, redirects, error: "redirect_off_host", errorMessage: `redirects off the site to ${next.hostname}` };
    }
  };
}

/** A site's answer to a made-up path: a 404 page that links home, unless told otherwise. */
export function notFoundPage(url: string, status = 404, html = "<html lang='en'><body><h1>Not found</h1><a href='/'>Home</a></body></html>", headers: Record<string, string> = {}): FetchResult {
  return fakeFetchResult(url, status, html, { "content-type": "text/html; charset=utf-8", ...headers });
}
