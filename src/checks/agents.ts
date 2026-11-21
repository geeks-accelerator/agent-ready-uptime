/**
 * The AI agents that read websites, from each operator's own documentation: what each is for
 * (training a model, indexing for search answers, or fetching a page because a person asked), what
 * it says about robots.txt, and the token its user agent carries. One table, so the crawler probes,
 * the robots.txt check and anything that reads traffic name agents the same way.
 *
 * A row is a fact with a source: `docs` is the page it came from and `checked` the day it was read.
 * Re-check within 180 days. An agent whose purpose its operator leaves unclear or mixed isn't here
 * (Amazonbot, CCBot, Bytespider on 2026-11-21: it stays "another verified bot" to whoever reads
 * traffic), so nothing is called training or search on a guess. Bing's crawler page didn't render on
 * 2026-11-21; Bingbot keeps its earlier row. `alsoFeedsAi` is set only where the operator says so
 * (Apple); Google's and Bing's pages don't, so theirs is left unsaid.
 */

/** Training: collects pages to train models. Search: indexes pages for answers. User: fetches a page because a person asked, now. */
export type AgentPurpose = "training" | "search" | "user";

export interface AiAgent {
  /** The token in its user agent and robots.txt ("GPTBot"). Matched case-insensitively. */
  token: string;
  operator: string;
  /** Null for a robots.txt control token no request sends (Google-Extended). */
  purpose: AgentPurpose | null;
  /**
   * What its operator says about robots.txt: it follows it, or robots.txt may not apply because a
   * person asked for the page. A fetch an agent is documented to make regardless is never a violation.
   */
  robots: "follows" | "may-ignore-for-a-person";
  /** A search crawler whose pages also feed its operator's AI answers (AI Overviews, Copilot, Apple Intelligence). */
  alsoFeedsAi?: boolean;
  /** A user agent string in the form the operator documents, for probes. Absent for control tokens. */
  userAgent?: string;
  /** Judged by the robots.txt check and the free check (losing it costs search when `searchCritical`). */
  judged?: boolean;
  /** Losing it costs search traffic outright: its robots.txt alerts are outages, not warnings. */
  searchCritical?: boolean;
  /** Tried at the door by the crawler probes. */
  probe?: boolean;
  docs: string;
  /** YYYY-MM-DD. */
  checked: string;
}

const OPENAI = "https://developers.openai.com/api/docs/bots";
const ANTHROPIC = "https://support.claude.com/en/articles/8896518";
const PERPLEXITY = "https://docs.perplexity.ai/guides/bots";
const GOOGLE = "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers";
const BING = "https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0";
const APPLE = "https://support.apple.com/en-us/119829";
const META = "https://developers.facebook.com/docs/sharing/webmasters/web-crawlers";
const GOOGLE_USER = "https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers";
const DUCKDUCKGO = "https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot";
const MISTRAL = "https://docs.mistral.ai/robots";
const AMAZON = "https://developer.amazon.com/amazonbot";
const CHECKED = "2026-11-21";

/** Every agent we name. Order: the judged ones first (the robots.txt check's and free check's order), then by operator. */
export const AI_AGENTS: readonly AiAgent[] = [
  { token: "Googlebot", operator: "Google", purpose: "search", robots: "follows", judged: true, searchCritical: true, probe: true, userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/142.0.0.0 Safari/537.36", docs: GOOGLE, checked: CHECKED },
  { token: "Bingbot", operator: "Microsoft", purpose: "search", robots: "follows", judged: true, searchCritical: true, probe: true, userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/142.0.0.0 Safari/537.36", docs: BING, checked: CHECKED },
  { token: "OAI-SearchBot", operator: "OpenAI", purpose: "search", robots: "follows", judged: true, probe: true, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot", docs: OPENAI, checked: CHECKED },
  { token: "Claude-SearchBot", operator: "Anthropic", purpose: "search", robots: "follows", judged: true, probe: true, userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)", docs: ANTHROPIC, checked: CHECKED },
  { token: "PerplexityBot", operator: "Perplexity", purpose: "search", robots: "follows", judged: true, probe: true, userAgent: "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", docs: PERPLEXITY, checked: CHECKED },
  { token: "ChatGPT-User", operator: "OpenAI", purpose: "user", robots: "may-ignore-for-a-person", probe: true, userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", docs: OPENAI, checked: CHECKED },
  { token: "Claude-User", operator: "Anthropic", purpose: "user", robots: "follows", probe: true, userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)", docs: ANTHROPIC, checked: CHECKED },
  { token: "Perplexity-User", operator: "Perplexity", purpose: "user", robots: "may-ignore-for-a-person", probe: true, userAgent: "Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", docs: PERPLEXITY, checked: CHECKED },
  { token: "GPTBot", operator: "OpenAI", purpose: "training", robots: "follows", probe: true, userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot", docs: OPENAI, checked: CHECKED },
  { token: "ClaudeBot", operator: "Anthropic", purpose: "training", robots: "follows", probe: true, userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", docs: ANTHROPIC, checked: CHECKED },
  { token: "Google-Extended", operator: "Google", purpose: null, robots: "follows", docs: GOOGLE, checked: CHECKED },
  { token: "Applebot", operator: "Apple", purpose: "search", robots: "follows", alsoFeedsAi: true, docs: APPLE, checked: CHECKED },
  { token: "Applebot-Extended", operator: "Apple", purpose: null, robots: "follows", docs: APPLE, checked: CHECKED },
  { token: "meta-externalagent", operator: "Meta", purpose: "training", robots: "follows", docs: META, checked: CHECKED },
  { token: "meta-webindexer", operator: "Meta", purpose: "search", robots: "follows", docs: META, checked: CHECKED },
  { token: "meta-externalfetcher", operator: "Meta", purpose: "user", robots: "may-ignore-for-a-person", docs: META, checked: CHECKED },
  { token: "Google-Agent", operator: "Google", purpose: "user", robots: "may-ignore-for-a-person", docs: GOOGLE_USER, checked: CHECKED },
  { token: "DuckAssistBot", operator: "DuckDuckGo", purpose: "user", robots: "follows", docs: DUCKDUCKGO, checked: CHECKED },
  { token: "MistralAI-User", operator: "Mistral", purpose: "user", robots: "follows", docs: MISTRAL, checked: CHECKED },
  { token: "MistralAI-Index", operator: "Mistral", purpose: "search", robots: "follows", docs: MISTRAL, checked: CHECKED },
  { token: "MistralAI-Training", operator: "Mistral", purpose: "training", robots: "follows", docs: MISTRAL, checked: CHECKED },
  { token: "Amzn-SearchBot", operator: "Amazon", purpose: "search", robots: "follows", docs: AMAZON, checked: CHECKED },
  { token: "Amzn-User", operator: "Amazon", purpose: "user", robots: "may-ignore-for-a-person", docs: AMAZON, checked: CHECKED },
];

/** Our id for an agent: its token, lowercased (stable across versions of its user agent). */
export const agentId = (a: Pick<AiAgent, "token">) => a.token.toLowerCase();

const BY_TOKEN = new Map(AI_AGENTS.map((a) => [a.token.toLowerCase(), a]));

/** An agent by its token or id, or null. */
export function agentByToken(token: string): AiAgent | null {
  return BY_TOKEN.get(token.toLowerCase()) ?? null;
}

/** Agents that send requests (control tokens left out), longest token first so "Claude-SearchBot" wins over a shorter one. */
const SENDERS = AI_AGENTS.filter((a) => a.purpose !== null).sort((a, b) => b.token.length - a.token.length);

/** The agent a user agent names, by its token as a whole word, or null. Never matches text outside our table. */
export function agentNamed(userAgent: string): AiAgent | null {
  const ua = userAgent.toLowerCase();
  for (const a of SENDERS) {
    const t = a.token.toLowerCase();
    const i = ua.indexOf(t);
    if (i < 0) continue;
    const before = i === 0 ? "" : ua[i - 1]!;
    const after = ua[i + t.length] ?? "";
    if (!/[a-z0-9-]/.test(before) && !/[a-z0-9-]/.test(after)) return a;
  }
  return null;
}

/**
 * Who a request was, by its user agent and whether a CDN verified it (Cloudflare's verified bot
 * category, empty when unverified):
 * - `agent`: verified, and its user agent names one of ours;
 * - `claimed`: names one of ours, but not verified (anyone can send a name);
 * - `signed-assistant`: verified as an AI assistant without naming one of ours (an agent browsing
 *   for a person with a signature, like ChatGPT's agent): fetched for a person;
 * - `other`: verified, not ours (keeps the CDN's category);
 * - `unknown`: everything else.
 */
export type AgentRead =
  | { kind: "agent"; agent: AiAgent }
  | { kind: "claimed"; agent: AiAgent }
  | { kind: "signed-assistant" }
  | { kind: "other"; category: string }
  | { kind: "unknown" };

/** Cloudflare's verified bot category for assistants acting for a person. */
export const ASSISTANT_CATEGORY = "AI Assistant";

export function agentOf(userAgent: string, verifiedCategory: string): AgentRead {
  const named = agentNamed(userAgent);
  const verified = verifiedCategory.trim() !== "";
  if (named) return verified ? { kind: "agent", agent: named } : { kind: "claimed", agent: named };
  if (!verified) return { kind: "unknown" };
  return verifiedCategory === ASSISTANT_CATEGORY && /mozilla\/5\.0/i.test(userAgent) && /(chrome|safari|firefox)\//i.test(userAgent) ? { kind: "signed-assistant" } : { kind: "other", category: verifiedCategory };
}

/** robots.txt lines that keep search and people's questions and stop training, built from this table only. */
export function stopTrainingLines(): string[] {
  const tokens = AI_AGENTS.filter((a) => a.purpose === "training" || (a.purpose === null && /extended/i.test(a.token))).map((a) => a.token);
  return tokens.flatMap((t) => [`User-agent: ${t}`, "Disallow: /", ""]).slice(0, -1);
}
