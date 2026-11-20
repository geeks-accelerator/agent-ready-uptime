import { FINGERPRINT_VERSION } from "./checks/mcp/check.js";
import { describeToolChange } from "./checks/mcp/diff.js";
import { describeRecordChange } from "./checks/net/dns.js";
import { addFailure, bucketFor, daysUntil, DOMAIN_BUCKETS, isDown, NO_STREAK, SSL_BUCKETS } from "./checks/rules.js";
import { judgeRegistration, type RegistrationState } from "./checks/domain/registration.js";
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
  /** A domain's registration as RDAP read it (statuses and nameservers too). */
  registration?: RegistrationState | undefined;
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
  /** A moment the alert refers to, written by each destination in its reader's own timezone (`alertDetail`). */
  when?: { at: string; word: "Since" | "On"; show: "time" | "date" };
  url: string;
  at: string;
}

export type TimeFormat = "utc" | "discord" | "slack";

/**
 * The detail with its moment written for where it's going: Discord's `<t:…>` and Slack's
 * `<!date^…>` render in each reader's timezone (Slack falls back to the UTC text); logs say UTC.
 */
export function alertDetail(a: Alert, format: TimeFormat): string | null {
  if (!a.when) return a.detail;
  const ms = Date.parse(a.when.at);
  const unix = Math.floor(ms / 1000);
  const utc = a.when.show === "time" ? `${a.when.at.slice(11, 16)} UTC` : a.when.at.slice(0, 10);
  const written =
    format === "discord" ? `<t:${unix}:${a.when.show === "time" ? "t" : "D"}>` : format === "slack" ? `<!date^${unix}^${a.when.show === "time" ? "{time}" : "{date_short}"}|${utc}>` : utc;
  return [a.detail, `${a.when.word} ${written}.`].filter(Boolean).join(" ");
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
  const alert = (kind: AlertKind, title: string, detail: string | null = null, when?: Alert["when"]) => alerts.push({ kind, site: t.site, target: t.label, title, detail, ...(when ? { when } : {}), url: t.url, at: o.checkedAt });
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
    alert(outage ? "up" : "recovered", outage ? `${siteName}: ${t.label} is back up` : `${siteName}: ${t.label} is passing again`, before.since ? `${outage ? "Down" : "Failing"} for ${lasted(Date.parse(o.checkedAt) - Date.parse(before.since))}.` : null, before.since ? { at: before.since, word: "Since", show: "time" } : undefined);
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

  // A domain's registration: what changed since the last reading (judgeRegistration, shared with the
  // hosted monitor). New trouble alerts once; a date moved by the registry's own renewal is never a renewal.
  if (o.registration) {
    const j = judgeRegistration(before.registration ?? null, o.registration, Date.parse(o.checkedAt));
    const was = before.registration ? judgeRegistration(null, before.registration, Date.parse(o.checkedAt)) : null;
    if (j.unpaid && !was?.unpaid) alert("failing", `${siteName}: ${t.label} expired and may not have been paid for`, "The registry renewed it automatically, but the registrar may not have been paid: the site can be parked at any time. Renew it at the registrar.");
    const newBad = j.bad.filter((f) => !was?.bad.includes(f));
    if (newBad.length) alert("failing", `${siteName}: ${t.label} has a registry status problem`, `Registry status: ${newBad.join(", ")}.`);
    if (j.locks.removed.length) alert("changed", `${siteName}: ${t.label}'s registrar lock was removed`, `Removed: ${j.locks.removed.join(", ")}. The nameservers or the registrar can now be changed; if nobody meant to, lock it again.`);
    if (j.parked.length) alert("failing", `${siteName}: ${t.label}'s nameservers moved to a parking host`, `Now: ${j.parked.join(", ")}. The domain has likely lapsed at the registrar.`);
    s.registration = o.registration;
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
      alert("expiring", `${t.kind === "domain" ? `${siteName}: ` : ""}${what} in ${days} day${days === 1 ? "" : "s"}`, null, { at: o.expiresAt!, word: "On", show: "date" });
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
