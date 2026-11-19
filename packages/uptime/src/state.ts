import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTargetSpec } from "agent-ready-checks/agent/discover";
import { NO_STREAK, type FailureStreak } from "agent-ready-checks/rules";

/**
 * Everything the runner remembers, in one JSON file: so a restart doesn't alert again,
 * forget an MCP server's tools, or lose the status page's graph. Written whole, through
 * a temporary file and a rename, so a crash never leaves half a file.
 */
export interface TargetState {
  /** null until the first check. */
  ok: boolean | null;
  /** When it last changed between ok and failing. */
  since: string | null;
  checkedAt: string | null;
  streak: FailureStreak;
  /** Whether a "down" (or failing) alert went out and its recovery hasn't yet. */
  alerted: boolean;
  error: string | null;
  detail: string | null;
  ttfbMs: number | null;
  /** MCP tools or DNS records, to say what changed. */
  fingerprint?: string;
  fingerprintData?: unknown;
  /** When what it lists last changed. */
  changedAt?: string;
  /** A certificate or domain: when it expires, and the tightest threshold already announced. */
  expiresAt?: string | null;
  announcedBucket?: number | null;
  /** MCP: how many tools it lists. */
  count?: number;
}

export interface SiteDiscovery {
  at: string;
  agent: AgentTargetSpec[];
  sitemaps: string[];
}

/** One homepage check for the graph: [epoch ms, first byte in ms, or null when it failed]. */
export type HistoryPoint = [number, number | null];

export interface State {
  version: 1;
  targets: Record<string, TargetState>;
  discovered: Record<string, SiteDiscovery>;
  history: Record<string, HistoryPoint[]>;
}

export const HISTORY_MS = 24 * 3_600_000;

export function emptyState(): State {
  return { version: 1, targets: {}, discovered: {}, history: {} };
}

export function newTarget(): TargetState {
  return { ok: null, since: null, checkedAt: null, streak: NO_STREAK, alerted: false, error: null, detail: null, ttfbMs: null };
}

export async function readState(path: string): Promise<State> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return emptyState();
  }
  const s = JSON.parse(text) as Partial<State>;
  if (s.version !== 1) throw new Error(`${path}: not a state file this version reads`);
  return { ...emptyState(), ...s } as State;
}

export async function writeState(path: string, s: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s));
  await rename(tmp, path);
}

/** Add a homepage check to its graph and drop what's older than 24 hours. */
export function record(s: State, site: string, at: number, ttfbMs: number | null): void {
  const h = (s.history[site] ??= []);
  h.push([at, ttfbMs]);
  const cut = at - HISTORY_MS;
  let i = 0;
  while (i < h.length && h[i]![0] < cut) i++;
  if (i) h.splice(0, i);
}
