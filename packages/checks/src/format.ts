/**
 * A response time for reading: two significant figures under a second
 * (199 → 200 ms, 87 → 87 ms), seconds with one decimal above (1,234 → 1.2 s).
 * `exact` (check rows, where the milliseconds are the evidence): as measured.
 */
export function ms(v: number | null | undefined, opts: { exact?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  if (opts.exact) return `${Math.round(v).toLocaleString("en-US")} ms`;
  const r = v >= 100 ? Math.round(v / 10) * 10 : Math.round(v);
  if (r < 1000) return `${r} ms`;
  return `${v >= 9_950 ? Math.round(v / 1000) : (Math.round(v / 100) / 10).toFixed(1)} s`;
}
