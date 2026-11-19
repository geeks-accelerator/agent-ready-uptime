import { checkPage, type PageCheckResult } from "../http/page-check.js";
import { fetchUrl } from "../http/request.js";
import { hostOf, isHttpUrl, resolveUrl, sameRegistrable } from "../url.js";
import { parseRobots, type Robots } from "../robots.js";
import type { RequestProfile } from "../http/request.js";
import { MAX_SITEMAP_BYTES, parseSitemap, SitemapParseError, type SitemapEntry, type SitemapFormat } from "./parse.js";

export interface SitemapFetchResult {
  url: string;
  ok: boolean;
  error: string | null;
  errorDetail: string | null;
  format: SitemapFormat | null;
  /**
   * Entries from this sitemap (and its children, for an index), deduped by
   * URL. Also set when `children_failed`: the entries from children that loaded.
   */
  entries: SitemapEntry[];
  childCount: number;
  childErrors: string[];
  /** The request for the sitemap itself (timing, status, size…). */
  check: PageCheckResult;
}

export interface SitemapFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Child sitemaps read from an index (default 200). More fail the sitemap rather than silently dropping URLs. */
  maxChildren?: number;
  /** Wrap each HTTP request (used for per-host concurrency limits). */
  limit?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Who to present as (default "monitor"), and extra headers: the scan sends its own user agent and X-Scan-Id. */
  profile?: RequestProfile;
  headers?: Record<string, string>;
  /** Where a note that isn't a failure goes (a nested sitemap index not followed); dropped by default. */
  warn?: (message: string) => void;
}

const ACCEPT = "application/xml,text/xml,application/json;q=0.9,*/*;q=0.5";

export async function fetchSitemap(url: string, opts: SitemapFetchOptions = {}): Promise<SitemapFetchResult> {
  const limit = opts.limit ?? (<T>(fn: () => Promise<T>) => fn());
  const reqOpts = {
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxBytes: opts.maxBytes ?? MAX_SITEMAP_BYTES,
    seoChecks: false,
    accept: ACCEPT,
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  };
  const check = await limit(() => checkPage(url, reqOpts));
  const result: SitemapFetchResult = {
    url,
    ok: false,
    error: null,
    errorDetail: null,
    format: null,
    entries: [],
    childCount: 0,
    childErrors: [],
    check,
  };

  if (!check.ok) {
    result.error = check.error;
    result.errorDetail = check.errorDetail;
    return result;
  }
  if (check.truncated) {
    result.error = "too_large";
    result.errorDetail = `sitemap larger than ${reqOpts.maxBytes} bytes`;
    return result;
  }

  try {
    const parsed = parseSitemap(check.raw.body, { url: check.finalUrl, contentType: check.contentType, maxBytes: reqOpts.maxBytes });
    result.format = parsed.format;
    if (parsed.kind === "index") {
      // The sitemap protocol keeps children on the sitemap's own host; another domain is
      // refused (it isn't this site's list, and it would point the monitor anywhere).
      const listed = httpUrls(parsed.children, check.finalUrl);
      const host = hostOf(check.finalUrl);
      const offSite = listed.filter((u) => !sameRegistrable(hostOf(u), host));
      const onSite = listed.filter((u) => sameRegistrable(hostOf(u), host));
      const cap = opts.maxChildren ?? 200;
      const children = onSite.slice(0, cap);
      result.childCount = listed.length;
      for (const u of offSite) result.childErrors.push(`${u}: not on ${host}, so not read`);
      // Reading only some children would make the rest's URLs look removed.
      if (onSite.length > cap) result.childErrors.push(`${onSite.length - cap} more child sitemaps not read (limit ${cap})`);
      const seen = new Map<string, SitemapEntry>();
      for (const abs of children) {
        const child = await limit(() => checkPage(abs, reqOpts));
        if (!child.ok) {
          result.childErrors.push(`${abs}: ${child.errorDetail ?? child.error}`);
          continue;
        }
        try {
          const p = parseSitemap(child.raw.body, { url: child.finalUrl, contentType: child.contentType, maxBytes: reqOpts.maxBytes });
          if (p.kind === "index") {
            // Not allowed by the sitemap protocol; skipped rather than failed.
            opts.warn?.(`sitemap ${url}: nested sitemap index ${abs} not followed`);
            continue;
          }
          addEntries(seen, p.entries, child.finalUrl);
        } catch (e) {
          result.childErrors.push(`${abs}: ${(e as Error).message}`);
        }
      }
      result.entries = [...seen.values()];
      // Any failed child fails the whole sitemap: a partial list would look
      // like removed URLs. The entries that did load are kept for the caller.
      if (result.childErrors.length > 0) {
        result.error = "children_failed";
        result.errorDetail = `${result.childErrors.length} of ${listed.length} child sitemaps failed: ${result.childErrors.slice(0, 3).join("; ")}`;
        return result;
      }
    } else {
      const seen = new Map<string, SitemapEntry>();
      addEntries(seen, parsed.entries, check.finalUrl);
      result.entries = [...seen.values()];
    }
    result.ok = true;
  } catch (e) {
    result.error = e instanceof SitemapParseError ? e.code : "parse_error";
    result.errorDetail = (e as Error).message;
  }
  return result;
}

/** Resolve URLs against `base`, keeping only http(s) ones (drops javascript:, data:, mailto:…). */
function httpUrls(urls: string[], base: string): string[] {
  return urls.map((u) => resolveUrl(u, base)).filter((u): u is string => u !== null && isHttpUrl(u));
}

/** Add entries with resolved http(s) URLs to `seen`, first occurrence wins. */
function addEntries(seen: Map<string, SitemapEntry>, entries: SitemapEntry[], base: string): void {
  for (const e of entries) {
    const url = resolveUrl(e.url, base);
    if (url && isHttpUrl(url) && !seen.has(url)) seen.set(url, url === e.url ? e : { ...e, url });
  }
}

/**
 * Find a site's sitemaps: `Sitemap:` lines in robots.txt, else /sitemap.xml
 * if it exists. Also probes /sitemap.json (only kept when it is real JSON
 * with entries; some apps answer 200 with an HTML fallback page).
 */
export async function discoverSitemaps(
  baseUrl: string,
  opts: { probeJson?: boolean; timeoutMs?: number } & Pick<SitemapFetchOptions, "limit" | "profile" | "headers"> = {},
): Promise<{ urls: string[]; notes: string[]; robots: Robots | null }> {
  const notes: string[] = [];
  const urls: string[] = [];
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const limit = opts.limit ?? (<T>(fn: () => Promise<T>) => fn());
  const pass = { timeoutMs, ...(opts.limit ? { limit: opts.limit } : {}), ...(opts.profile ? { profile: opts.profile } : {}), ...(opts.headers ? { headers: opts.headers } : {}) };
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();
  const robots = await limit(() => fetchUrl(robotsUrl, { timeoutMs, maxBytes: 512 * 1024, accept: "text/plain,*/*", ...(opts.profile ? { profile: opts.profile } : {}), ...(opts.headers ? { headers: opts.headers } : {}) }));
  // The robots.txt read here is handed back, so a caller that also obeys it doesn't fetch it twice.
  let parsedRobots: Robots | null = null;
  if (!robots.error && robots.statusCode === 200) {
    parsedRobots = parseRobots(robots.body.toString("utf8"));
    for (const line of parsedRobots.sitemaps) {
      const abs = resolveUrl(line.split(/\s/)[0]!, robotsUrl);
      if (abs && !urls.includes(abs)) urls.push(abs);
    }
  } else {
    notes.push(`robots.txt: ${robots.error ?? `HTTP ${robots.statusCode}`}`);
  }

  if (urls.length === 0) {
    const guess = new URL("/sitemap.xml", baseUrl).toString();
    const probe = await fetchSitemap(guess, pass);
    // It exists if it parsed, even when some of an index's children failed.
    if (probe.format !== null) urls.push(guess);
    else notes.push(`no sitemap in robots.txt and ${guess} failed (${probe.error})`);
  }

  if (opts.probeJson !== false) {
    const jsonUrl = new URL("/sitemap.json", baseUrl).toString();
    if (!urls.includes(jsonUrl)) {
      const probe = await fetchSitemap(jsonUrl, pass);
      if (probe.ok && probe.format === "json" && probe.entries.length > 0) urls.push(jsonUrl);
      else if (probe.check.statusCode === 200) notes.push(`${jsonUrl}: ${probe.error ?? "no entries"} (ignored)`);
    }
  }
  return { urls, notes, robots: parsedRobots };
}
