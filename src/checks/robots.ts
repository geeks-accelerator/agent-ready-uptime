/**
 * robots.txt, read the way search engines read it (RFC 9309, with Google's
 * documented precedence): which crawler may fetch which path, and which rule
 * decided. Pure functions. Used by sitemap discovery (`Sitemap:` lines) and by
 * the robots.txt check.
 */
import { AI_AGENTS } from "./agents.js";

export interface RobotsRule {
  allow: boolean;
  path: string;
  /** The line as written ("Disallow: /admin"), for alerts. */
  line: string;
}

export interface RobotsGroup {
  /** User-agent tokens, lowercased ("*" for everyone). */
  agents: string[];
  rules: RobotsRule[];
  /** `Crawl-delay` in seconds, when the group sets one (not in RFC 9309, but widely honoured). */
  crawlDelay?: number;
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines share a group; a rule line ends the run.
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      // An empty Disallow allows everything: it's no rule at all.
      if (current && value) current.rules.push({ allow: field === "allow", path: value, line: `${field === "allow" ? "Allow" : "Disallow"}: ${value}` });
    } else if (field === "crawl-delay") {
      lastWasAgent = false;
      const n = Number(value);
      if (current && Number.isFinite(n) && n >= 0) current.crawlDelay = Math.max(current.crawlDelay ?? 0, n);
    } else if (field === "sitemap") {
      if (value) sitemaps.push(value);
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

/**
 * The group that applies to a crawler: the one naming its token (Google
 * matches the product token case-insensitively, ignoring version and the
 * rest of the user-agent string), else `*`. Several groups for one agent are
 * merged, as RFC 9309 says.
 */
export function groupFor(robots: Robots, token: string): RobotsGroup | null {
  const t = token.toLowerCase();
  const named = robots.groups.filter((g) => g.agents.includes(t));
  const chosen = named.length ? named : robots.groups.filter((g) => g.agents.includes("*"));
  if (!chosen.length) return null;
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== undefined);
  return { agents: [...new Set(chosen.flatMap((g) => g.agents))], rules: chosen.flatMap((g) => g.rules), ...(delays.length ? { crawlDelay: Math.max(...delays) } : {}) };
}

/** Does robots.txt have a group naming this crawler itself (not only `*`)? */
export function namesAgent(robots: Robots, token: string): boolean {
  const t = token.toLowerCase();
  return robots.groups.some((g) => g.agents.includes(t));
}

/** The `Crawl-delay` that applies to a crawler (its own group's, else `*`'s), in seconds, or null. */
export function crawlDelay(robots: Robots, token: string): number | null {
  return groupFor(robots, token)?.crawlDelay ?? null;
}

/** Length of a match of a rule path against a URL path, or -1. `*` matches any run, `$` ends the path. */
function matchLength(rule: string, path: string): number {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  return wildcardMatch(anchored ? body : `${body}*`, path) ? body.length : -1;
}

/**
 * Does `pattern` (where `*` is any run) match all of `text`? Two pointers, backing up only to
 * the last `*`: time bounded by the lengths' product, no regex, so a rule of thousands of `*`
 * (a robots.txt is the site's text) can neither overflow the stack nor stall a check.
 */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Percent-encoding differences don't matter: compare decoded-where-safe forms. */
function normalPath(p: string): string {
  try {
    return decodeURI(p);
  } catch {
    return p;
  }
}

/**
 * Whether a crawler may fetch a path, and the rule that decided (null when
 * no rule matched: allowed). The longest matching rule wins; Allow wins a tie.
 */
export function decidingRule(robots: Robots, token: string, path: string): { allowed: boolean; rule: RobotsRule | null; group: RobotsGroup | null } {
  const group = groupFor(robots, token);
  if (!group) return { allowed: true, rule: null, group: null };
  const target = normalPath(path || "/");
  let best: RobotsRule | null = null;
  let bestLen = -1;
  for (const r of group.rules) {
    const len = matchLength(normalPath(r.path), target);
    if (len < 0) continue;
    if (len > bestLen || (len === bestLen && r.allow && !best!.allow)) {
      best = r;
      bestLen = len;
    }
  }
  return { allowed: best ? best.allow : true, rule: best, group };
}

/**
 * The crawlers that bring readers: search engines and AI search. Training
 * crawlers (GPTBot, Google-Extended, CCBot) are left out: blocking them is a
 * policy choice. So are agents a person sends (ChatGPT-User, Claude-User,
 * Perplexity-User), which may not follow robots.txt; the crawler probes test
 * those at the door instead.
 *
 * User-agent strings as each operator documents them, checked 2026-11-17.
 * WAF rules match the token inside the string, so the token is what counts;
 * versions drift, and the browser part of a string is an example.
 * - Googlebot: https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers (desktop)
 * - Bingbot: Bing's crawler page didn't load on 2026-11-17; this is its widely logged desktop form.
 * - OAI-SearchBot, ChatGPT-User, GPTBot: https://developers.openai.com/api/docs/bots
 * - Claude-SearchBot, Claude-User, ClaudeBot: https://support.claude.com/en/articles/8896518 gives the
 *   tokens only; the strings follow the form Anthropic's crawlers send.
 * - PerplexityBot, Perplexity-User: https://docs.perplexity.ai/guides/bots
 */
export interface Crawler {
  /** The robots.txt token, also the probe's name. */
  name: string;
  userAgent: string;
  /** Losing it costs search traffic outright: its alerts are outages, not warnings. */
  search?: boolean;
}

/** The crawlers the robots.txt check and the free check judge, from the agent table (`judged`). */
export const CRAWLERS: readonly Crawler[] = AI_AGENTS.filter((a) => a.judged).map((a) => ({ name: a.token, userAgent: a.userAgent!, ...(a.searchCritical ? { search: true } : {}) }));

/** Crawlers the probes try at the door: the judged ones, agents a person sends, and training crawlers (`probe`). */
export const CRAWLER_PROBES: readonly Crawler[] = [...CRAWLERS, ...AI_AGENTS.filter((a) => a.probe && !a.judged).map((a) => ({ name: a.token, userAgent: a.userAgent! }))];

/**
 * A crawler probe's target: the page it fetches, named by a fragment
 * ("https://e.com/#as-GPTBot"), like journeys. Fragments aren't sent.
 */
export function probeUrl(pageUrl: string, name: string): string {
  return `${pageUrl.split("#")[0]}#as-${encodeURIComponent(name)}`;
}

/** The crawler a probe target is named for, or null. */
export function probeName(url: string): string | null {
  const m = /#as-(.+)$/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** A probe's crawler: from the site's own list first, then the built-in one. */
export function probeCrawler(name: string, extra: readonly Crawler[] = []): Crawler | null {
  return extra.find((c) => c.name === name) ?? CRAWLER_PROBES.find((c) => c.name === name) ?? null;
}

/**
 * The robots.txt fingerprint's recipe: a hash of `RobotsState.rules`. Bumped when which lines count
 * changes, so a monitor comparing fingerprints treats the new recipe as a new scheme, never as an edit
 * (2: every AI agent's own group counts, 0.8.0).
 */
export const ROBOTS_FINGERPRINT = "robots2:";

/** What a robots.txt check stores (the target's fingerprintData). */
export interface RobotsState {
  /** The rule lines that apply to CRAWLERS, `*` and every agent in AI_AGENTS, normalised ("User-agent: *", "Disallow: /x"). */
  rules: string[];
  /** "Googlebot /pricing" pairs now blocked, each with the line that decided. */
  blocked: { pair: string; rule: string; agents: string }[];
  /** Pairs allowed now. */
  allowed: string[];
  /** Pairs ever allowed (kept across checks by `carryRobotsState`): only these can alert. */
  seen?: string[];
  /** The rules at the last check that blocked nothing seen: what the alert's changed lines compare with. */
  goodRules?: string[];
}

/** Pairs blocked now that were allowed before. */
export function lostPairs(now: RobotsState, before: RobotsState | null): RobotsState["blocked"] {
  const seen = new Set([...(before?.seen ?? []), ...(before?.allowed ?? [])]);
  return now.blocked.filter((b) => seen.has(b.pair));
}

/** The state to store after a check: today's, plus what's carried across checks. */
export function carryRobotsState(now: RobotsState, before: RobotsState | null): RobotsState {
  const seen = [...new Set([...(before?.seen ?? []), ...(before?.allowed ?? []), ...now.allowed])].sort();
  const goodRules = lostPairs(now, before).length ? (before?.goodRules ?? before?.rules ?? []) : now.rules;
  return { ...now, seen, goodRules };
}

/** Judge a robots.txt for CRAWLERS on the given paths. */
export function robotsState(text: string, paths: string[]): RobotsState {
  const robots = parseRobots(text);
  const blocked: RobotsState["blocked"] = [];
  const allowed: string[] = [];
  const groups = new Set<RobotsGroup>();
  for (const c of CRAWLERS) {
    for (const p of paths.length ? paths : ["/"]) {
      const pair = `${c.name} ${p}`;
      const d = decidingRule(robots, c.name, p);
      if (d.allowed) allowed.push(pair);
      else blocked.push({ pair, rule: d.rule!.line, agents: d.group!.agents.join(", ") });
    }
    for (const g of robots.groups) if (g.agents.includes(c.name.toLowerCase()) || g.agents.includes("*")) groups.add(g);
  }
  // Every AI agent's own group too, so a rule for one agent (User-agent: GPTBot) is seen as a change.
  for (const g of robots.groups) if (AI_AGENTS.some((a) => g.agents.includes(a.token.toLowerCase()))) groups.add(g);
  const rules = [...groups].flatMap((g) => [...g.agents.map((a) => `User-agent: ${a}`), ...g.rules.map((r) => r.line)]);
  return { rules, blocked, allowed };
}

/** Rule lines added and removed between two states, for the alert. */
export function robotsDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((l) => !b.has(l)), removed: before.filter((l) => !a.has(l)) };
}

/** "Googlebot /" → "Googlebot can't read /"-style summary of a state, for the dashboard. */
export function robotsSummary(s: RobotsState): string {
  if (!s.blocked.length) return "allows search crawlers";
  const first = s.blocked[0]!.pair.replace(" ", " from ");
  return s.blocked.length === 1 ? `blocks ${first}` : `blocks ${first} and ${s.blocked.length - 1} more`;
}
