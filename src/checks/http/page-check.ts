import { fetchUrl, headerValue, hopOf, type FetchResult, type Hop, type RequestProfile, type Timings, type TlsInfo } from "./request.js";
import { headerNoindex, pageMeta, parseHead, type PageMeta } from "../html/head.js";
import { resolveUrl, sameUrl } from "../url.js";
import { createHash } from "node:crypto";
import { validateAgentFile, type AgentFileKind, type AgentFileReason } from "../agent/validate.js";
import { fetchOnHost } from "./same-host.js";
import { ROBOTS_FINGERPRINT, robotsState, robotsSummary } from "../robots.js";

export interface PageCheckOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Acceptable final status codes (default: any 2xx). */
  expectedStatus?: number[];
  /** Page must contain this text. */
  keyword?: string;
  /** Page must NOT contain this text. */
  keywordAbsent?: string;
  /** Final URL after redirects must equal this (normalized). */
  expectedFinalUrl?: string;
  /** Parse <head> for title / noindex / canonical (default true; HTML only). */
  seoChecks?: boolean;
  accept?: string;
  /** Request headers to present as (default "monitor"). */
  profile?: RequestProfile;
  /** Extra request headers over the profile's (the scan's X-Scan-Id). */
  headers?: Record<string, string>;
  /** An agent discovery file: validate its format (a 200 HTML fallback fails). */
  expect?: AgentFileKind;
  /** robots.txt: the site's paths to judge it on (the homepage and nav pages). */
  robotsPaths?: string[];
  /** Follow redirects only on the URL's own host (`fetchOnHost`); one off the host fails as `redirect_off_host`, unfetched. */
  sameHost?: boolean;
}

export interface PageCheckResult {
  checkedAt: string;
  url: string;
  finalUrl: string;
  ok: boolean;
  statusCode: number | null;
  redirectCount: number;
  /**
   * The whole path when there was a redirect: each redirect, then the last response (empty
   * without one). A redirect that wasn't followed (off the host, one too many) ends it.
   */
  hops: Hop[];
  /** Machine-readable reason, null when ok. */
  error: string | null;
  /** Human-readable detail for alerts. */
  errorDetail: string | null;
  timings: Timings;
  bytes: number;
  truncated: boolean;
  contentType: string | null;
  isHtml: boolean;
  cfCacheStatus: string | null;
  cfRay: string | null;
  viaCloudflare: boolean;
  /** Present only when SEO checks ran on an HTML page. */
  title: string | null;
  hasTitle: boolean | null;
  noindex: boolean | null;
  canonical: string | null;
  canonicalOk: boolean | null;
  /** The description, share-card tags, structured data and headings; present only when SEO checks ran on an HTML page. */
  meta: PageMeta | null;
  tls: TlsInfo | null;
  /** Raw response, for callers that need the body (sitemaps). Not stored. */
  raw: FetchResult;
  /** What the content is, for things that change meaningfully (an MCP server's tools). */
  fingerprint?: string;
  fingerprintData?: unknown;
  /** security.txt: its Expires date. */
  expiresAt?: string;
  /** An agent file that failed its format: why, as a closed code (`AgentFileVerdict.reason`). */
  reason?: AgentFileReason;
}

/**
 * One check of one URL: request with timing breakdown, then classify the
 * result and extract the measurements we store.
 */
export async function checkPage(url: string, opts: PageCheckOptions = {}): Promise<PageCheckResult> {
  const checkedAt = new Date().toISOString();
  const fetchOpts = {
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxBytes: opts.maxBytes ?? 5 * 1024 * 1024,
    ...(opts.accept ? { accept: opts.accept } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  };
  if (!opts.sameHost) return evaluate(await fetchUrl(url, fetchOpts), checkedAt, opts);
  const { res, offHost, badLocation } = await fetchOnHost(url, (u) => fetchUrl(u, { ...fetchOpts, maxRedirects: 0 }));
  const r = evaluate(res, checkedAt, opts);
  if (offHost || badLocation) return { ...r, ok: false, error: "redirect_off_host", errorDetail: describeError("redirect_off_host", r.statusCode) };
  return r;
}

/** The redirects and the last response as one path; a redirect that wasn't followed is already the last step. */
export function hopsOf(res: FetchResult): Hop[] {
  if (!res.redirects.length) return [];
  // fetchUrl stops at a redirect off the host without fetching where it pointed (finalUrl), and at a bad Location on the step it recorded.
  const unfollowed = res.error === "redirect_off_host" || res.finalUrl === res.redirects.at(-1)!.url;
  return unfollowed ? [...res.redirects] : [...res.redirects, hopOf(res.finalUrl, res.statusCode, res.headers)];
}

export function evaluate(res: FetchResult, checkedAt: string, opts: PageCheckOptions = {}): PageCheckResult {
  const contentType = headerValue(res.headers["content-type"])?.split(";")[0]?.trim().toLowerCase() ?? null;
  const server = headerValue(res.headers.server)?.toLowerCase() ?? "";
  const cfRay = headerValue(res.headers["cf-ray"]) ?? null;
  const viaCloudflare = server.includes("cloudflare") || cfRay !== null;
  const cfCacheStatus = headerValue(res.headers["cf-cache-status"])?.toUpperCase() ?? null;
  const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";

  let title: string | null = null;
  let hasTitle: boolean | null = null;
  let noindex: boolean | null = null;
  let canonical: string | null = null;
  let canonicalOk: boolean | null = null;
  let meta: PageMeta | null = null;

  const bodyText = res.body.length > 0 && (isHtml || opts.keyword || opts.keywordAbsent || opts.expect) ? res.body.toString("utf8") : "";

  if (isHtml && opts.seoChecks !== false && res.error === null && res.statusCode !== null && res.statusCode < 400) {
    const head = parseHead(bodyText);
    meta = pageMeta(bodyText, head);
    title = head.title;
    hasTitle = head.title !== null;
    noindex = head.metaNoindex || headerNoindex(res.headers["x-robots-tag"]);
    if (head.canonical) {
      const resolved = resolveUrl(head.canonical, res.finalUrl);
      canonical = resolved ?? head.canonical;
      canonicalOk = resolved !== null && sameUrl(resolved, res.finalUrl);
    } else {
      canonicalOk = false;
    }
  }

  let error: string | null = null;
  let errorDetail: string | null = null;
  let expiresAt: string | undefined;
  let reason: AgentFileReason | undefined;
  let fingerprint: string | undefined;
  let fingerprintData: unknown;
  const status = res.statusCode;

  if (res.error) {
    error = res.error;
    errorDetail = res.errorMessage;
  } else if (status !== null && status >= 520 && status <= 530 && viaCloudflare) {
    error = "cloudflare_origin_unreachable";
    errorDetail = describeError(error, status);
  } else if (status !== null && headerValue(res.headers["cf-mitigated"]) === "challenge") {
    error = "cloudflare_challenge";
    errorDetail = describeError(error, status);
  } else if (status === null || !statusExpected(status, opts.expectedStatus)) {
    error = `http_${status ?? 0}`;
    errorDetail = describeError(error, status);
  } else if (opts.keyword && !bodyText.includes(opts.keyword)) {
    error = "keyword_missing";
    errorDetail = `"${opts.keyword}" not found on page`;
  } else if (opts.keywordAbsent && bodyText.includes(opts.keywordAbsent)) {
    error = "keyword_present";
    errorDetail = `"${opts.keywordAbsent}" found on page`;
  } else if (opts.expectedFinalUrl && !sameUrl(res.finalUrl, opts.expectedFinalUrl)) {
    error = "unexpected_redirect";
    errorDetail = `ended at ${res.finalUrl}, expected ${opts.expectedFinalUrl}`;
  } else if (opts.expect) {
    // Agent files: the format is the point. Its one-line summary goes where a page's title would.
    const v = validateAgentFile(opts.expect, bodyText, contentType, res.finalUrl);
    error = v.error;
    errorDetail = v.detail;
    title = v.summary;
    hasTitle = v.summary !== null;
    if (v.expiresAt) expiresAt = v.expiresAt;
    if (v.reason) reason = v.reason;
    if (v.error === null && opts.expect === "robots_txt") {
      // What it allows the crawlers that bring readers, on the site's own pages.
      const state = robotsState(bodyText, opts.robotsPaths ?? ["/"]);
      title = robotsSummary(state);
      fingerprint = `${ROBOTS_FINGERPRINT}${createHash("sha256").update(state.rules.join("\n")).digest("hex").slice(0, 16)}`;
      fingerprintData = state;
    }
  }

  return {
    checkedAt,
    url: res.url,
    finalUrl: res.finalUrl,
    ok: error === null,
    statusCode: status,
    redirectCount: res.redirects.length,
    hops: hopsOf(res),
    error,
    errorDetail,
    timings: res.timings,
    bytes: res.bytes,
    truncated: res.truncated,
    contentType,
    isHtml,
    cfCacheStatus,
    cfRay,
    viaCloudflare,
    title,
    hasTitle,
    noindex,
    canonical,
    canonicalOk,
    meta,
    tls: res.tls,
    raw: res,
    ...(fingerprint !== undefined ? { fingerprint, fingerprintData } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(reason ? { reason } : {}),
  };
}

function statusExpected(status: number, expected?: number[]): boolean {
  if (expected && expected.length > 0) return expected.includes(status);
  return status >= 200 && status < 300;
}

const TRANSPORT_TEXT: Record<string, string> = {
  dns: "DNS lookup failed",
  timeout: "Timed out waiting for the server",
  refused: "Connection refused",
  reset: "Connection reset by the server",
  tls: "TLS handshake failed",
  network: "Network error",
  too_many_redirects: "Too many redirects",
  redirect_off_host: "Redirects off the site",
  invalid_url: "Invalid URL",
  keyword_missing: "Expected text not found on the page",
  keyword_present: "Unwanted text found on the page",
  unexpected_redirect: "Ended at an unexpected URL",
  unexpected_reply: "The reply didn't contain the expected text",
  dns_disagree: "The nameservers disagree",
  dns_unexpected: "An expected record is missing",
  heartbeat_late: "Didn't check in on time",
  heartbeat_failed: "Reported a failure",
};

/**
 * One plain sentence for an error code (and the HTTP status, when there was one).
 * `evaluate()` uses it at check time; the dashboard uses it for stored checks,
 * which keep only the code, so both say the same thing.
 */
/**
 * The result of a check that isn't an HTTP page fetch (a journey run, a port, a DNS
 * lookup, a heartbeat), shaped like any page check so the engine buffers and judges it
 * the same way: no body, no SEO, its own verdict and words.
 */
export function syntheticResult(
  url: string,
  checkedAt: string,
  o: { ok: boolean; statusCode?: number | null; error?: string | null; errorDetail?: string | null; timings?: Partial<Timings>; title?: string | null; tls?: TlsInfo | null; fingerprint?: string; fingerprintData?: unknown },
): PageCheckResult {
  const timings: Timings = { dnsMs: 0, connectMs: 0, tlsMs: 0, ttfbMs: 0, downloadMs: 0, redirectMs: 0, totalMs: 0, ...o.timings };
  const res: FetchResult = { url, finalUrl: url, statusCode: o.statusCode ?? null, headers: {}, body: Buffer.alloc(0), bytes: 0, wireBytes: 0, truncated: false, redirects: [], timings, tls: o.tls ?? null, error: null, errorMessage: null };
  return {
    ...evaluate(res, checkedAt, { seoChecks: false }),
    ok: o.ok,
    statusCode: o.statusCode ?? null,
    error: o.ok ? null : (o.error ?? "failed"),
    errorDetail: o.ok ? null : (o.errorDetail ?? null),
    timings,
    title: o.title ?? null,
    hasTitle: o.title ? true : null,
    noindex: null,
    canonical: null,
    canonicalOk: null,
    isHtml: false,
    tls: o.tls ?? null,
    ...(o.fingerprint !== undefined ? { fingerprint: o.fingerprint, fingerprintData: o.fingerprintData } : {}),
  };
}

export function describeError(code: string, status: number | null): string {
  if (code === "cloudflare_origin_unreachable") return `Cloudflare ${status}: origin unreachable`;
  if (code === "cloudflare_challenge") return `Cloudflare bot challenge (${status}); allow the monitor's User-Agent in WAF`;
  if (code.startsWith("http_")) return `HTTP ${status ?? "no status"}`;
  return TRANSPORT_TEXT[code] ?? code.replace(/_/g, " ");
}
