/**
 * Follow a site's redirects by hand, only on its own host (and its `www.`/apex twin,
 * `journeyHosts`), never another's: the not-found probe and the try-it scan both fetch
 * this way. Each hop is one `get` with redirects off, so the caller decides how a hop is
 * made (a per-host limiter, a fake in tests) and `fetchUrl`'s private-address refusal
 * applies to every hop.
 */
import { journeyHosts } from "../url.js";
import { headerValue, hopOf, type FetchResult } from "./request.js";

export interface OnHostResult {
  /** The last response, with `url` the address asked for, `finalUrl` the last one fetched, and every hop in `redirects`. */
  res: FetchResult;
  /** Where a redirect pointed off the host (not fetched), or null. */
  offHost: string | null;
  /** A redirect whose Location isn't a URL. */
  badLocation: boolean;
}

const isRedirect = (r: FetchResult) => r.statusCode !== null && r.statusCode >= 300 && r.statusCode < 400;

export async function fetchOnHost(url: string, get: (u: string) => Promise<FetchResult>, maxHops = 5): Promise<OnHostResult> {
  const hosts = journeyHosts(url);
  const redirects: FetchResult["redirects"] = [];
  let current = url;
  let res = await get(current);
  const done = (offHost: string | null, badLocation = false): OnHostResult => ({ res: { ...res, url, finalUrl: current, redirects }, offHost, badLocation });
  for (let hop = 0; hop < maxHops && isRedirect(res); hop++) {
    const location = headerValue(res.headers.location);
    if (!location) break;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return done(null, true);
    }
    if (!hosts.has(next.hostname.toLowerCase()) || next.username || next.password) return done(next.href);
    redirects.push(hopOf(current, res.statusCode, res.headers));
    current = next.href;
    res = await get(current);
  }
  return done(null);
}
