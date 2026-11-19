import { discoverAgentFiles } from "agent-ready-checks/agent/discover";
import { lookupDomain } from "agent-ready-checks/domain/rdap";
import { discoverSitemaps, fetchSitemap } from "agent-ready-checks/sitemap/fetch";
import { DEFAULT_CHECKERS, runSpec, type Checkers } from "agent-ready-checks/spec";
import { siteUrl } from "agent-ready-checks/url";
import type { Sender } from "./alerts.js";
import type { Config, Site } from "./config.js";
import { judge, type Alert, type Outcome } from "./judge.js";
import { newTarget, readState, record, writeState, type State } from "./state.js";
import { agentTarget, excluded, siteTargets, sitemapTarget, type Target } from "./targets.js";

/** The checks package's functions the runner calls, replaceable in tests. */
export interface Deps {
  checkers: Checkers;
  discoverAgentFiles: typeof discoverAgentFiles;
  discoverSitemaps: typeof discoverSitemaps;
  fetchSitemap: typeof fetchSitemap;
  lookupDomain: typeof lookupDomain;
  now: () => number;
}

export const DEFAULT_DEPS: Deps = { checkers: DEFAULT_CHECKERS, discoverAgentFiles, discoverSitemaps, fetchSitemap, lookupDomain, now: Date.now };

/** Discovery again after this: a new file or sitemap is picked up; one we watch that goes away fails, never silently drops. */
const DISCOVERY_MS = 6 * 3_600_000;
/** Checks at once (one target never overlaps itself). */
const CONCURRENCY = 4;

export interface RunnerOptions {
  statePath: string;
  send: Sender;
  /** One JSON line per check and per alert (stdout by default). */
  out?: (line: string) => void;
  deps?: Partial<Deps>;
}

export class Runner {
  state: State;
  readonly targets = new Map<string, Target>();
  private readonly next = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly deps: Deps;
  private readonly out: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  private constructor(readonly config: Config, state: State, private readonly o: RunnerOptions) {
    this.state = state;
    this.deps = { ...DEFAULT_DEPS, ...o.deps };
    this.out = o.out ?? ((l) => process.stdout.write(`${l}\n`));
  }

  static async open(config: Config, o: RunnerOptions): Promise<Runner> {
    const r = new Runner(config, await readState(o.statePath), o);
    for (const site of config.sites) for (const t of siteTargets(site, config.defaults)) r.add(t);
    // What earlier runs discovered is watched from the start, before discovery runs again.
    for (const site of config.sites) r.addDiscovered(site);
    return r;
  }

  siteName(slug: string): string {
    return this.config.sites.find((s) => s.slug === slug)?.name ?? slug;
  }

  /** Find each site's sitemaps, agent files, MCP server and crawler probes (unless switched off), keeping what was found before. */
  async discover(force = false): Promise<void> {
    const now = this.deps.now();
    for (const site of this.config.sites) {
      if (site.paused) continue;
      const before = this.state.discovered[site.slug];
      if (!force && before && now - Date.parse(before.at) < DISCOVERY_MS) continue;
      const found = { at: new Date(now).toISOString(), agent: [...(before?.agent ?? [])], sitemaps: [...(before?.sitemaps ?? [])] };
      const d = this.config.defaults;
      if (site.sitemaps !== false) {
        const s = site.sitemaps ?? {};
        const listed = s.urls?.length
          ? s.urls.map((u) => siteUrl(site.url, u))
          : (await this.deps.discoverSitemaps(site.url, { timeoutMs: s.timeoutMs ?? d.sitemapTimeoutMs, probeJson: s.probeJson !== false }).catch(() => ({ urls: [] as string[] }))).urls;
        const skip = new Set((s.exclude ?? []).map((u) => siteUrl(site.url, u)));
        for (const u of listed) if (!skip.has(u) && !found.sitemaps.includes(u)) found.sitemaps.push(u);
      }
      if (site.agent !== false) {
        const a = typeof site.agent === "object" ? site.agent : {};
        const r = await this.deps
          .discoverAgentFiles(site.url, {
            timeoutMs: a.timeoutMs ?? d.timeoutMs,
            ...(a.paths ? { paths: Object.fromEntries(Object.entries(a.paths).map(([k, v]) => [k, siteUrl(site.url, v!)])) } : {}),
            ...(a.mcp ? { mcp: siteUrl(site.url, a.mcp) } : {}),
            ...(a.crawlers ? { crawlers: a.crawlers } : {}),
          })
          .catch(() => ({ targets: [] }));
        for (const t of r.targets) if (!found.agent.some((x) => x.url === t.url && x.source === t.source)) found.agent.push(t);
      }
      this.state.discovered[site.slug] = found;
      this.addDiscovered(site);
    }
    await this.save();
  }

  /** Run every target once, now (`check` mode, and the first pass of `watch`). Resolves with the alerts sent. */
  async checkAll(): Promise<Alert[]> {
    const alerts: Alert[] = [];
    const queue = [...this.targets.values()];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) alerts.push(...(await this.run(t)));
    }));
    return alerts;
  }

  /** Check what's due every second, and discover again every 6 hours. */
  watch(): void {
    const tick = () => {
      const now = this.deps.now();
      for (const [key, at] of this.next) {
        if (at > now || this.running.has(key) || this.running.size >= CONCURRENCY) continue;
        const t = this.targets.get(key);
        if (t) void this.run(t);
      }
      const oldest = Math.min(...this.config.sites.map((s) => Date.parse(this.state.discovered[s.slug]?.at ?? "1970-01-01")));
      if (now - oldest >= DISCOVERY_MS && !this.running.has("discover")) {
        this.running.add("discover");
        void this.discover().finally(() => this.running.delete("discover"));
      }
    };
    this.timer = setInterval(tick, 1000);
    tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.saving;
  }

  /** Whether anything is failing now (`check` mode's exit code). */
  failing(): Target[] {
    return [...this.targets.values()].filter((t) => this.state.targets[t.key]?.ok === false);
  }

  private add(t: Target): void {
    if (this.targets.has(t.key)) return;
    this.targets.set(t.key, t);
    const s = this.state.targets[t.key];
    // Due now, unless it was checked recently (a restart picks up where it left off).
    const last = s?.checkedAt ? Date.parse(s.checkedAt) : 0;
    this.next.set(t.key, Math.max(this.deps.now(), last + t.intervalS * 1000));
  }

  private addDiscovered(site: Site): void {
    const d = this.state.discovered[site.slug];
    if (!d || site.paused) return;
    for (const u of d.sitemaps) this.add(sitemapTarget(site, u, this.config.defaults));
    for (const a of d.agent) if (!excluded(site, a)) this.add(agentTarget(site, a, this.config.defaults));
  }

  private async run(t: Target): Promise<Alert[]> {
    this.running.add(t.key);
    try {
      const o = await this.outcome(t);
      const before = this.state.targets[t.key] ?? newTarget();
      let { state, alerts } = judge(t, before, o, this.siteName(t.site));
      // While the site's homepage is failing, its other checks fail because it does: recorded, never alerted on their own.
      if (!o.ok && t.kind !== "homepage" && this.state.targets[`${t.site}:home`]?.ok === false) {
        state = { ...state, streak: before.streak, alerted: before.alerted };
        alerts = [];
      }
      this.state.targets[t.key] = state;
      if (t.kind === "homepage") record(this.state, t.site, Date.parse(o.checkedAt), o.ok ? o.ttfbMs : null);
      // A failure is checked again sooner (the homepage: after 1 minute, then 5), until it's news.
      const retry = !o.ok && !state.alerted ? t.retriesS[state.streak.failures - 1] : undefined;
      this.next.set(t.key, Date.parse(o.checkedAt) + (retry ?? t.intervalS) * 1000);
      this.out(JSON.stringify({ t: o.checkedAt, site: t.site, check: t.label, url: t.url, ok: o.ok, ...(o.ttfbMs !== null ? { ttfbMs: Math.round(o.ttfbMs) } : {}), ...(o.ok ? {} : { error: o.error, detail: o.detail }) }));
      for (const a of alerts) {
        this.out(JSON.stringify({ t: a.at, alert: a.kind, site: a.site, title: a.title, ...(a.detail ? { detail: a.detail } : {}) }));
        await this.o.send(a);
      }
      await this.save();
      return alerts;
    } finally {
      this.running.delete(t.key);
    }
  }

  private async outcome(t: Target): Promise<Outcome> {
    const checkedAt = () => new Date(this.deps.now()).toISOString();
    if (t.kind === "sitemap") {
      const r = await this.deps.fetchSitemap(t.url, { timeoutMs: t.timeoutMs });
      const few = r.ok && r.entries.length < (t.minUrls ?? 1);
      return { ok: r.ok && !few, checkedAt: checkedAt(), error: few ? "too_few_urls" : r.error, detail: few ? `lists ${r.entries.length} URLs, fewer than ${t.minUrls}` : r.errorDetail, ttfbMs: r.check.timings.ttfbMs, count: r.entries.length };
    }
    if (t.kind === "domain") {
      const r = await this.deps.lookupDomain(t.url);
      return { ok: r.ok, checkedAt: checkedAt(), error: r.error, detail: r.ok ? null : `RDAP lookup failed: ${r.error}`, ttfbMs: null, expiresAt: r.expiresAt };
    }
    const r = await runSpec(t.spec!, this.deps.checkers);
    return {
      ok: r.ok,
      checkedAt: r.checkedAt,
      error: r.error,
      detail: r.errorDetail,
      ttfbMs: r.timings.ttfbMs,
      ...(r.fingerprint ? { fingerprint: r.fingerprint, fingerprintData: r.fingerprintData } : {}),
      ...(t.kind === "homepage" && t.url.startsWith("https:") && r.ok ? { expiresAt: r.tls?.validTo ?? null } : {}),
      ...(t.spec?.kind === "mcp" && Array.isArray(r.fingerprintData) ? { count: r.fingerprintData.length } : {}),
    };
  }

  /** Saves one at a time, in order. */
  private save(): Promise<void> {
    this.saving = this.saving.then(() => writeState(this.o.statePath, this.state)).catch((e) => this.out(JSON.stringify({ error: `state not saved: ${(e as Error).message}` })));
    return this.saving;
  }
}
