import { z } from "zod";
import { checkPage, type PageCheckOptions, type PageCheckResult } from "./http/page-check.js";
import { checkMcp } from "./mcp/check.js";
import { checkPort, type PortCheckOptions } from "./net/port.js";
import { checkDns, DNS_TYPES, type DnsCheckOptions } from "./net/dns.js";
import { AGENT_FILE_KINDS, type AgentFileKind } from "./agent/validate.js";
import { probeCrawler, probeName, type Crawler } from "./robots.js";
import { isHttpUrl } from "./url.js";

/**
 * One check, as data: the URL, whether it's an MCP handshake or a page fetch,
 * and the options. The monitor runs it, and sends the same spec to the second
 * location (src/confirm), so the two always check the same way.
 */
export type CheckSpec =
  | { url: string; kind: "page" | "mcp"; options: PageCheckOptions }
  | { url: string; kind: "port"; options: PortCheckOptions }
  | { url: string; kind: "dns"; options: DnsCheckOptions };


export interface Checkers {
  checkPage: typeof checkPage;
  checkMcp: typeof checkMcp;
  checkPort: typeof checkPort;
  checkDns: typeof checkDns;
}

export const DEFAULT_CHECKERS: Checkers = { checkPage, checkMcp, checkPort, checkDns };

/** Run a spec: a page fetch, an MCP handshake, a TCP port or a DNS lookup, with its options. */
export function runSpec(spec: CheckSpec, c: Checkers): Promise<PageCheckResult> {
  if (spec.kind === "port") return c.checkPort(spec.url, spec.options);
  if (spec.kind === "dns") return c.checkDns(spec.url, spec.options);
  return spec.kind === "mcp" ? c.checkMcp(spec.url, spec.options) : c.checkPage(spec.url, spec.options);
}

const timeoutMs = z.number().int().min(1000).max(120_000).optional();

/** A spec as the second location accepts it: only the options a monitor sends, each checked, by kind. */
export const specSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("port"),
    url: z.string().max(300).regex(/^tcp:\/\/[^\s/@]+:\d{1,5}$/, "must be tcp://host:port"),
    options: z.strictObject({ timeoutMs, tls: z.boolean().optional(), send: z.string().max(1000).optional(), expect: z.string().max(1000).optional() }),
  }),
  z.strictObject({
    kind: z.literal("dns"),
    url: z.string().max(300).regex(new RegExp(`^dns://[^\\s/@]+/(${DNS_TYPES.join("|")})$`), "must be dns://name/TYPE"),
    options: z.strictObject({ timeoutMs, expect: z.array(z.string().max(500)).max(20).optional() }),
  }),
  z.strictObject({
    url: z.string().max(2048).refine(isHttpUrl, "must be an http(s) URL"),
    kind: z.enum(["page", "mcp"]),
    options: z.strictObject({
      timeoutMs: z.number().int().min(1000).max(120_000).optional(),
      maxBytes: z.number().int().min(1).max(20 * 1024 * 1024).optional(),
      expectedStatus: z.array(z.number().int().min(100).max(599)).max(20).optional(),
      keyword: z.string().max(1000).optional(),
      keywordAbsent: z.string().max(1000).optional(),
      expectedFinalUrl: z.string().max(2048).optional(),
      seoChecks: z.boolean().optional(),
      accept: z.string().max(500).optional(),
      profile: z.union([z.enum(["monitor", "browser"]), z.strictObject({ userAgent: z.string().min(1).max(500) })]).optional(),
      expect: z.enum(AGENT_FILE_KINDS as [AgentFileKind, ...AgentFileKind[]]).optional(),
      robotsPaths: z.array(z.string().max(2048)).max(100).optional(),
    }),
  }),
]);

/**
 * The spec for a page-like target by its source: an MCP endpoint (a handshake), a crawler
 * probe (its page fetched as that crawler; llms.txt still has to be a real llms.txt), an
 * agent file (validated as its kind), or a plain page. `crawlers`: the site's extra user agents.
 */
export function targetSpec(url: string, source: string, opts: PageCheckOptions, crawlers?: readonly Crawler[]): CheckSpec {
  if (source === "mcp") return { url, kind: "mcp", options: { ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.profile ? { profile: opts.profile } : {}) } };
  if (source === "crawler") {
    const name = probeName(url) ?? "";
    const c = probeCrawler(name, crawlers);
    const page = url.split("#")[0]!;
    return { url: page, kind: "page", options: { ...withoutRobotsPaths(opts), seoChecks: false, profile: { userAgent: c?.userAgent ?? name }, ...(page.endsWith("/llms.txt") ? { expect: "llms_txt" as const } : {}) } };
  }
  if (!isAgentFile(source)) return { url, kind: "page", options: withoutRobotsPaths(opts) };
  return { url, kind: "page", options: source === "robots_txt" ? { ...opts, expect: source } : { ...withoutRobotsPaths(opts), expect: source } };
}

/** Only robots.txt is judged on the site's paths; other checks don't carry them. */
function withoutRobotsPaths(o: PageCheckOptions): PageCheckOptions {
  const { robotsPaths: _, ...rest } = o;
  return rest;
}

export function isAgentFile(source: string): source is AgentFileKind {
  return (AGENT_FILE_KINDS as readonly string[]).includes(source);
}
