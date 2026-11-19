import { z } from "zod";
import { AGENT_FILE_KINDS } from "./agent/validate.js";
import { DNS_TYPES } from "./net/dns.js";

/**
 * A site, as both agent-ready-uptime and the hosted service read it: one definition
 * of each key, so a site entry means the same thing in both. The hosted service
 * spreads these shapes into its own schema and adds its keys (journeys, nav pages,
 * warnings that need history); every key here is one agent-ready-uptime acts on.
 */

/** What a page check judges by itself (`checkPage`), and how often it runs. */
export const openPageOptions = {
  /** Page must contain this text. */
  keyword: z.string().optional(),
  /** Page must NOT contain this text. */
  keywordAbsent: z.string().optional(),
  /** Acceptable final status codes (default any 2xx). */
  expectedStatus: z.array(z.number().int()).optional(),
  /** Final URL after redirects must match (normalized). */
  expectedFinalUrl: z.string().optional(),
  /** Consecutive failures before "down" (default 2). */
  confirmFailures: z.number().int().min(1).max(10).optional(),
  timeoutMs: z.number().int().positive().optional(),
  intervalSeconds: z.number().int().min(30).optional(),
};

export const homepageUrl = {
  /** Check this URL instead of "/" (e.g. a health endpoint). Path or absolute URL. */
  url: z.string().optional(),
};

export const openSitemapOptions = {
  /** Paths/URLs to check. Omit to discover from robots.txt (+ /sitemap.json probe). */
  urls: z.array(z.string()).optional(),
  /** Probe /sitemap.json during discovery (default true). */
  probeJson: z.boolean().optional(),
  /** Paths/URLs to ignore even if discovered. */
  exclude: z.array(z.string()).optional(),
  /** Fail when a sitemap lists fewer URLs than this (default 1). */
  minUrls: z.number().int().nonnegative().optional(),
  intervalSeconds: z.number().int().min(60).optional(),
  timeoutMs: z.number().int().positive().optional(),
};

/**
 * Agent checks, on for every site unless `false` (like sitemaps): the
 * discovery files (llms.txt, agent card, OpenAPI, MCP, robots.txt,
 * security.txt) and crawler probes. The monitor discovers which well-known
 * files the site serves (and its MCP endpoint from /.well-known/mcp.json);
 * the object form adds locations that aren't well-known, extra crawler user
 * agents, and what not to watch. A file we've watched that disappears fails,
 * never silently goes.
 */
export const agentSchema = z.union([
  z.boolean(),
  z.strictObject({
    /** Non-standard locations, e.g. { openapi: "/api/openapi.json" }. */
    paths: z.partialRecord(z.enum(AGENT_FILE_KINDS as [string, ...string[]]), z.string()).optional(),
    /** MCP endpoint (path or URL) when the site has no /.well-known/mcp.json. */
    mcp: z.string().optional(),
    /** Files, the MCP server or crawler probes not to watch, e.g. ["agent_card", "crawler:GPTBot"]: retired if watched (like a sitemap's `exclude`). */
    exclude: z.array(z.union([z.enum(["mcp", ...AGENT_FILE_KINDS] as [string, ...string[]]), z.string().regex(/^crawler:.+$/)])).optional(),
    /** More user agents for the crawler probes, besides the built-in ones (a same-named built-in is replaced). */
    crawlers: z.array(z.strictObject({ name: z.string().min(1).max(60), userAgent: z.string().min(1).max(500) })).optional(),
    intervalSeconds: z.number().int().min(60).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);

export const hostname = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, "a host name, e.g. mail.example.com");

/** A TCP port, checked every minute: connected (and TLS, and a reply containing `expect`, when set). The host defaults to the site's. */
export const portSchema = z.strictObject({
  name: z.string().min(1),
  host: hostname.optional(),
  port: z.number().int().min(1).max(65_535),
  tls: z.boolean().optional(),
  send: z.string().min(1).max(1000).optional(),
  expect: z.string().min(1).max(1000).optional(),
});

/**
 * A DNS record set, asked of the zone's own nameservers every 15 minutes. Fails when the
 * name stops resolving, the nameservers disagree, or an `expect` value is missing. A change
 * is announced for CNAME, MX, TXT, CAA and NS; for A and AAAA only with `notifyChanges`.
 */
export const dnsSchema = z.strictObject({
  name: hostname,
  type: z.enum(DNS_TYPES),
  expect: z.array(z.string().min(1)).max(20).optional(),
  notifyChanges: z.boolean().optional(),
});

/** The keys of a site both read. */
export const openSiteShape = {
  /** Stable id used in the database and URLs. */
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  /** Base URL, e.g. https://example.com */
  url: z.string().url(),
  /** Registered domain for RDAP when it isn't the last two labels of the host. */
  domain: z
    .string()
    .regex(/^[^/:@\s]+\.[^/:@\s]+$/, "a domain name only (example.com), not a URL")
    .optional(),
  paused: z.boolean().optional(),
  homepage: z.strictObject({ ...openPageOptions, ...homepageUrl }).optional(),
  sitemaps: z.union([z.literal(false), z.strictObject(openSitemapOptions)]).optional(),
  agent: agentSchema.optional(),
  ports: z.array(portSchema).optional(),
  dns: z.array(dnsSchema).optional(),
};

export const openSiteSchema = z.strictObject(openSiteShape);
export type OpenSite = z.infer<typeof openSiteSchema>;

/** How often each kind of check runs, unless a site says otherwise. */
export const openDefaultsShape = {
  homepageIntervalSeconds: z.number().int().min(30).default(60),
  // llms.txt, OpenAPI, agent cards and MCP servers change rarely.
  agentIntervalSeconds: z.number().int().min(60).default(3600),
  portIntervalSeconds: z.number().int().min(30).default(60),
  dnsIntervalSeconds: z.number().int().min(60).default(900),
  sitemapIntervalSeconds: z.number().int().min(60).default(1800),
  timeoutMs: z.number().int().positive().default(10_000),
  sitemapTimeoutMs: z.number().int().positive().default(30_000),
};
