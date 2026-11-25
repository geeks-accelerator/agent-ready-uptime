import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { performance } from "node:perf_hooks";
import zlib from "node:zlib";
import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import net from "node:net";
import type { Transform } from "node:stream";
import { signatureHeaders, signerFrom, type Signer } from "./sign.js";
import { headerNoindex } from "../html/head.js";

/** Our honest user agent: `MONITOR_USER_AGENT` names your monitor instead (site owners allowlist it in their WAF). */
export const DEFAULT_USER_AGENT =
  process.env.MONITOR_USER_AGENT ??
  "agent-ready-uptime (+https://github.com/geeks-accelerator/agent-ready-uptime)";

/** Desktop Chrome on macOS. Bump the version a couple of times a year. */
export const BROWSER_USER_AGENT =
  process.env.BROWSER_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/**
 * How a request presents itself.
 * - monitor: our honest UA (allowlist it in our own WAF). It asks for pages as a reader does,
 *   so the CDN cache status it records is what readers get.
 * - browser: what a reader's Chrome sends (competitors), so bot rules and CDN caches treat it like a visitor.
 * - { userAgent }: a crawler's own user agent with a bot's plain headers, for the crawler probes on
 *   sites we own (is the door open to Googlebot, GPTBot…?).
 */
export type RequestProfile = "monitor" | "browser" | { userAgent: string };

const DEFAULT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7";

export function requestHeaders(profile: RequestProfile, accept?: string): Record<string, string> {
  if (profile === "browser") {
    return {
      "user-agent": BROWSER_USER_AGENT,
      accept: accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "gzip, deflate, br",
      "upgrade-insecure-requests": "1",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      connection: "close",
    };
  }
  return {
    "user-agent": typeof profile === "object" ? profile.userAgent : DEFAULT_USER_AGENT,
    accept: accept ?? (typeof profile === "object" ? "*/*" : DEFAULT_ACCEPT),
    "accept-encoding": "gzip, deflate, br",
    connection: "close",
  };
}

/** Transport-level failure (no usable HTTP response). */
export type TransportError =
  | "dns"
  | "timeout"
  | "refused"
  | "reset"
  | "tls"
  | "network"
  | "too_many_redirects"
  /** A redirect left the hosts `stayOn` allows; `finalUrl` is where it pointed, not fetched. */
  | "redirect_off_host"
  | "invalid_url";

export interface Timings {
  /** DNS lookup (0 when the host is an IP literal or the lookup was cached). */
  dnsMs: number;
  /** TCP connect, after DNS. */
  connectMs: number;
  /** TLS handshake, after connect (0 for plain http). */
  tlsMs: number;
  /**
   * Time to first byte of the final hop, measured from the start of that hop
   * (includes DNS + connect + TLS, like curl's `time_starttransfer`). The
   * server's own think time is ttfb - dns - connect - tls.
   */
  ttfbMs: number;
  /** Body download for the final hop. */
  downloadMs: number;
  /** Time spent on redirect hops before the final one. */
  redirectMs: number;
  /** Whole request including redirects. */
  totalMs: number;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TlsInfo {
  /** When the certificate starts: with `validTo`, its lifetime, which says when a self-renewing one should have renewed. */
  validFrom: string | null;
  validTo: string | null;
  issuer: string | null;
  protocol: string | null;
}

/**
 * A cache's answer as a response's headers give it, from a closed list, so nothing else a site
 * sends is kept: Cloudflare's `cf-cache-status` first, then Next.js's and Vercel's own.
 */
export const CACHE_STATES = ["HIT", "MISS", "STALE", "EXPIRED", "BYPASS", "DYNAMIC", "REVALIDATED", "UPDATING", "PRERENDER"] as const;
export type CacheState = (typeof CACHE_STATES)[number];
const CACHE_HEADERS = ["cf-cache-status", "x-nextjs-cache", "x-vercel-cache"] as const;

export function cacheOf(headers: IncomingHttpHeaders): CacheState | null {
  for (const h of CACHE_HEADERS) {
    const v = headerValue(headers[h])?.trim().toUpperCase();
    if (v && (CACHE_STATES as readonly string[]).includes(v)) return v as CacheState;
  }
  return null;
}

/** One step of a redirect chain: the address, its status (null: no answer), its cache and whether its headers said noindex. */
export interface Hop {
  url: string;
  statusCode: number | null;
  cache: CacheState | null;
  noindex: boolean;
}

/** A step as every fetcher records it (`fetchUrl`, `fetchOnHost`, the test fetchers): one shape, closed values only. */
export function hopOf(url: string, statusCode: number | null, headers: IncomingHttpHeaders): Hop {
  return { url, statusCode, cache: cacheOf(headers), noindex: headerNoindex(headers["x-robots-tag"]) };
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  headers: IncomingHttpHeaders;
  /** Every redirect followed, in order (`hopOf`): where it was asked, how it answered. */
  redirects: Hop[];
  timings: Timings;
  /** Decompressed body, capped at maxBytes. */
  body: Buffer;
  /** Decompressed bytes received (may exceed body length if truncated). */
  bytes: number;
  /** Bytes as they arrived, before decompression (what crossed the network). */
  wireBytes: number;
  truncated: boolean;
  error: TransportError | null;
  errorMessage: string | null;
  /** Certificate of the first hop (the host we asked for). */
  tls: TlsInfo | null;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Headers to present as (default "monitor"). */
  profile?: RequestProfile;
  accept?: string;
  /** Read the body (default true). False: done at the headers, and the connection is dropped, so the body is never downloaded. */
  readBody?: boolean;
  /** Default GET. Other methods don't follow redirects: the redirect response is the result. */
  method?: HttpMethod;
  body?: string;
  /** Extra request headers, over the profile's (e.g. content-type, a session id). */
  headers?: Record<string, string>;
  /**
   * Allow loopback, private and link-local addresses. Default: only when local
   * addresses are switched on (MONITOR_ALLOW_LOCAL=1: tests, local development, runs
   * against a fake site) and the URL we were asked for is itself local. A deployed
   * monitor leaves it off, so nothing a site serves (a redirect, a sitemap entry, a
   * link, an MCP manifest) can point it at 169.254.169.254 or the LAN, even written
   * as a raw IP: a page linking to http://10.0.0.5/ looked "local" on its own.
   */
  allowPrivate?: boolean;
  /**
   * Follow redirects only to these hosts (lower case), or host:port pairs (`siteOrigins`) to pin the
   * port too. A redirect elsewhere stops with
   * `redirect_off_host`, its status and headers, and `finalUrl` set to where it pointed
   * (never requested). For checks that must stay on a site's own host.
   */
  stayOn?: ReadonlySet<string>;
  /**
   * Sign each hop with Web Bot Auth (`./sign`), so a site's CDN can verify who sent it: this signer,
   * the process's own (`defaultSigner`) when unset, or none for false. Signed
   * afresh per hop, since the signature covers the host. Only the "monitor" profile signs (others ignore it): a
   * crawler probe asks how a site treats a crawler's name, and a signature would change the answer.
   */
  sign?: Signer | false;
}

let envSigner: Signer | null | undefined;
/**
 * The process's own signer, from `MONITOR_SIGNING_KEY` (an Ed25519 private JWK or PEM) and
 * `MONITOR_SIGNATURE_AGENT` (the https origin serving its key directory): every "monitor" request
 * signs with it unless `sign: false`. Unset, nothing signs. A bad key is reported once and nothing
 * signs, since `fetchUrl` never throws.
 */
export function defaultSigner(): Signer | null {
  if (envSigner !== undefined) return envSigner;
  const key = process.env.MONITOR_SIGNING_KEY;
  const agent = process.env.MONITOR_SIGNATURE_AGENT;
  envSigner = null;
  if (key && agent) {
    try {
      envSigner = signerFrom(key, agent, process.env.MONITOR_SIGNATURE_FORM === "dictionary" ? "dictionary" : "item");
    } catch (e) {
      console.error(`MONITOR_SIGNING_KEY is set but can't sign: ${(e as Error).message}`);
    }
  }
  return envSigner;
}

/**
 * Loopback, private, link-local, CGNAT, benchmark, unspecified, multicast and
 * reserved addresses, and NAT64. BlockList matches IPv4-mapped IPv6 against
 * the IPv4 rules in every spelling: the URL parser writes `[::ffff:127.0.0.1]`
 * as `::ffff:7f00:1`, which a pattern on the dotted form misses.
 */
const PRIVATE = new net.BlockList();
for (const [a, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) PRIVATE.addSubnet(a, bits, "ipv4");
for (const [a, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) PRIVATE.addSubnet(a, bits, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const family = net.isIP(addr);
  return family !== 0 && PRIVATE.check(addr, family === 4 ? "ipv4" : "ipv6");
}

/** Are local and private addresses switched on for this process (MONITOR_ALLOW_LOCAL=1)? Off in a deployed monitor. */
export function localAddressesAllowed(): boolean {
  return process.env.MONITOR_ALLOW_LOCAL === "1";
}

/** Is this URL's host a private address or a local name (where private addresses are expected)? */
function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || (net.isIP(host) !== 0 && isPrivateAddress(host));
  } catch {
    return false;
  }
}

/** Private addresses are allowed for a connection only when local addresses are switched on and what was asked for is itself local. Shared by page fetches and port and DNS checks. */
export function privateAllowedFor(url: string): boolean {
  return localAddressesAllowed() && isLocalUrl(url);
}

export const blocked = (what: string) =>
  Object.assign(new Error(`refused to connect to a private address (${what})${localAddressesAllowed() ? "" : "; set MONITOR_ALLOW_LOCAL=1 to reach local sites"}`), { code: "SM_BLOCKED" });

/** dns.lookup, refusing private addresses (checked after resolving, so a public name pointing inside is caught too). */
export function publicLookup(hostname: string, options: LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, options.all ? [] : "", 0);
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) return cb(blocked(`${hostname} → ${bad.address}`), options.all ? [] : "", 0);
    if (options.all) return cb(null, addresses);
    const first = addresses[0];
    if (!first) return cb(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), "", 0);
    cb(null, first.address, first.family);
  });
}

interface HopResult {
  statusCode: number;
  headers: IncomingHttpHeaders;
  timings: Omit<Timings, "redirectMs" | "totalMs"> & { hopMs: number };
  body: Buffer;
  bytes: number;
  wireBytes: number;
  truncated: boolean;
  tls: TlsInfo | null;
  error: TransportError | null;
  errorMessage: string | null;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
/** Node stops at 16 KB of response headers ("Header overflow"); browsers take far more, and some sites (polymarket.com, ~15.5 KB) sit right at Node's line. */
const MAX_HEADER_BYTES = 128 * 1024;

/**
 * Request a URL (GET by default) with a fresh connection per hop (no
 * keep-alive), so DNS, connect and TLS are measured every time. Follows GET
 * redirects up to maxRedirects. Never throws: failures come back in `error`.
 */
export async function fetchUrl(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRedirects = opts.maxRedirects ?? 10;
  const allowPrivate = opts.allowPrivate ?? privateAllowedFor(url);
  const signer = (opts.profile ?? "monitor") === "monitor" && opts.sign !== false ? (opts.sign ?? defaultSigner()) : null;
  const start = performance.now();
  const deadline = start + timeoutMs;
  const redirects: FetchResult["redirects"] = [];
  let current = url;
  let firstTls: TlsInfo | null = null;
  let redirectMs = 0;

  const base = (partial: Partial<FetchResult>): FetchResult => ({
    url,
    finalUrl: current,
    statusCode: null,
    headers: {},
    redirects,
    timings: { dnsMs: 0, connectMs: 0, tlsMs: 0, ttfbMs: 0, downloadMs: 0, redirectMs, totalMs: round(performance.now() - start) },
    body: Buffer.alloc(0),
    bytes: 0,
    wireBytes: 0,
    truncated: false,
    error: null,
    errorMessage: null,
    tls: firstTls,
    ...partial,
  });

  for (let hop = 0; ; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    } catch (e) {
      return base({ error: "invalid_url", errorMessage: String((e as Error).message) });
    }
    const literal = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && net.isIP(literal) !== 0 && isPrivateAddress(literal)) {
      return base({ error: "invalid_url", errorMessage: blocked(literal).message });
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) return base({ error: "timeout", errorMessage: `timed out after ${timeoutMs} ms` });

    const res = await requestOnce(parsed, {
      timeoutMs: remaining,
      maxBytes: opts.maxBytes ?? 5 * 1024 * 1024,
      headers: { ...requestHeaders(opts.profile ?? "monitor", opts.accept), ...opts.headers, ...(signer ? signatureHeaders(parsed, signer) : {}) },
      readBody: opts.readBody ?? true,
      method: opts.method ?? "GET",
      allowPrivate,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      // Only read bodies on the final hop.
      isRedirectProbe: hop < maxRedirects,
    });
    if (hop === 0) firstTls = res.tls;

    if (res.error && res.statusCode === 0) {
      return base({
        error: res.error,
        errorMessage: res.errorMessage,
        timings: {
          dnsMs: res.timings.dnsMs,
          connectMs: res.timings.connectMs,
          tlsMs: res.timings.tlsMs,
          ttfbMs: 0,
          downloadMs: 0,
          redirectMs,
          totalMs: round(performance.now() - start),
        },
        tls: firstTls,
      });
    }

    const location = headerValue(res.headers.location);
    if (REDIRECT_CODES.has(res.statusCode) && location && (opts.method ?? "GET") === "GET") {
      if (hop >= maxRedirects) {
        return base({ statusCode: res.statusCode, headers: res.headers, error: "too_many_redirects", errorMessage: `more than ${maxRedirects} redirects` });
      }
      redirects.push(hopOf(current, res.statusCode, res.headers));
      redirectMs += res.timings.hopMs;
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return base({ statusCode: res.statusCode, headers: res.headers, error: "invalid_url", errorMessage: `bad Location: ${location}` });
      }
      current = next.toString();
      const nextPort = next.port || (next.protocol === "https:" ? "443" : "80");
      if (opts.stayOn && !opts.stayOn.has(next.hostname.toLowerCase()) && !opts.stayOn.has(`${next.hostname.toLowerCase()}:${nextPort}`)) {
        return base({ statusCode: res.statusCode, headers: res.headers, error: "redirect_off_host", errorMessage: `redirects off the site to ${next.hostname}` });
      }
      continue;
    }

    return {
      url,
      finalUrl: current,
      statusCode: res.statusCode,
      headers: res.headers,
      redirects,
      timings: {
        dnsMs: res.timings.dnsMs,
        connectMs: res.timings.connectMs,
        tlsMs: res.timings.tlsMs,
        ttfbMs: res.timings.ttfbMs,
        downloadMs: res.timings.downloadMs,
        redirectMs: round(redirectMs),
        totalMs: round(performance.now() - start),
      },
      body: res.body,
      bytes: res.bytes,
      wireBytes: res.wireBytes,
      truncated: res.truncated,
      error: res.error,
      errorMessage: res.errorMessage,
      tls: firstTls,
    };
  }
}

interface OnceOptions {
  timeoutMs: number;
  maxBytes: number;
  headers: Record<string, string>;
  readBody: boolean;
  isRedirectProbe: boolean;
  method: HttpMethod;
  allowPrivate: boolean;
  body?: string;
}

function requestOnce(u: URL, o: OnceOptions): Promise<HopResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let tLookup: number | null = null;
    let tConnect: number | null = null;
    let tSecure: number | null = null;
    let tFirstByte: number | null = null;
    let tls: TlsInfo | null = null;
    let settled = false;
    let statusCode = 0;
    let headers: IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    let bytes = 0;
    let wireBytes = 0;
    let kept = 0;
    let truncated = false;

    const timings = () => {
      const lookupEnd = tLookup ?? t0;
      const connectEnd = tConnect ?? lookupEnd;
      const now = performance.now();
      return {
        dnsMs: round(lookupEnd - t0),
        connectMs: tConnect === null ? 0 : round(connectEnd - lookupEnd),
        tlsMs: tSecure === null ? 0 : round(tSecure - connectEnd),
        ttfbMs: tFirstByte === null ? 0 : round(tFirstByte - t0),
        downloadMs: tFirstByte === null ? 0 : round(now - tFirstByte),
        hopMs: round(now - t0),
      };
    };

    const finish = (error: TransportError | null, errorMessage: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always release the socket (corrupt gzip/brotli, aborted bodies…).
      setImmediate(() => req.destroy());
      resolve({
        statusCode,
        headers,
        timings: timings(),
        body: Buffer.concat(chunks),
        bytes,
        wireBytes,
        truncated,
        tls,
        error,
        errorMessage,
      });
    };

    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method: o.method,
      agent: false,
      maxHeaderSize: MAX_HEADER_BYTES,
      ...(o.allowPrivate ? {} : { lookup: publicLookup as unknown as typeof dns.lookup }),
      headers: o.body !== undefined ? { ...o.headers, "content-length": String(Buffer.byteLength(o.body)) } : o.headers,
    });

    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`timed out after ${Math.round(o.timeoutMs)} ms`), { code: "SM_TIMEOUT" }));
    }, Math.max(1, o.timeoutMs));

    req.on("socket", (socket) => {
      socket.once("lookup", () => (tLookup = performance.now()));
      socket.once("connect", () => (tConnect = performance.now()));
      socket.once("secureConnect", () => {
        tSecure = performance.now();
        const s = socket as TLSSocket;
        try {
          const cert = s.getPeerCertificate();
          tls = {
            validFrom: cert?.valid_from ? new Date(cert.valid_from).toISOString() : null,
            validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null,
            issuer: (cert?.issuer?.O as string | undefined) ?? (cert?.issuer?.CN as string | undefined) ?? null,
            protocol: s.getProtocol?.() ?? null,
          };
        } catch {
          tls = null;
        }
      });
    });

    req.on("response", (res: IncomingMessage) => {
      tFirstByte = performance.now();
      statusCode = res.statusCode ?? 0;
      headers = res.headers;

      const isRedirect = REDIRECT_CODES.has(statusCode) && !!res.headers.location;
      if (!o.readBody || (isRedirect && o.isRedirectProbe)) {
        // Status and headers are all we need: finish now (which drops the connection) instead of downloading a body to discard.
        finish(null, null);
        return;
      }

      res.on("data", (chunk: Buffer) => (wireBytes += chunk.length));
      let stream: IncomingMessage | Transform = res;
      const enc = headerValue(res.headers["content-encoding"])?.toLowerCase().trim();
      if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (kept < o.maxBytes) {
          const room = o.maxBytes - kept;
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          chunks.push(part);
          kept += part.length;
        }
        // Over the limit, not at it: a body of exactly maxBytes is complete.
        if (bytes > o.maxBytes) {
          truncated = true;
          finish(null, null);
          req.destroy();
        }
      });
      stream.on("end", () => finish(null, null));
      stream.on("error", (e: Error) => finish(classify(e), e.message));
      res.on("aborted", () => finish("reset", "response aborted"));
    });

    req.on("error", (e) => finish(classify(e), e.message));
    req.end(o.body);
  });
}

export function classify(e: Error & { code?: string }): TransportError {
  const code = e.code ?? "";
  if (code === "SM_BLOCKED") return "invalid_url";
  if (code === "SM_TIMEOUT" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL" || code === "EAI_NODATA") return "dns";
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") return "reset";
  if (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.startsWith("CERT_") ||
    code.includes("CERT") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "HOSTNAME_MISMATCH"
  ) {
    return "tls";
  }
  if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR" || code === "ERR__ERROR_FORMAT_PADDING_1") return "network";
  return "network";
}

export function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function round(n: number): number {
  return Math.max(0, Math.round(n));
}
