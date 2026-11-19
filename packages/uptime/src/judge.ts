import { FINGERPRINT_VERSION } from "@geeks-accelerator/agent-ready-checks/mcp/check";
import { describeToolChange } from "@geeks-accelerator/agent-ready-checks/mcp/diff";
import { describeRecordChange } from "@geeks-accelerator/agent-ready-checks/net/dns";
import { addFailure, bucketFor, daysUntil, DOMAIN_BUCKETS, isDown, NO_STREAK, SSL_BUCKETS } from "@geeks-accelerator/agent-ready-checks/rules";
import type { TargetState } from "./state.js";
import type { Target } from "./targets.js";

/** One check's answer, as the judge needs it (from a check result, a sitemap fetch or an RDAP lookup). */
export interface Outcome {
  ok: boolean;
  checkedAt: string;
  error: string | null;
  detail: string | null;
  ttfbMs: number | null;
  fingerprint?: string | undefined;
  fingerprintData?: unknown;
  /** A certificate's or a domain's expiry. */
  expiresAt?: string | null | undefined;
  count?: number | undefined;
}

export type AlertKind = "down" | "up" | "failing" | "recovered" | "changed" | "expiring";

export interface Alert {
  kind: AlertKind;
  site: string;
  target: string;
  /** What happened, in a sentence. */
  title: string;
  /** Why, when there's more to say. */
  detail: string | null;
  url: string;
  at: string;
}

/**
 * The target's next state, and what's news: a failure once it's confirmed (the
 * homepage and ports: down after three in a row, retried after 1 and 5 minutes;
 * the rest: failing after two), the recovery of something that alerted, an MCP
 * server's tools or a DNS record set changing, and a certificate or domain
 * crossing an expiry threshold (each once).
 */
export function judge(t: Target, before: TargetState, o: Outcome, siteName: string): { state: TargetState; alerts: Alert[] } {
  const alerts: Alert[] = [];
  const alert = (kind: AlertKind, title: string, detail: string | null = null) => alerts.push({ kind, site: t.site, target: t.label, title, detail, url: t.url, at: o.checkedAt });
  const outage = t.kind === "homepage" || t.kind === "port";
  const s: TargetState = { ...before, checkedAt: o.checkedAt, error: o.error, detail: o.detail, ttfbMs: o.ttfbMs };
  if (before.ok !== o.ok) s.since = o.checkedAt;
  s.ok = o.ok;
  if (o.count !== undefined) s.count = o.count;

  if (!o.ok) {
    s.streak = addFailure(before.streak, "unavailable");
    if (!before.alerted && isDown(s.streak, t)) {
      s.alerted = true;
      alert(outage ? "down" : "failing", outage ? `${siteName}: ${t.label} is down` : `${siteName}: ${t.label} is failing`, o.detail ?? o.error);
    }
    return { state: s, alerts };
  }

  s.streak = NO_STREAK;
  if (before.alerted) {
    s.alerted = false;
    alert(outage ? "up" : "recovered", outage ? `${siteName}: ${t.label} is back up` : `${siteName}: ${t.label} is passing again`, before.since ? `${outage ? "Down" : "Failing"} for ${lasted(Date.parse(o.checkedAt) - Date.parse(before.since))}, since ${before.since.slice(11, 16)} UTC.` : null);
  }

  // What it lists changed: an MCP server's tools, or a DNS record set (announced by type).
  if (o.fingerprint) {
    const sameRecipe = before.fingerprint?.startsWith(FINGERPRINT_VERSION) && o.fingerprint.startsWith(FINGERPRINT_VERSION);
    if (before.fingerprint && sameRecipe && before.fingerprint !== o.fingerprint) {
      if (t.spec?.kind === "mcp") alert("changed", `${siteName}: the MCP server's tools changed`, describeToolChange(before.fingerprintData, o.fingerprintData) || null);
      else if (t.kind === "dns" && t.announceChanges) alert("changed", `${siteName}: ${t.label} changed`, describeRecordChange(before.fingerprintData, o.fingerprintData) || null);
    }
    if (before.fingerprint && before.fingerprint !== o.fingerprint && sameRecipe) s.changedAt = o.checkedAt;
    s.fingerprint = o.fingerprint;
    s.fingerprintData = o.fingerprintData;
  }

  // A certificate (the homepage's) or the domain's registration running out: each threshold once, again after a renewal.
  if (o.expiresAt !== undefined) {
    s.expiresAt = o.expiresAt;
    const buckets = t.kind === "domain" ? DOMAIN_BUCKETS : SSL_BUCKETS;
    const bucket = o.expiresAt ? bucketFor(daysUntil(o.expiresAt, Date.parse(o.checkedAt)), buckets) : null;
    if (bucket === null) s.announcedBucket = null;
    else if (before.announcedBucket === null || before.announcedBucket === undefined || bucket < before.announcedBucket) {
      s.announcedBucket = bucket;
      const days = Math.max(0, Math.floor(daysUntil(o.expiresAt!, Date.parse(o.checkedAt))));
      const what = t.kind === "domain" ? `${t.label} expires` : `${siteName}'s TLS certificate expires`;
      alert("expiring", `${t.kind === "domain" ? `${siteName}: ` : ""}${what} in ${days} day${days === 1 ? "" : "s"}`, `On ${o.expiresAt!.slice(0, 10)}.`);
    }
  }
  return { state: s, alerts };
}

/** "7 minutes", "2 hours 5 minutes", "3 days 4 hours": how long something lasted. */
export function lasted(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (m < 60) return unit(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${unit(h, "hour")} ${unit(m % 60, "minute")}` : unit(h, "hour");
  const d = Math.floor(h / 24);
  return h % 24 ? `${unit(d, "day")} ${unit(h % 24, "hour")}` : unit(d, "day");
}
