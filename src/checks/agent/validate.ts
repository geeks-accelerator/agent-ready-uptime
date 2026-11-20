/**
 * Validators for discovery files: the ones agents read (llms.txt, agent card,
 * OpenAPI, MCP manifest) and the ones crawlers and security researchers read
 * (robots.txt, security.txt). A 200 isn't enough: many apps answer any path
 * with their HTML shell, so each file is checked for what its reader actually
 * needs from it. Pure functions; `checkPage` applies them when a target's
 * `expect` is set, failing like a missing keyword does.
 */
import { hostOf, isHttpUrl } from "../url.js";

export type AgentFileKind =
  | "llms_txt" | "agent_card" | "openapi" | "mcp_manifest" | "robots_txt" | "security_txt"
  | "api_catalog" | "skills_index" | "ai_catalog" | "mcp_server_card";

/** Every kind a target can expect, or a config can name. */
export const AGENT_FILE_KINDS: readonly AgentFileKind[] = ["llms_txt", "agent_card", "openapi", "mcp_manifest", "robots_txt", "security_txt", "api_catalog", "skills_index", "ai_catalog", "mcp_server_card"];

/**
 * The newer files (an API catalog, an agent skills index, an AI catalog, an MCP server card): still
 * settling as standards, so discovery reads them only when asked (`kinds`), and a check can grade them.
 */
export const EMERGING_FILE_KINDS: readonly AgentFileKind[] = ["api_catalog", "skills_index", "ai_catalog", "mcp_server_card"];

/** What discovery looks for by default: the settled files. */
export const DISCOVERED_FILE_KINDS: readonly AgentFileKind[] = AGENT_FILE_KINDS.filter((k) => !EMERGING_FILE_KINDS.includes(k));

/** Names for the files, and the targets discovery makes from them, wherever they're shown (the dashboard, the try-it scan). */
export const AGENT_FILE_LABELS: Record<string, string> = {
  llms_txt: "llms.txt", agent_card: "Agent card", openapi: "OpenAPI", mcp_manifest: "MCP manifest", mcp: "MCP server", robots_txt: "robots.txt", security_txt: "security.txt", crawler: "Crawler probe",
  api_catalog: "API catalog", skills_index: "Agent skills index", ai_catalog: "AI catalog", mcp_server_card: "MCP server card",
};

/** Well-known locations, probed during discovery. */
export const AGENT_FILE_PATHS: Record<AgentFileKind, string> = {
  llms_txt: "/llms.txt",
  agent_card: "/.well-known/agent-card.json",
  openapi: "/openapi.json",
  mcp_manifest: "/.well-known/mcp.json",
  robots_txt: "/robots.txt",
  security_txt: "/.well-known/security.txt",
  // RFC 9727.
  api_catalog: "/.well-known/api-catalog",
  // Agent skills discovery (agentskills.io).
  skills_index: "/.well-known/agent-skills/index.json",
  // The AI catalog; some sites publish the same document as /.well-known/ard.json.
  ai_catalog: "/.well-known/ai-catalog.json",
  // MCP server cards (SEP-1649).
  mcp_server_card: "/.well-known/mcp/server-card.json",
};

/** Other places a file is published under: tried in order when the first answers not found. */
export const AGENT_FILE_ALTERNATES: Partial<Record<AgentFileKind, string[]>> = { ai_catalog: ["/.well-known/ard.json"] };

/**
 * Why a file failed, as a closed code: the try-it scan's public page shows only our own
 * sentence for it, never `detail` or `summary`, which can carry the file's own text.
 */
export type AgentFileReason =
  | "html_fallback" | "wrong_type" | "no_title" | "too_short" | "not_json" | "no_name" | "no_url" | "off_site"
  | "no_version" | "no_paths" | "no_endpoint" | "bad_endpoint" | "no_contact" | "expires_count" | "bad_expires"
  | "no_linkset" | "no_skills" | "no_entries";

export interface AgentFileVerdict {
  /** Machine-readable failure (null when valid). */
  error: string | null;
  /** Why it failed (null when valid). */
  reason: AgentFileReason | null;
  detail: string | null;
  /** One line to show: "Example", "OpenAPI 3.1 · 24 paths", "MCP at /mcp". */
  summary: string | null;
  /** MCP manifests: the server's endpoint. */
  mcpEndpoint?: string;
  /** security.txt: its Expires date (ISO). */
  expiresAt?: string;
}

const ok = (summary: string, extra: Partial<AgentFileVerdict> = {}): AgentFileVerdict => ({ error: null, reason: null, detail: null, summary, ...extra });
const bad = (kind: AgentFileKind, reason: AgentFileReason, detail: string): AgentFileVerdict => ({ error: `invalid_${kind}`, reason, detail, summary: null });

export function validateAgentFile(kind: AgentFileKind, body: string, contentType: string | null, url: string): AgentFileVerdict {
  const html = contentType === "text/html" || /^\s*<(!doctype|html)/i.test(body);
  if (html) return bad(kind, "html_fallback", "served an HTML page instead (an app fallback?)");
  switch (kind) {
    case "llms_txt":
      return llmsTxt(body, contentType);
    case "agent_card":
      return agentCard(body, url);
    case "openapi":
      return openapi(body);
    case "mcp_manifest":
      return mcpManifest(body, url);
    case "robots_txt":
      // Any text is a valid robots.txt (an empty one allows everything); what it
      // allows is judged in the page check, against the site's own pages.
      return ok("robots.txt");
    case "security_txt":
      return securityTxt(body);
    case "api_catalog":
      return apiCatalog(body);
    case "skills_index":
      return skillsIndex(body);
    case "ai_catalog":
      return aiCatalog(body);
    case "mcp_server_card":
      return mcpServerCard(body, url);
  }
}

/**
 * security.txt (RFC 9116): at least one Contact and exactly one Expires. A
 * signed file is read between the PGP markers.
 */
function securityTxt(body: string): AgentFileVerdict {
  const signed = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?\r?\n\r?\n([\s\S]*?)-----BEGIN PGP SIGNATURE-----/.exec(body);
  const text = signed ? signed[1]! : body;
  const fields = text.split(/\r?\n/).map((l) => /^([A-Za-z-]+):\s*(.+?)\s*$/.exec(l.replace(/#.*$/, ""))).filter((m): m is RegExpExecArray => m !== null);
  const contacts = fields.filter((m) => m[1]!.toLowerCase() === "contact");
  const expires = fields.filter((m) => m[1]!.toLowerCase() === "expires");
  if (!contacts.length) return bad("security_txt", "no_contact", "no Contact field");
  if (expires.length !== 1) return bad("security_txt", "expires_count", expires.length ? "more than one Expires field" : "no Expires field");
  const at = Date.parse(expires[0]![2]!);
  if (Number.isNaN(at)) return bad("security_txt", "bad_expires", `Expires "${expires[0]![2]}" isn't a date`);
  const iso = new Date(at).toISOString();
  return ok(`expires ${iso.slice(0, 10)}`, { expiresAt: iso });
}

function llmsTxt(body: string, contentType: string | null): AgentFileVerdict {
  if (contentType && contentType !== "text/plain" && contentType !== "text/markdown") return bad("llms_txt", "wrong_type", `content type ${contentType}, expected text/plain or text/markdown`);
  const first = body.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  if (!/^# \S/.test(first)) return bad("llms_txt", "no_title", "doesn't start with a \"# \" title (llmstxt.org)");
  if (body.trim().length < 100) return bad("llms_txt", "too_short", `only ${body.trim().length} characters`);
  return ok(first.slice(2).trim().slice(0, 80));
}

function json(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const sameSite = (a: string, b: string) => hostOf(a).replace(/^www\./, "") === hostOf(b).replace(/^www\./, "");

function agentCard(body: string, url: string): AgentFileVerdict {
  const o = json(body);
  if (!o) return bad("agent_card", "not_json", "not a JSON object");
  if (typeof o.name !== "string" || !o.name) return bad("agent_card", "no_name", "missing name");
  if (typeof o.url !== "string" || !o.url) return bad("agent_card", "no_url", "missing url");
  if (!sameSite(o.url, url)) return bad("agent_card", "off_site", `url points to ${hostOf(o.url)}, not this site`);
  return ok(o.name.slice(0, 80));
}

function openapi(body: string): AgentFileVerdict {
  const o = json(body);
  if (o) {
    const version = typeof o.openapi === "string" ? `OpenAPI ${o.openapi}` : typeof o.swagger === "string" ? `Swagger ${o.swagger}` : null;
    if (!version) return bad("openapi", "no_version", "no openapi or swagger version field");
    const paths = o.paths && typeof o.paths === "object" ? Object.keys(o.paths).length : 0;
    if (paths === 0) return bad("openapi", "no_paths", "no paths");
    return ok(`${version.replace(/^(\w+ \d+\.\d+)\.\d+$/, "$1")} · ${paths} path${paths === 1 ? "" : "s"}`);
  }
  // YAML, read just enough to know it's a spec with paths (no YAML dependency).
  const version = /^(openapi|swagger):\s*["']?([\d.]+)/m.exec(body);
  if (!version) return bad("openapi", "not_json", "neither JSON nor an OpenAPI YAML document");
  const paths = body.match(/^\s{2}\/\S*:\s*$/gm)?.length ?? 0;
  if (paths === 0) return bad("openapi", "no_paths", "no paths");
  return ok(`OpenAPI ${version[2]} · ${paths} path${paths === 1 ? "" : "s"}`);
}

function mcpManifest(body: string, url: string): AgentFileVerdict {
  const o = json(body);
  if (!o) return bad("mcp_manifest", "not_json", "not a JSON object");
  return mcpEndpointOf("mcp_manifest", o, url);
}

/** An MCP manifest's or server card's endpoint: `endpoint`, else the first `remotes[].url`. */
function mcpEndpointOf(kind: "mcp_manifest" | "mcp_server_card", o: Record<string, unknown>, url: string): AgentFileVerdict {
  const remotes = Array.isArray(o.remotes) ? (o.remotes as Array<Record<string, unknown> | null>) : [];
  const endpoint = typeof o.endpoint === "string" ? o.endpoint : remotes.map((r) => r?.url).find((u): u is string => typeof u === "string");
  if (!endpoint) return bad(kind, "no_endpoint", "names no endpoint (endpoint or remotes[].url)");
  let abs: string;
  try {
    abs = new URL(endpoint, url).toString();
  } catch {
    return bad(kind, "bad_endpoint", `endpoint "${endpoint}" isn't a URL`);
  }
  if (!isHttpUrl(abs)) return bad(kind, "bad_endpoint", `endpoint "${endpoint}" isn't an http(s) URL`);
  return ok(`MCP at ${sameSite(abs, url) ? new URL(abs).pathname : abs}`, { mcpEndpoint: abs });
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const objects = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);

/** An API catalog (RFC 9727): a linkset with at least one context that has an anchor. */
function apiCatalog(body: string): AgentFileVerdict {
  const o = json(body);
  if (!o) return bad("api_catalog", "not_json", "not a JSON object");
  const anchors = objects(o.linkset).filter((l) => typeof l.anchor === "string" && l.anchor);
  if (!anchors.length) return bad("api_catalog", "no_linkset", "no linkset entries with an anchor (RFC 9727)");
  return ok(count(anchors.length, "entry", "entries"));
}

/** An agent skills index: a list of skills, each named. */
function skillsIndex(body: string): AgentFileVerdict {
  const o = json(body);
  if (!o) return bad("skills_index", "not_json", "not a JSON object");
  const skills = objects(o.skills).filter((x) => typeof x.name === "string" && x.name);
  if (!skills.length) return bad("skills_index", "no_skills", "lists no named skills");
  return ok(count(skills.length, "skill"));
}

/** An AI catalog: at least one entry. */
function aiCatalog(body: string): AgentFileVerdict {
  const o = json(body);
  if (!o) return bad("ai_catalog", "not_json", "not a JSON object");
  const entries = objects(o.entries);
  if (!entries.length) return bad("ai_catalog", "no_entries", "lists no entries");
  return ok(count(entries.length, "entry", "entries"));
}

/** An MCP server card: a name and an endpoint. */
function mcpServerCard(body: string, url: string): AgentFileVerdict {
  const o = json(body);
  if (!o) return bad("mcp_server_card", "not_json", "not a JSON object");
  if (typeof o.name !== "string" || !o.name) return bad("mcp_server_card", "no_name", "missing name");
  return mcpEndpointOf("mcp_server_card", o, url);
}

/**
 * The links in an llms.txt that stay on its own site (`www.` folded), absolute, deduplicated and
 * without fragments, in order, at most `max`: what a check reads to see that they answer.
 */
export function llmsTxtLinks(body: string, url: string, max = 10): string[] {
  const out: string[] = [];
  // Bounded: a link's target is at most 2,000 characters and holds no spaces or brackets.
  for (const m of body.slice(0, 256 * 1024).matchAll(/\]\(\s{0,4}<?([^\s()<>]{1,2000})>?(?:\s{1,4}"[^"\n]{0,300}")?\s{0,4}\)/g)) {
    let abs: string;
    try {
      const u = new URL(m[1]!, url);
      u.hash = "";
      abs = u.toString();
    } catch {
      continue;
    }
    if (!isHttpUrl(abs) || !sameSite(abs, url) || out.includes(abs)) continue;
    out.push(abs);
    if (out.length >= max) break;
  }
  return out;
}
