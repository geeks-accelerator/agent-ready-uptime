/** Judgements both monitors make the same way: when a failure is news, and when an expiry is announced. */
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
