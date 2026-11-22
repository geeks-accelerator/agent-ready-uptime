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

/** "7 minutes", "2 hours 5 minutes", "3 days 4 hours": how long something lasted. */
export function lasted(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (m < 60) return unit(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${unit(h, "hour")} ${unit(m % 60, "minute")}` : unit(h, "hour");
  const d = Math.floor(h / 24);
  return h % 24 ? `${unit(d, "day")} ${unit(h % 24, "hour")}` : unit(d, "day");
}
