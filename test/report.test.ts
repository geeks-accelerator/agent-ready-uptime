import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { githubAnnotations, githubSummary, SUMMARY_ROWS, textReport, type CheckRow } from "../src/report.js";
import { testServer } from "../src/checks/testing/servers.js";

const row = (o: Partial<CheckRow>): CheckRow => ({ site: "Ex", check: "Homepage", url: "https://ex.test/", ok: true, why: null, ...o });

describe("check's report", () => {
  it("lists failures first with why, then one line for the rest", () => {
    const text = textReport([row({ ok: false, why: "HTTP 503" }), row({ check: "llms.txt" })]);
    expect(text).toBe("✗ Ex · Homepage: HTTP 503\n  https://ex.test/\n1 failing, 1 passed.\n");
    expect(textReport([row({})])).toBe("All 1 checks passed.\n");
  });

  it("writes GitHub's run summary, cut with a count past the limit", () => {
    const md = githubSummary([row({ ok: false, why: "a | b" }), ...Array.from({ length: SUMMARY_ROWS + 5 }, () => row({}))]);
    expect(md).toContain("### agent-ready-uptime: 1 failing");
    expect(md).toContain("| Ex | [Homepage](https://ex.test/) | ❌ failing | a \\| b |");
    expect(md).toContain("6 more not shown.");
  });

  it("escapes annotations as GitHub's workflow commands need", () => {
    expect(githubAnnotations([row({ ok: false, site: "A, B: c", why: "50% down\nreally" }), row({})])).toBe("::error title=A%2C B%3A c · Homepage::50%25 down%0Areally (https://ex.test/)\n");
  });
});

describe("check in GitHub Actions", () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aru-report-"));
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("appends the summary and prints an annotation per failure", async () => {
    const site = await testServer({ "/": { status: 503, body: "down" } });
    const cfg = join(dir, "monitor.config.json");
    await writeFile(cfg, JSON.stringify({ sites: [{ slug: "ex", name: "Ex", url: site.url, sitemaps: false, agent: false }] }));
    const summary = join(dir, "summary.md");
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_STEP_SUMMARY = summary;
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run(["check", "--config", cfg, "--state", join(dir, "s.json")])).toBe(1);
    } finally {
      await site.close();
    }
    expect(await readFile(summary, "utf8")).toContain("### agent-ready-uptime: 1 failing");
    expect(out.join("")).toMatch(/^::error title=Ex · /m);
  });
});
