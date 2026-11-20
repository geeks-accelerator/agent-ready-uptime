import { appendFile } from "node:fs/promises";
import type { Runner } from "./runner.js";

/** One check's result after a `check` pass. */
export interface CheckRow {
  site: string;
  check: string;
  url: string;
  /** null: it didn't run (nothing to check yet). */
  ok: boolean | null;
  why: string | null;
}

/** Past this many rows the run summary is cut, with a count (GitHub allows 1 MiB per step). */
export const SUMMARY_ROWS = 100;

/** Every check's result, failures first. */
export function checkRows(runner: Runner): CheckRow[] {
  const names = new Map(runner.config.sites.map((s) => [s.slug, s.name]));
  const rows = [...runner.targets.values()].map((t) => {
    const s = runner.state.targets[t.key];
    return { site: names.get(t.site) ?? t.site, check: t.label, url: t.url, ok: s?.ok ?? null, why: s?.ok === false ? (s.detail ?? s.error ?? "failed") : null };
  });
  return [...rows.filter((r) => r.ok === false), ...rows.filter((r) => r.ok !== false)];
}

/** For people: each failure on its line with why, then one line for the rest. */
export function textReport(rows: CheckRow[]): string {
  const failed = rows.filter((r) => r.ok === false);
  const passed = rows.filter((r) => r.ok === true).length;
  const lines = failed.map((r) => `✗ ${r.site} · ${r.check}: ${r.why}\n  ${r.url}`);
  lines.push(failed.length ? `${failed.length} failing, ${passed} passed.` : `All ${passed} checks passed.`);
  return `${lines.join("\n")}\n`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The run's summary on GitHub (Markdown): failures first, cut past SUMMARY_ROWS with a count. */
export function githubSummary(rows: CheckRow[]): string {
  const failed = rows.filter((r) => r.ok === false).length;
  const head = failed ? `### agent-ready-uptime: ${failed} failing` : "### agent-ready-uptime: all checks passed";
  const shown = rows.slice(0, SUMMARY_ROWS);
  const table = ["| Site | Check | Result | Why |", "|---|---|---|---|", ...shown.map((r) => `| ${cell(r.site)} | [${cell(r.check)}](${r.url}) | ${r.ok === false ? "❌ failing" : r.ok ? "✅ passed" : "not checked"} | ${cell(r.why ?? "")} |`)];
  if (rows.length > shown.length) table.push("", `${rows.length - shown.length} more not shown.`);
  return `${head}\n\n${table.join("\n")}\n`;
}

/** GitHub workflow commands escape these in a message and, with `:` and `,`, in a property. */
const escData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s: string) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** One `::error` annotation per failure, so it shows on the run's page. */
export function githubAnnotations(rows: CheckRow[]): string {
  return rows.filter((r) => r.ok === false).map((r) => `::error title=${escProp(`${r.site} · ${r.check}`)}::${escData(`${r.why} (${r.url})`)}\n`).join("");
}

/** After a `check` pass: the text report on stderr; in GitHub Actions, the run summary and annotations too. */
export async function report(runner: Runner, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rows = checkRows(runner);
  process.stderr.write(textReport(rows));
  if (env.GITHUB_ACTIONS !== "true") return;
  process.stdout.write(githubAnnotations(rows));
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, githubSummary(rows));
}
