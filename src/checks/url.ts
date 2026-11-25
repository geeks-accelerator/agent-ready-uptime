/**
 * URL helpers shared by the checker, sitemap module and rules.
 */

/** Resolve `href` against `base`; returns null for unparseable input. */
export function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Normalize a URL for equality checks (canonical vs. page URL, expected
 * redirect targets): lowercase host, drop `www.`, default ports, query,
 * hash and trailing slash (except the root path).
 */
export function normalizeForCompare(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim().toLowerCase();
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const port = u.port && !isDefaultPort(u.protocol, u.port) ? `:${u.port}` : "";
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return `${host}${port}${path || "/"}`;
}

function isDefaultPort(protocol: string, port: string): boolean {
  return (protocol === "https:" && port === "443") || (protocol === "http:" && port === "80");
}

export function sameUrl(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw;
  }
}

export function pathOf(raw: string): string {
  try {
    const u = new URL(raw);
    return u.pathname + u.search;
  } catch {
    return raw;
  }
}

/**
 * Registrable ("apex") domain for RDAP. Uses the last two labels, which is
 * right for every TLD we use (.com, .ai, .live, .space, .bot, .news, .org…).
 * Sites on multi-label suffixes (e.g. .co.uk) should set `domain` explicitly
 * in config.
 */
export function apexDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  // IP addresses and single-label hosts (localhost) have no registrable domain.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || !host.includes(".")) return host;
  const labels = host.split(".");
  return labels.slice(-2).join(".");
}

/** True for absolute http(s) URLs: the only URLs we fetch, link to or store. */
export function isHttpUrl(raw: string): boolean {
  if (!/^https?:/i.test(raw)) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/** Join a site's base URL with a path ("/about") or return absolute URLs as-is. */
export function siteUrl(baseUrl: string, pathOrUrl: string): string {
  if (isHttpUrl(pathOrUrl)) return pathOrUrl;
  return new URL(pathOrUrl, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

/** "example.com" → "https://example.com"; null for anything that isn't an http(s) address. */
export function normaliseUrl(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * A page's identity for joining links, sitemap rows and sections: `normalizeForCompare`
 * (host without `www.`, non-default port kept, no query or hash, no trailing slash) with
 * a trailing `index.html` dropped. Null for unparseable input. One key for the page checks,
 * the site tree and the scan.
 */
export function pageKey(url: string): string | null {
  try {
    new URL(url);
  } catch {
    return null;
  }
  const key = normalizeForCompare(url).replace(/\/index\.html?$/i, "");
  return key.includes("/") ? key : `${key}/`;
}

/** Query parameters that only track a visit: never part of a page's identity. */
const TRACKING = /^(utm_[a-z0-9_]*|gclid|gbraid|wbraid|fbclid|msclkid|dclid|yclid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|ref|ref_src)$/i;

/** The URL without tracking parameters (utm_*, gclid, fbclid, mc_*, ref…) or its hash. Unparseable input comes back as is. */
export function stripTracking(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** `pageKey` plus the query, sorted, without tracking parameters: two URLs with the same key fetch the same thing. */
export function scanKey(url: string): string | null {
  const key = pageKey(url);
  if (!key) return null;
  const q = new URL(stripTracking(url)).searchParams;
  const pairs = [...q.entries()].sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  return pairs.length ? `${key}?${new URLSearchParams(pairs).toString()}` : key;
}

/** The hosts a site's journeys, probes and scans may reach: its own host and its `www.` twin, ports ignored. */
export function journeyHosts(baseUrl: string): Set<string> {
  const host = hostOf(baseUrl).toLowerCase();
  return new Set([host, host.startsWith("www.") ? host.slice(4) : `www.${host}`]);
}

/**
 * A sign-in page, however it's spelled: /login, /wp-login.php, /users/sign_in, /signin.html,
 * /oauth/authorize, /sso. "auth" only as a whole word, so /author/… isn't one.
 */
export function isLoginPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  if (/log[-_]?in|log[-_]?on|sign[-_]?in|sign[-_]?on/.test(p)) return true;
  return p.split(/[^a-z]+/).some((w) => w === "auth" || w === "oauth" || w === "authorize" || w === "sso");
}

/** A URL's host and effective port ("example.com:443"); null for unparseable input. */
export function hostPort(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "")}`;
  } catch {
    return null;
  }
}

/**
 * The host-and-port pairs a scan may reach: the site's host and its www. twin, on the site's own
 * port only (and the other scheme's default port, so an http → https redirect on the site stays
 * allowed). A sitemap entry, redirect or docs link to another port on the same host (a database,
 * an admin service) is refused.
 */
export function siteOrigins(baseUrl: string): Set<string> {
  const u = new URL(baseUrl);
  const ports = u.port ? [u.port] : ["443", "80"];
  return new Set([...journeyHosts(baseUrl)].flatMap((h) => ports.map((p) => `${h}:${p}`)));
}

/** A path segment that's an id, not a name: a number, a long hex run or a UUID. */
export function isIdSegment(seg: string): boolean {
  return /^\d+$/.test(seg) || /[0-9a-f]{8,}/i.test(seg);
}

/** A path with its id segments replaced by `:id` ("/posts/:id/comments"): URLs of one pattern are one kind of page. */
export function pathPattern(path: string): string {
  return path
    .split("/")
    .map((s) => (s && isIdSegment(s) ? ":id" : s))
    .join("/");
}

/**
 * Hosting suffixes where every customer gets a subdomain (foo.github.io): the suffix
 * isn't anyone's domain, and two subdomains aren't the same site. A short list of the
 * common ones from the Public Suffix List's private section, not the whole list (it's
 * long and changes; DNS proof works on any domain). Add to it when a team hits one.
 */
const SHARED_HOSTS = new Set([
  "github.io", "gitlab.io", "vercel.app", "pages.dev", "netlify.app", "herokuapp.com", "onrender.com", "fly.dev",
  "web.app", "firebaseapp.com", "azurewebsites.net", "azurestaticapps.net", "cloudfront.net", "workers.dev",
  "glitch.me", "replit.app", "repl.co", "blogspot.com", "wordpress.com", "wixsite.com", "squarespace.com",
  "webflow.io", "framer.website", "surge.sh", "deno.dev", "railway.app", "up.railway.app", "appspot.com",
]);

/** Country suffixes of two labels, where `apexDomain`'s last two labels name the suffix, not a domain. */
const MULTI_LABEL = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "com.br", "co.jp", "co.za", "com.mx", "co.in", "com.sg"]);

/** The host as lower-case ASCII (punycode A-labels): how domains are stored and compared. */
export function toALabel(name: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  try {
    return new URL(`https://${n}`).hostname;
  } catch {
    return n;
  }
}

/** Is this name a shared hosting or multi-label country suffix, or a host under a shared hosting suffix? */
export function sharedHost(name: string): boolean {
  const n = toALabel(name);
  if (MULTI_LABEL.has(n)) return true;
  for (const s of SHARED_HOSTS) if (n === s || n.endsWith(`.${s}`)) return true;
  return false;
}

/** Is the name itself a suffix nobody can own (github.io, co.uk)? */
export function isPublicSuffix(name: string): boolean {
  const n = toALabel(name);
  return SHARED_HOSTS.has(n) || MULTI_LABEL.has(n);
}

/**
 * Do two hosts belong to the same site? `apexDomain` on both, except under a shared
 * hosting or two-label country suffix, where the label before the suffix counts too
 * (a.github.io and b.github.io are two sites; www.a.github.io and a.github.io one).
 */
export function sameRegistrable(a: string, b: string): boolean {
  return registrable(a) === registrable(b);
}

function registrable(host: string): string {
  const h = toALabel(host);
  const apex = apexDomain(h);
  if (!isPublicSuffix(apex) && ![...SHARED_HOSTS].some((s) => s.endsWith(`.${apex}`) && (h === s || h.endsWith(`.${s}`)))) return apex;
  const suffix = [...SHARED_HOSTS, ...MULTI_LABEL].filter((s) => h === s || h.endsWith(`.${s}`)).sort((x, y) => y.length - x.length)[0] ?? apex;
  if (h === suffix) return h;
  const label = h.slice(0, -suffix.length - 1).split(".").pop()!;
  return `${label}.${suffix}`;
}
