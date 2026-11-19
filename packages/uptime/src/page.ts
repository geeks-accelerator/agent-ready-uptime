import { linePaths, msAxis } from "@geeks-accelerator/agent-ready-checks/chart";
import { ms } from "@geeks-accelerator/agent-ready-checks/format";
import { html, raw, safeHref, type Raw } from "@geeks-accelerator/agent-ready-checks/html/template";
import { daysUntil } from "@geeks-accelerator/agent-ready-checks/rules";
import type { Config, Site } from "./config.js";
import { HISTORY_MS, type HistoryPoint, type State, type TargetState } from "./state.js";
import type { Target } from "./targets.js";

/**
 * The status page: one plain page from the state file. Server-drawn, complete without
 * script; a few lines of script fetch it again every 30 seconds and swap the parts
 * marked data-live. Every word a site sent (titles, tool names, errors) goes through
 * the escaping template.
 */
export const TITLE = "agent-ready uptime monitoring";
const BUCKET_MS = 5 * 60_000;
const W = 600;
const H = 120;

export function renderPage(config: Config, state: State, targets: Target[], now = Date.now()): string {
  const sites = config.sites.map((s) => siteCard(s, state, targets.filter((t) => t.site === s.slug), now));
  const down = config.sites.filter((s) => state.targets[`${s.slug}:home`]?.ok === false).length;
  const title = down ? `${down} down · ${TITLE}` : TITLE;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${html`${title}`}</title>
<style>${raw(CSS)}</style>
<script src="/page.js" defer></script>
</head>
<body>
<main>
  <header><h1>${html`${TITLE}`}</h1><p class="muted" data-live="updated">Updated ${new Date(now).toISOString().slice(11, 19)} UTC · ${config.sites.length} site${config.sites.length === 1 ? "" : "s"}</p></header>
  ${html`${sites}`}
</main>
<footer><p>Want history beyond 24 hours, a second location that confirms an outage before it alerts, journeys and a team dashboard? <a href="https://sitesinthewoods.com">Sites in the Woods →</a></p></footer>
</body>
</html>
`;
}

function siteCard(site: Site, state: State, targets: Target[], now: number): Raw {
  const home = state.targets[`${site.slug}:home`];
  const domain = state.targets[`${site.slug}:domain`];
  const status = site.paused ? "paused" : home?.ok === false ? "down" : home?.ok ? "up" : "waiting";
  const words = { up: "Up", down: "Down", waiting: "First check soon", paused: "Paused" }[status];
  const others = targets.filter((t) => t.kind !== "homepage" && t.kind !== "domain");
  return html`<section class="site" data-live="site-${site.slug}" data-state="${status}">
    <div class="head">
      <h2><span class="dot ${status}" aria-hidden="true"></span>${site.name}</h2>
      <a class="muted" href="${safeHref(site.url)}">${site.url.replace(/^https?:\/\//, "")}</a>
    </div>
    <p class="status ${status}"><strong>${words}</strong>${home?.since ? html` <span class="muted">since ${stamp(home.since)}</span>` : ""}${home?.ok === false && home.detail ? html` · ${home.detail}` : ""}</p>
    <dl class="facts">
      <div><dt>First byte</dt><dd>${home?.ok ? ms(home.ttfbMs) : "–"}</dd></div>
      <div><dt>TLS certificate</dt><dd>${daysLeft(home?.expiresAt, now)}</dd></div>
      <div><dt>Domain</dt><dd>${daysLeft(domain?.expiresAt, now)}</dd></div>
    </dl>
    ${graph(state.history[site.slug] ?? [], now)}
    ${others.length ? html`<ul class="checks">${others.filter((t) => !isProbe(t)).map((t) => checkRow(t, state.targets[t.key]))}${crawlerRow(others.filter(isProbe), state)}</ul>` : ""}
  </section>`;
}

function checkRow(t: Target, s: TargetState | undefined): Raw {
  const st = s?.ok === false ? "down" : s?.ok ? "up" : "waiting";
  const extra = t.spec?.kind === "mcp" && s?.count !== undefined ? html` · ${s.count} tool${s.count === 1 ? "" : "s"}${s.changedAt ? html`, changed ${stamp(s.changedAt)}` : ""}` : t.kind === "sitemap" && s?.count !== undefined ? html` · ${s.count.toLocaleString("en-US")} URLs` : "";
  return html`<li data-key="${t.key}" data-state="${st}"><span class="dot ${st}" aria-hidden="true"></span><span>${t.label}${extra}${s?.ok === false && s.detail ? html`<span class="muted"> · ${s.detail}</span>` : ""}</span></li>`;
}

const isProbe = (t: Target) => t.kind === "agent" && t.key.includes(":agent:crawler:");

/** The crawler probes in one row: how many get in, and which are turned away. */
function crawlerRow(probes: Target[], state: State): Raw {
  if (!probes.length) return html``;
  const away = probes.filter((t) => state.targets[t.key]?.ok === false);
  const st = away.length ? "down" : probes.some((t) => state.targets[t.key]?.ok) ? "up" : "waiting";
  return html`<li data-key="crawlers" data-state="${st}"><span class="dot ${st}" aria-hidden="true"></span><span>AI crawlers · ${away.length ? html`${away.length} of ${probes.length} turned away<span class="muted">: ${away.map((t) => t.label).join(", ")}</span>` : `${probes.length} checks, all get in`}</span></li>`;
}

/** The last 24 hours of first-byte times, in 5-minute buckets: from zero, gaps drawn as gaps, with its axis labelled. */
export function graph(points: HistoryPoint[], now: number): Raw {
  const start = now - HISTORY_MS;
  const n = HISTORY_MS / BUCKET_MS;
  const sums = new Array<number>(n).fill(0);
  const counts = new Array<number>(n).fill(0);
  for (const [at, v] of points) {
    const i = Math.floor((at - start) / BUCKET_MS);
    if (i < 0 || i >= n || v === null) continue;
    sums[i]! += v;
    counts[i]! += 1;
  }
  const vals = sums.map((s, i) => (counts[i] ? s / counts[i]! : null));
  const axis = msAxis(vals);
  const p = linePaths(vals, W, H, { yMax: axis.yMax });
  if (!p) return html`<p class="graph-empty muted">The 24-hour graph fills in as checks come in.</p>`;
  const top = (v: number) => (((H - 2 - (v / axis.yMax) * (H - 4)) / H) * 100).toFixed(1);
  return html`<figure class="graph">
    <div class="ticks" aria-hidden="true">${axis.ticks.map((t) => html`<span style="top:${top(t.v)}%">${t.text}</span>`)}</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="First byte over the last 24 hours"><path d="${p.area}" class="area"/><path d="${p.line}" class="line"/></svg>
    <figcaption class="muted"><span>24 hours ago</span><span>now</span></figcaption>
  </figure>`;
}

function daysLeft(iso: string | null | undefined, now: number): string {
  if (!iso) return "–";
  const d = Math.floor(daysUntil(iso, now));
  return d < 0 ? "expired" : `${d} day${d === 1 ? "" : "s"} left`;
}

function stamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Fetch the page again every 30 s and swap its live parts; paused while the tab is hidden, one request at a time. */
export const PAGE_JS = `(() => {
  let busy = false;
  const tick = async () => {
    if (document.hidden || busy) return;
    busy = true;
    try {
      const res = await fetch(location.href, { headers: { accept: "text/html" } });
      if (!res.ok) throw new Error(String(res.status));
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      for (const el of document.querySelectorAll("[data-live]")) {
        const next = doc.querySelector('[data-live="' + el.dataset.live + '"]');
        if (next) el.replaceWith(next);
      }
      document.title = doc.title;
      document.documentElement.classList.remove("stale");
    } catch {
      document.documentElement.classList.add("stale");
    } finally {
      busy = false;
    }
  };
  setInterval(tick, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
})();
`;

const CSS = `
:root { color-scheme: light dark;
  --bg: light-dark(#f6f6f2, #121211); --panel: light-dark(#ffffff, #1b1b19); --text: light-dark(#1d1c19, #ecebe6);
  --muted: light-dark(#5f5d56, #a6a49c); --line: light-dark(#e2e1da, #31312d); --up: light-dark(#08765a, #4fd8ac);
  --warn: light-dark(#8f5d00, #f2c94c); --down: light-dark(#c4302b, #ff7b72); --accent: light-dark(#2453c7, #8ab4f8); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main, footer { max-width: 760px; margin: 0 auto; padding: 24px 16px; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; } h2 { font-size: 17px; margin: 0; display: flex; align-items: center; gap: 8px; }
.muted { color: var(--muted); }
.stale [data-live="updated"] { color: var(--warn); }
header { margin-bottom: 16px; } header p { margin: 4px 0 0; font-size: 13px; }
.site { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.head a { font-size: 13px; overflow-wrap: anywhere; }
.status { margin: 8px 0; } .status.down strong { color: var(--down); } .status.up strong { color: var(--up); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); flex: none; display: inline-block; }
.dot.up { background: var(--up); } .dot.down { background: var(--down); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin: 12px 0; }
.facts dt { font-size: 12px; color: var(--muted); } .facts dd { margin: 0; font-variant-numeric: tabular-nums; }
.graph { position: relative; margin: 12px 0 0; padding-left: 52px; }
.graph svg { display: block; width: 100%; height: 120px; overflow: visible; }
.graph .line { fill: none; stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.graph .area { fill: color-mix(in oklab, var(--accent) 14%, transparent); }
.ticks { position: absolute; left: 0; top: 0; width: 48px; height: 120px; font-size: 11px; color: var(--muted); }
.ticks span { position: absolute; right: 0; transform: translateY(-50%); font-variant-numeric: tabular-nums; }
.graph figcaption { display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px; }
.graph-empty { font-size: 13px; }
.checks { list-style: none; padding: 0; margin: 12px 0 0; border-top: 1px solid var(--line); }
.checks li { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 14px; overflow-wrap: anywhere; }
.checks li .dot { transform: translateY(1px); }
footer { font-size: 13px; color: var(--muted); padding-top: 0; }
`;
