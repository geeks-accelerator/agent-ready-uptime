import { ms } from "./format.js";

export function gapLimitOf(vals: Array<number | null>): number {
  const idx: number[] = [];
  vals.forEach((v, i) => v !== null && idx.push(i));
  const diffs = idx.slice(1).map((v, i) => v - idx[i]!).sort((a, b) => a - b);
  const median = diffs.length ? diffs[Math.floor(diffs.length / 2)]! : 1;
  return Math.max(2, Math.ceil(median * 2.5));
}

/**
 * Path data for any series of values (null = no data) in a W×H box: the
 * sparkline geometry, for lines that aren't TTFB (visits per hour). Scaled to
 * its own peak unless `yMax` is given; the last point is dashed when it's
 * still in progress.
 */
export function linePaths(vals: Array<number | null>, W: number, H: number, opts: { yMax?: number; lastInProgress?: boolean } = {}): { line: string; area: string; dashed: string } | null {
  const real = vals.filter((v): v is number => v !== null);
  if (real.length < 2) return null;
  // Scaled to the line's own peak (sparklines) or to a fixed axis (charts with ticks); points above it clip.
  const max = opts.yMax ?? Math.max(...real) * 1.1;
  const x = (i: number) => ((i / Math.max(vals.length - 1, 1)) * W).toFixed(1);
  const y = (v: number) => Math.max(0, H - 2 - (Math.min(v, max) / (max || 1)) * (H - 4)).toFixed(1);
  const limit = gapLimitOf(vals);
  const last = vals.length - 1;
  const tail = !!opts.lastInProgress && vals[last] !== null;
  let line = "";
  let area = "";
  let run: string[] = [];
  let lastI = -1;
  const flush = () => {
    if (run.length > 1) {
      line += `M${run.join("L")}`;
      area += `M${run[0]!.split(",")[0]},${H}L${run.join("L")}L${run[run.length - 1]!.split(",")[0]},${H}Z`;
    } else if (run.length === 1) line += `M${run[0]}h0.1`;
    run = [];
  };
  let dashed = "";
  vals.forEach((v, i) => {
    if (v === null) return;
    if (tail && i === last) {
      if (lastI >= 0 && i - lastI <= limit) dashed = `M${x(lastI)},${y(vals[lastI]!)}L${x(i)},${y(v)}`;
      return;
    }
    if (lastI >= 0 && i - lastI > limit) flush();
    run.push(`${x(i)},${y(v)}`);
    lastI = i;
  });
  flush();
  return { line, area, dashed };
}

/** Steps whose multiples make round labels at any rounding (no 375 ms or 3.75 s gridlines). */
export const TICK_STEPS = [25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 25_000, 50_000];

/** The same, from 1, for counts (pages, visits). */
export const COUNT_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 25_000, 50_000, 100_000];

export interface Axis {
  yMin: number;
  yMax: number;
  ticks: Array<{ v: number; text: string }>;
}

/**
 * Round ticks, at most 4 steps. `fromZero`: the axis starts at zero, so a point's height is its
 * value (bars, response times), and the top follows the 98th percentile so one odd spike doesn't
 * flatten the rest (taller points clip). Otherwise the axis fits the values' range (a line of
 * pages listed, where a 3% drop would be invisible from zero); the labels show where it starts.
 */
export function niceAxis(values: Array<number | null>, o: { format: (v: number) => string; steps: number[]; fromZero: boolean; reachAtLeast?: number; atLeast?: number }): Axis {
  const real = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const p98 = real.length ? real.at(Math.min(real.length - 1, Math.floor(real.length * 0.98)))! : 0;
  // From zero: 5% headroom over the top. Fitted: 5% of the range at each end (5% of 7,000 pages would bury a 300-page drop).
  const hi = o.fromZero ? Math.max(o.reachAtLeast ?? 0, o.atLeast ?? 0, Math.min(real.at(-1) ?? 0, p98 * 1.6)) : Math.max(real.at(-1) ?? 0, o.atLeast ?? 0);
  const lo = o.fromZero ? 0 : (real[0] ?? 0);
  const pad = o.fromZero ? hi * 0.05 : Math.max(1, (hi - lo) * 0.05);
  const top = hi + pad;
  const bottom = o.fromZero ? 0 : Math.max(0, lo - pad);
  const fallback = o.steps.at(-1)! * 2;
  const step = o.steps.find((s) => Math.ceil(top / s) - Math.floor(bottom / s) <= 4) ?? fallback;
  const yMin = step * Math.floor(bottom / step);
  const yMax = Math.max(step * Math.ceil(top / step), yMin + step);
  const ticks: Array<{ v: number; text: string }> = [];
  for (let v = yMin; v <= yMax; v += step) ticks.push({ v, text: o.format(v) });
  return { yMin, yMax, ticks };
}

/**
 * A millisecond axis from zero, so a point's height is its value. The scale
 * follows the 98th percentile so one odd spike doesn't flatten the rest
 * (taller points clip at the top). `atLeast` keeps a reference line, such as
 * a threshold, on the chart.
 */
export function msAxis(values: Array<number | null>, atLeast = 0): { yMax: number; ticks: Array<{ v: number; text: string }> } {
  const { yMax, ticks } = niceAxis(values, { format: ms, steps: TICK_STEPS, fromZero: true, reachAtLeast: 100, atLeast });
  return { yMax, ticks };
}
