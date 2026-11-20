import { checkPage, type PageCheckResult } from "../http/page-check.js";
import type { RequestProfile } from "../http/request.js";
import { siteUrl } from "../url.js";
import { CRAWLER_PROBES, probeUrl, type Crawler } from "../robots.js";
import { AGENT_FILE_ALTERNATES, AGENT_FILE_PATHS, DISCOVERED_FILE_KINDS, validateAgentFile, type AgentFileKind } from "./validate.js";

export interface AgentTargetSpec {
  url: string;
  source: AgentFileKind | "mcp" | "crawler";
  title?: string;
}

export interface DiscoverOptions {
  paths?: Partial<Record<AgentFileKind, string>>;
  mcp?: string;
  timeoutMs?: number;
  profile?: RequestProfile;
  homepage?: string;
  crawlers?: readonly Crawler[];
  /** Run the crawler probes (default true). The try-it scan doesn't: sending a crawler's user agent is for the site's owner. */
  probes?: boolean;
  /** Follow redirects only on the site's own host (the try-it scan). */
  sameHost?: boolean;
  /** robots.txt: the paths to judge it on. */
  robotsPaths?: string[];
  /** Each file's size cap (default `checkPage`'s). */
  maxBytes?: number;
  /** Which files to look for (default the settled ones, `DISCOVERED_FILE_KINDS`, in that order). */
  kinds?: readonly AgentFileKind[];
}

/**
 * Find a site's agent-facing files: probe each well-known location (or the
 * configured path) and keep the ones that are valid, plus the MCP endpoint
 * named by /.well-known/mcp.json (or configured). Like discoverSitemaps:
 * the engine caches the answer and never drops a target it already watches.
 * `files` is every file's check, passed or not (the try-it scan shows them).
 */
export async function discoverAgentFiles(
  baseUrl: string,
  opts: DiscoverOptions = {},
): Promise<{ targets: AgentTargetSpec[]; notes: string[]; files: Array<{ kind: AgentFileKind; url: string; result: PageCheckResult }> }> {
  const targets: AgentTargetSpec[] = [];
  const notes: string[] = [];
  const files: Array<{ kind: AgentFileKind; url: string; result: PageCheckResult }> = [];
  let mcp = opts.mcp ?? null;
  for (const kind of opts.kinds ?? DISCOVERED_FILE_KINDS) {
    const read = (u: string) =>
      checkPage(u, {
        expect: kind,
        seoChecks: false,
        timeoutMs: opts.timeoutMs ?? 10_000,
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(opts.sameHost ? { sameHost: true } : {}),
        ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
        ...(kind === "robots_txt" && opts.robotsPaths ? { robotsPaths: opts.robotsPaths } : {}),
      });
    let url = opts.paths?.[kind] ?? siteUrl(baseUrl, AGENT_FILE_PATHS[kind]);
    let r = await read(url);
    // A file some sites publish under another name (the AI catalog as ard.json): tried only when the first isn't there.
    for (const alt of opts.paths?.[kind] ? [] : (AGENT_FILE_ALTERNATES[kind] ?? [])) {
      if (r.statusCode !== 404 && r.statusCode !== 410) break;
      url = siteUrl(baseUrl, alt);
      r = await read(url);
    }
    files.push({ kind, url, result: r });
    if (!r.ok) {
      notes.push(`${url}: ${r.errorDetail ?? r.error}`);
      continue;
    }
    targets.push({ url, source: kind });
    if (kind === "mcp_manifest" && !mcp) mcp = validateAgentFile(kind, r.raw.body.toString("utf8"), r.contentType, r.finalUrl).mcpEndpoint ?? null;
  }
  if (mcp) targets.push({ url: mcp, source: "mcp" });
  if (opts.probes === false) return { targets, notes, files };

  // Crawler probes: is the door open to each crawler, on the homepage and llms.txt? Only the
  // ones that get in now are watched, so a crawler the site already refuses is its choice,
  // not an alert. One request at a time.
  const homepage = opts.homepage ?? siteUrl(baseUrl, "/");
  const llms = targets.find((t) => t.source === "llms_txt")?.url;
  const crawlers = [...CRAWLER_PROBES.filter((c) => !opts.crawlers?.some((x) => x.name === c.name)), ...(opts.crawlers ?? [])];
  for (const c of crawlers) {
    for (const [page, label, expect] of [[homepage, "Homepage", undefined], ...(llms ? [[llms, "llms.txt", "llms_txt"] as const] : [])] as const) {
      const r = await checkPage(page, { seoChecks: false, timeoutMs: opts.timeoutMs ?? 10_000, profile: { userAgent: c.userAgent }, ...(expect ? { expect } : {}) });
      if (r.ok) targets.push({ url: probeUrl(page, c.name), source: "crawler", title: `${label} as ${c.name}` });
      else notes.push(`${page} as ${c.name}: ${r.errorDetail ?? r.error}`);
    }
  }
  return { targets, notes, files };
}
