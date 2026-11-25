/** Judgements both monitors make the same way: when a failure or a change is news, and when an expiry is announced. */
import { lasted } from "./format.js";
import type { Hop } from "./http/request.js";
import { isLoginPath, journeyHosts } from "./url.js";
/**
 * What the second location said about a failed check: it failed too ("both"),
 * it got an ok answer ("here_only": likely our network or our route), or it
 * couldn't be asked ("unavailable": not configured, unreachable or busy).
 */
export type ConfirmVerdict = "both" | "here_only" | "unavailable";

/** Failures in a row the second location also saw (US East), before the page alerts: about 1 minute. */
export const CONFIRM_ROUNDS = 2;

/** The failures in a row so far, and what the second location said about them. */
export interface FailureStreak {
  failures: number;
  /** The latest rounds in a row that were "both". */
  bothInARow: number;
  /** Whether any round in the streak was "here_only". */
  hereOnly: boolean;
}

export const NO_STREAK: FailureStreak = { failures: 0, bothInARow: 0, hereOnly: false };

/** The streak after one more failed check. */
export function addFailure(s: FailureStreak, c: ConfirmVerdict): FailureStreak {
  return { failures: s.failures + 1, bothInARow: c === "both" ? s.bothInARow + 1 : 0, hereOnly: s.hereOnly || c === "here_only" };
}

/**
 * Whether a failing page is down. Seen from both locations twice in a row: yes,
 * about a minute in. Otherwise today's rule, confirmFailures in a row, but only
 * while the second location never saw the page working: a failure seen from
 * here only is our network, however long it lasts.
 */
export function isDown(s: FailureStreak, rules: { confirmFailures: number }): boolean {
  if (s.bothInARow >= CONFIRM_ROUNDS) return true;
  return !s.hereOnly && s.failures >= rules.confirmFailures;
}

/** Days until an ISO date (negative when past). */
export function daysUntil(iso: string, now = Date.now()): number {
  return (Date.parse(iso) - now) / 86_400_000;
}

/** Tightest threshold bucket a value falls into, e.g. buckets [30,14,7,1] and 10 → 14. */
export function bucketFor(days: number, buckets: number[]): number | null {
  const sorted = [...buckets].sort((a, b) => a - b);
  for (const b of sorted) if (days <= b) return b;
  return null;
}

/** Failures in a row before a warning (an agent file, a sitemap, a DNS answer) is news. */
export const WARN_CONFIRM = 2;

/**
 * A failed page is checked again 1 minute later, then 5 minutes after that, and
 * alerts on the third failure in a row (about 6 minutes): one bad answer or a
 * short blip is logged but isn't news. Every check is still recorded.
 */
export const PAGE_RETRIES = [60, 300];

/** Days before a certificate expires when it's announced (each threshold once). */
export const SSL_BUCKETS = [14, 3];

/** Days before a domain expires when it's announced (each threshold once). */
export const DOMAIN_BUCKETS = [30, 14, 7, 1];

/**
 * Whether two content fingerprints were made the same way: the same recipe prefix, the text before the
 * first colon ("c1:" for MCP tools and DNS records, "robots2:" for robots.txt). A recipe change reads
 * as a new scheme, never as an edit, so neither monitor reports a change nobody made.
 */
export function sameRecipe(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const pa = a.indexOf(":");
  const pb = b.indexOf(":");
  return pa > 0 && pa === pb && a.slice(0, pa) === b.slice(0, pb);
}

/**
 * Reads of the same new fingerprint before a change is news: the read that saw it and its two
 * retries (`PAGE_RETRIES`, about 6 minutes). A partial MCP tool list or a resolver answering
 * from another pool reads as a change and then a change back; held this way, it's never sent.
 */
export const CHANGE_CONFIRM = PAGE_RETRIES.length + 1;

/** A fingerprint that differs from the stored one, not yet read often enough to be news. */
export interface PendingChange {
  fingerprint: string;
  /** Reads in a row that gave this fingerprint. */
  reads: number;
  /** When the first of them was read (ISO). */
  firstAt: string;
}

export type ChangeVerdict =
  /** No change: the stored fingerprint again (a pending one, if any, was a blip), or the first one ever, or a new recipe (never an edit). */
  | { state: "same"; blip: boolean }
  /** A new fingerprint, held: read again after `retryInS`. */
  | { state: "pending"; pending: PendingChange; retryInS: number }
  /** Read the same `reads` times in a row since `firstAt`: announce it. */
  | { state: "changed"; reads: number; firstAt: string };

/**
 * Whether a fingerprint read now is a change: held until the same new value is read
 * `CHANGE_CONFIRM` times in a row, retried on the `PAGE_RETRIES` schedule. Fingerprints made
 * by another recipe never compare (`sameRecipe`).
 */
export function confirmChange(stored: string | null | undefined, pending: PendingChange | null | undefined, now: string, at: string): ChangeVerdict {
  if (!stored || now === stored || !sameRecipe(stored, now)) return { state: "same", blip: !!pending && now === stored };
  const reads = pending?.fingerprint === now ? pending.reads + 1 : 1;
  const firstAt = pending?.fingerprint === now ? pending.firstAt : at;
  if (reads >= CHANGE_CONFIRM) return { state: "changed", reads, firstAt };
  return { state: "pending", pending: { fingerprint: now, reads, firstAt }, retryInS: PAGE_RETRIES[reads - 1] ?? PAGE_RETRIES.at(-1)! };
}

/**
 * How a failure or a change was confirmed, in one line for an alert: "3 times over 6 minutes,
 * from US West and US East", or "2 days running". `from`: the places it was seen, when there
 * was more than one.
 */
export function confirmWords(c: { times: number; overMs: number; from?: string[] } | { days: number }): string {
  if ("days" in c) return `${c.days} days running`;
  const over = c.times > 1 && c.overMs >= 60_000 ? ` over ${lasted(c.overMs)}` : "";
  const from = c.from && c.from.length > 1 ? `, from ${c.from.slice(0, -1).join(", ")} and ${c.from.at(-1)}` : c.from?.length === 1 ? `, from ${c.from[0]}` : "";
  return `${c.times} time${c.times === 1 ? "" : "s"}${over}${from}`;
}

/**
 * What's wrong with a page's redirect chain, if anything, as one closed value (both monitors judge
 * it here; `chainWords` says it). In order:
 * - `hop_failed`: a redirect led to a step that answered neither 2xx nor 3xx (or didn't answer);
 * - `through_noindex`: a step before the page said noindex in its headers;
 * - `temporary`: a 302, 303 or 307 to another path on the same site, where a moved page wants 301 or 308
 *   (never from the site's root, which may send each visitor to their language or region, and never to an
 *   address with a query, a view such as /?sort=hot rather than a page that moved);
 * - `chain`: more than one redirect.
 * The HTTPS and `www.` hop to the same path is free (never counted, never temporary), and a redirect
 * to a sign-in page is a page behind a login, not a fault. `step` counts from 1, the address asked for.
 */
export type ChainVerdict =
  | { kind: "hop_failed"; step: number; status: number | null }
  | { kind: "through_noindex"; step: number }
  | { kind: "temporary"; step: number; status: number }
  | { kind: "chain"; redirects: number };

/** Checks in a row with the same kind of chain fault before it's news (about 15 minutes for a page checked every 5). */
export const CHAIN_CONFIRM = 3;

const TEMPORARY = new Set([302, 303, 307]);

export function judgeChain(hops: Hop[]): ChainVerdict | null {
  if (hops.length < 2) return null;
  const last = hops[hops.length - 1]!;
  const ok = (s: number | null) => s !== null && s >= 200 && s < 400;
  if (!ok(last.statusCode)) return { kind: "hop_failed", step: hops.length, status: last.statusCode };
  const parse = (u: string) => {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  };
  const site = journeyHosts(hops[0]!.url);
  let counted = 0;
  let firstTemporary: ChainVerdict | null = null;
  for (let i = 0; i < hops.length - 1; i++) {
    const from = parse(hops[i]!.url);
    const to = parse(hops[i + 1]!.url);
    if (!from || !to) continue;
    if (isLoginPath(to.pathname)) return null;
    const free = from.pathname === to.pathname && from.search === to.search && journeyHosts(from.href).has(to.hostname.toLowerCase());
    if (free) continue;
    counted++;
    if (hops[i]!.noindex && i > 0) return { kind: "through_noindex", step: i + 1 };
    // The site's root sending each visitor to their language or region (/ → /en) is temporary on purpose: it depends on who asks.
    // A shortcut to a view (/trending → /?sort=hot) is temporary on purpose too: a query names a view, not where a page moved.
    if (!firstTemporary && from.pathname !== "/" && !to.search && TEMPORARY.has(hops[i]!.statusCode ?? 0) && site.has(to.hostname.toLowerCase())) firstTemporary = { kind: "temporary", step: i + 1, status: hops[i]!.statusCode! };
  }
  return firstTemporary ?? (counted > 1 ? { kind: "chain", redirects: counted } : null);
}
