import { describe, expect, it } from "vitest";
import { AI_AGENTS, agentByToken, agentNamed, agentOf, stopTrainingLines } from "../../src/checks/agents.js";
import { CRAWLER_PROBES, CRAWLERS, ROBOTS_FINGERPRINT } from "../../src/checks/robots.js";
import { sameRecipe } from "../../src/checks/rules.js";

describe("the AI agent table", () => {
  it("keeps the crawlers judged and probed exactly as before (the free check's weights and the probes don't move)", () => {
    expect(CRAWLERS.map((c) => [c.name, !!c.search])).toEqual([["Googlebot", true], ["Bingbot", true], ["OAI-SearchBot", false], ["Claude-SearchBot", false], ["PerplexityBot", false]]);
    expect(CRAWLER_PROBES.map((c) => c.name)).toEqual(["Googlebot", "Bingbot", "OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "ChatGPT-User", "Claude-User", "Perplexity-User", "GPTBot", "ClaudeBot"]);
    for (const c of CRAWLER_PROBES) expect(c.userAgent.toLowerCase(), c.name).toContain(c.name.toLowerCase());
  });

  it("gives every agent a purpose and a source checked within 180 days, and one row per token", () => {
    const tokens = AI_AGENTS.map((a) => a.token.toLowerCase());
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const a of AI_AGENTS) {
      expect(a.docs, a.token).toMatch(/^https:\/\//);
      expect(Date.now() - Date.parse(`${a.checked}T00:00:00Z`), a.token).toBeLessThan(180 * 86_400_000);
      if (a.purpose === null) expect(a.userAgent, a.token).toBeUndefined();
    }
  });

  it("finds an agent by its token as a whole word, case-insensitively, and the longest one", () => {
    expect(agentNamed("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot")?.token).toBe("ChatGPT-User");
    expect(agentNamed("Mozilla/5.0 (compatible; claude-searchbot/1.0)")?.token).toBe("Claude-SearchBot");
    expect(agentNamed("meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)")?.token).toBe("meta-webindexer");
    expect(agentNamed("NotGPTBotReally/1.0")).toBeNull();
    expect(agentNamed("Mozilla/5.0 Chrome/142.0")).toBeNull();
    expect(agentByToken("gptbot")?.purpose).toBe("training");
    // The first appearance may be part of a longer word; a later one still names the agent.
    expect(agentNamed("Googlebot-Video/1.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")?.token).toBe("Googlebot");
    expect(agentNamed("Googlebot-Video/1.0")).toBeNull();
  });

  it("counts a name only when verified, calls a verified browser in the assistant category a signed assistant, and keeps others' categories", () => {
    expect(agentOf("ChatGPT-User/1.0", "AI Assistant")).toMatchObject({ kind: "agent", agent: { token: "ChatGPT-User", purpose: "user" } });
    expect(agentOf("GPTBot/1.4", "")).toMatchObject({ kind: "claimed", agent: { token: "GPTBot" } });
    expect(agentOf("meta-webindexer/1.1", "AI Assistant")).toMatchObject({ kind: "agent", agent: { purpose: "search" } });
    expect(agentOf("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36", "AI Assistant")).toEqual({ kind: "signed-assistant" });
    expect(agentOf("KeenableBot/1.0", "Search Engine Crawler")).toEqual({ kind: "other", category: "Search Engine Crawler" });
    expect(agentOf("curl/8.14.1", "AI Assistant")).toEqual({ kind: "other", category: "AI Assistant" });
    expect(agentOf("Mozilla/5.0 Chrome/142.0", "")).toEqual({ kind: "unknown" });
  });

  it("gives each sending agent's token in the table's form and lowercase, for case-sensitive filters", async () => {
    const { tokenForms } = await import("../../src/checks/agents.js");
    expect(tokenForms()).toEqual(expect.arrayContaining(["Bingbot", "bingbot", "GPTBot", "gptbot", "ChatGPT-User", "chatgpt-user"]));
    expect(tokenForms()).not.toContain("Google-Extended");
    expect(tokenForms("user")).toEqual(expect.arrayContaining(["ChatGPT-User", "chatgpt-user"]));
    expect(tokenForms("user")).not.toContain("GPTBot");
  });

  it("builds the stop-training lines from the table only", () => {
    const lines = stopTrainingLines();
    expect(lines).toContain("User-agent: GPTBot");
    expect(lines).toContain("User-agent: Google-Extended");
    expect(lines).not.toContain("User-agent: OAI-SearchBot");
    expect(lines).not.toContain("User-agent: ChatGPT-User");
  });

  it("treats a recipe change as a new scheme, never an edit", () => {
    expect(sameRecipe("c1:aaa", "c1:bbb")).toBe(true);
    expect(sameRecipe("robots:aaa", `${ROBOTS_FINGERPRINT}bbb`)).toBe(false);
    expect(sameRecipe(`${ROBOTS_FINGERPRINT}a`, `${ROBOTS_FINGERPRINT}b`)).toBe(true);
    expect(sameRecipe(null, "c1:a")).toBe(false);
  });
});
