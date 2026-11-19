import type { AgentTargetSpec } from "agent-ready-checks/agent/discover";
import { AGENT_FILE_LABELS } from "agent-ready-checks/agent/validate";
import { NOTIFY_CHANGES_BY_DEFAULT } from "agent-ready-checks/net/dns";
import { probeName } from "agent-ready-checks/robots";
import { PAGE_RETRIES, WARN_CONFIRM } from "agent-ready-checks/rules";
import { targetSpec, type CheckSpec } from "agent-ready-checks/spec";
import { apexDomain, siteUrl } from "agent-ready-checks/url";
import type { Config, Site } from "./config.js";

/** What one target is: a spec the checks package runs, or a sitemap or a domain's registration, which have their own fetches. */
export type TargetKind = "homepage" | "port" | "dns" | "agent" | "sitemap" | "domain";

export interface Target {
  /** Stable across restarts: the state file is keyed by it. */
  key: string;
  site: string;
  kind: TargetKind;
  /** How it's named in alerts and on the page. */
  label: string;
  url: string;
  spec?: CheckSpec;
  intervalS: number;
  /** Failures in a row before it's news. */
  confirmFailures: number;
  /** Retry a failure sooner than the interval (the homepage: 1 minute, then 5). */
  retriesS: number[];
  /** DNS: announce a change of records (the hosted service's default per record type). */
  announceChanges?: boolean;
  /** Sitemaps: fewer URLs than this fails. */
  minUrls?: number;
  timeoutMs: number;
}

type Defaults = Config["defaults"];

/** The targets a site has before anything is discovered: its homepage, ports, DNS records and domain. */
export function siteTargets(site: Site, d: Defaults): Target[] {
  if (site.paused) return [];
  const home = site.homepage ?? {};
  const out: Target[] = [];
  const homeUrl = siteUrl(site.url, home.url ?? "/");
  const timeoutMs = home.timeoutMs ?? d.timeoutMs;
  const { keyword, keywordAbsent, expectedStatus, expectedFinalUrl } = home;
  out.push({
    key: `${site.slug}:home`,
    site: site.slug,
    kind: "homepage",
    label: "Homepage",
    url: homeUrl,
    spec: { url: homeUrl, kind: "page", options: { timeoutMs, seoChecks: false, ...defined({ keyword, keywordAbsent, expectedStatus, expectedFinalUrl }) } },
    intervalS: home.intervalSeconds ?? d.homepageIntervalSeconds,
    confirmFailures: home.confirmFailures ?? PAGE_RETRIES.length + 1,
    retriesS: PAGE_RETRIES,
    timeoutMs,
  });
  const host = new URL(site.url).hostname;
  for (const p of site.ports ?? []) {
    const url = `tcp://${p.host ?? host}:${p.port}`;
    out.push({
      key: `${site.slug}:port:${p.host ?? host}:${p.port}`,
      site: site.slug,
      kind: "port",
      label: `${p.name} (port ${p.port})`,
      url,
      spec: { url, kind: "port", options: { timeoutMs: d.timeoutMs, ...defined({ tls: p.tls, send: p.send, expect: p.expect }) } },
      intervalS: d.portIntervalSeconds,
      confirmFailures: PAGE_RETRIES.length + 1,
      retriesS: PAGE_RETRIES,
      timeoutMs: d.timeoutMs,
    });
  }
  for (const r of site.dns ?? []) {
    const url = `dns://${r.name}/${r.type}`;
    out.push({
      key: `${site.slug}:dns:${r.name}/${r.type}`,
      site: site.slug,
      kind: "dns",
      label: `${r.type} for ${r.name}`,
      url,
      spec: { url, kind: "dns", options: { timeoutMs: d.timeoutMs, ...(r.expect?.length ? { expect: r.expect } : {}) } },
      intervalS: d.dnsIntervalSeconds,
      confirmFailures: WARN_CONFIRM,
      retriesS: [],
      announceChanges: r.notifyChanges ?? NOTIFY_CHANGES_BY_DEFAULT.has(r.type),
      timeoutMs: d.timeoutMs,
    });
  }
  // The domain's registration (RDAP), daily: not for an IP address or a local name.
  const domain = site.domain ?? (/^[\d.]+$|:|^[^.]+$/.test(host) ? null : apexDomain(host));
  if (domain) out.push({ key: `${site.slug}:domain`, site: site.slug, kind: "domain", label: `The domain ${domain}`, url: domain, intervalS: 86_400, confirmFailures: WARN_CONFIRM, retriesS: [], timeoutMs: d.timeoutMs });
  return out;
}

/** A sitemap the site lists (or the config names). */
export function sitemapTarget(site: Site, url: string, d: Defaults): Target {
  const s = site.sitemaps || {};
  const timeoutMs = s.timeoutMs ?? d.sitemapTimeoutMs;
  return { key: `${site.slug}:sitemap:${url}`, site: site.slug, kind: "sitemap", label: `Sitemap ${new URL(url).pathname}`, url, intervalS: s.intervalSeconds ?? d.sitemapIntervalSeconds, confirmFailures: WARN_CONFIRM, retriesS: [], minUrls: s.minUrls ?? 1, timeoutMs };
}

/** An agent file, the MCP server or a crawler probe the site's discovery found. */
export function agentTarget(site: Site, t: AgentTargetSpec, d: Defaults): Target {
  const a = typeof site.agent === "object" ? site.agent : {};
  const timeoutMs = a.timeoutMs ?? d.timeoutMs;
  const label = t.source === "mcp" ? "MCP server" : t.source === "crawler" ? (t.title ?? "Crawler probe") : (AGENT_FILE_LABELS[t.source] ?? t.source);
  return {
    key: `${site.slug}:agent:${t.source}:${t.url}`,
    site: site.slug,
    kind: "agent",
    label,
    url: t.url,
    spec: targetSpec(t.url, t.source, { timeoutMs, seoChecks: false }, a.crawlers),
    intervalS: a.intervalSeconds ?? d.agentIntervalSeconds,
    confirmFailures: WARN_CONFIRM,
    retriesS: [],
    timeoutMs,
  };
}

/** Whether the site's `agent.exclude` leaves a discovered target out ("llms_txt", "mcp", "crawler:GPTBot"). */
export function excluded(site: Site, t: AgentTargetSpec): boolean {
  const ex = typeof site.agent === "object" ? (site.agent.exclude ?? []) : [];
  if (t.source === "crawler") return ex.includes(`crawler:${probeName(t.url) ?? ""}`);
  return ex.includes(t.source);
}

/** Only the keys that are set (the check options are exactOptionalPropertyTypes-clean). */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
