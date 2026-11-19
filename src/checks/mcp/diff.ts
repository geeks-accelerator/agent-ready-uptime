import type { McpTool } from "./check.js";

/** What changed between two MCP tool lists, in one line for an alert ("" when nothing did). */
export function describeToolChange(before: unknown, after: unknown): string {
  const list = (v: unknown): McpTool[] => (Array.isArray(v) ? (v as McpTool[]).filter((t) => t && typeof t.name === "string") : []);
  const a = new Map(list(before).map((t) => [t.name, t.schema]));
  const b = new Map(list(after).map((t) => [t.name, t.schema]));
  const removed = [...a.keys()].filter((n) => !b.has(n));
  const added = [...b.keys()].filter((n) => !a.has(n));
  const changed = [...a.keys()].filter((n) => b.has(n) && a.get(n) !== b.get(n));
  const part = (label: string, names: string[]) => (names.length ? `${label} ${names.map((n) => `\`${n}\``).join(", ")}` : null);
  return [part("removed", removed), part("added", added), part("schema changed:", changed)].filter(Boolean).join("; ");
}
