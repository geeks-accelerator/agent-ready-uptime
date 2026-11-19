import http from "node:http";
import { PAGE_JS, renderPage } from "./page.js";
import type { Runner } from "./runner.js";

/**
 * The status page's server: GET only, no forms, nothing on it changes anything. It
 * binds to 127.0.0.1 unless told otherwise (it shows the sites you watch; exposing
 * it is the operator's choice). /healthz for platforms that probe one.
 */
const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function pageServer(runner: Runner): http.Server {
  return http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...HEADERS, allow: "GET, HEAD", "content-type": "text/plain" }).end("GET only\n");
      return;
    }
    if (path === "/") {
      const body = renderPage(runner.config, runner.state, [...runner.targets.values()]);
      res.writeHead(200, { ...HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(req.method === "HEAD" ? undefined : body);
    } else if (path === "/page.js") {
      res.writeHead(200, { ...HEADERS, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }).end(PAGE_JS);
    } else if (path === "/healthz") {
      res.writeHead(200, { ...HEADERS, "content-type": "text/plain" }).end("ok\n");
    } else {
      res.writeHead(404, { ...HEADERS, "content-type": "text/plain" }).end("not found\n");
    }
  });
}
