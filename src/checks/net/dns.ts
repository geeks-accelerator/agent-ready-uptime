import { createHash } from "node:crypto";
import { promises as dnsp } from "node:dns";
import net from "node:net";
import { syntheticResult, type PageCheckResult } from "../http/page-check.js";
import { isPrivateAddress, privateAllowedFor } from "../http/request.js";
import { canonicalJson, FINGERPRINT_VERSION } from "../mcp/check.js";

/**
 * DNS record checks:
 * ask the zone's own authoritative nameservers, not a public resolver (which caches),
 * so an answer is current and a server that disagrees with the others is named.
 */
export const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "NS"] as const;
export type DnsType = (typeof DNS_TYPES)[number];

/** Types whose changes are announced by default. A and AAAA rotate on their own behind CDNs (Cloudflare), so they aren't. */
export const NOTIFY_CHANGES_BY_DEFAULT: ReadonlySet<DnsType> = new Set(["CNAME", "MX", "TXT", "CAA", "NS"]);

export interface DnsCheckOptions {
  timeoutMs?: number;
  /** Values that must be among the records (case and a trailing dot ignored). */
  expect?: string[];
}

/** How the check reaches DNS; tests replace it with stand-in servers. */
export interface DnsDeps {
  /** NS records of a name (system resolver). Throws with code ENODATA/ENOTFOUND when it has none. */
  nameservers(name: string): Promise<string[]>;
  /** Addresses of a nameserver's host (system resolver). */
  addresses(host: string): Promise<string[]>;
  /** Ask one server for one record type; answers normalised to strings. */
  query(server: string, name: string, type: DnsType, timeoutMs: number): Promise<string[]>;
}

/** Records as comparable strings: "10 mail.example.com", one TXT string per record, "0 issue letsencrypt.org". */
export function normalise(type: DnsType, raw: unknown[]): string[] {
  const out = raw.map((r): string => {
    if (type === "MX") {
      const m = r as { priority: number; exchange: string };
      return `${m.priority} ${m.exchange.toLowerCase().replace(/\.$/, "")}`;
    }
    if (type === "TXT") return (r as string[]).join("");
    if (type === "CAA") {
      const c = r as Record<string, unknown> & { critical: number };
      const tag = ["issue", "issuewild", "iodef", "contactemail", "contactphone"].find((k) => k in c) ?? "unknown";
      return `${c.critical} ${tag} ${String(c[tag] ?? "")}`;
    }
    return String(r).toLowerCase().replace(/\.$/, "");
  });
  return [...new Set(out)].sort();
}

export const DEFAULT_DNS: DnsDeps = {
  nameservers: (name) => dnsp.resolveNs(name),
  addresses: async (host) => {
    const [v4, v6] = await Promise.allSettled([dnsp.resolve4(host), dnsp.resolve6(host)]);
    return [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
  },
  query: async (server, name, type, timeoutMs) => {
    const r = new dnsp.Resolver({ timeout: timeoutMs, tries: 1 });
    r.setServers([server]);
    return normalise(type, (await r.resolve(name, type)) as unknown[]);
  },
};

/** The zone's nameservers: the name's own NS, else its parent's, up to the registered domain. */
async function zoneNameservers(name: string, deps: DnsDeps): Promise<string[]> {
  const labels = name.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    try {
      const ns = await deps.nameservers(labels.slice(i).join("."));
      if (ns.length) return ns.map((h) => h.toLowerCase().replace(/\.$/, ""));
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "ENODATA" && code !== "ENOTFOUND") throw e;
    }
  }
  return [];
}

const codeOf = (e: unknown) => (e as { code?: string }).code ?? "";
const what = (code: string) =>
  code === "ENOTFOUND" ? "the name doesn't exist (NXDOMAIN)" : code === "ENODATA" ? "no records" : code === "ESERVFAIL" ? "server failure (SERVFAIL)" : code === "ETIMEOUT" ? "no answer in time" : code === "ECONNREFUSED" ? "refused" : code || "error";

/** Check one name's records of one type: `dns://example.com/MX`. */
export async function checkDns(url: string, opts: DnsCheckOptions = {}, deps: DnsDeps = DEFAULT_DNS): Promise<PageCheckResult> {
  const checkedAt = new Date().toISOString();
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  let name: string;
  let type: DnsType;
  try {
    const u = new URL(url);
    name = u.hostname.toLowerCase().replace(/\.$/, "");
    type = u.pathname.slice(1).toUpperCase() as DnsType;
    if (u.protocol !== "dns:" || !name.includes(".") || !DNS_TYPES.includes(type)) throw new Error("bad");
  } catch {
    return syntheticResult(url, checkedAt, { ok: false, error: "invalid_url", errorDetail: `not a dns://name/TYPE address: ${url}` });
  }
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const label = `${type} for ${name}`;
  const fail = (error: string, detail: string) => syntheticResult(url, checkedAt, { ok: false, error, errorDetail: `${label}: ${detail}`, timings: { dnsMs: ms(), totalMs: ms() } });

  let servers: Array<{ host: string; ip: string }> = [];
  try {
    const allowPrivate = privateAllowedFor(url);
    for (const host of (await zoneNameservers(name, deps)).slice(0, 4)) {
      const ip = (await deps.addresses(host).catch(() => [] as string[])).find((a) => net.isIP(a) && (allowPrivate || !isPrivateAddress(a)));
      if (ip) servers.push({ host, ip });
    }
  } catch (e) {
    return fail("dns", `couldn't find the zone's nameservers (${what(codeOf(e))})`);
  }
  if (servers.length === 0) return fail("dns", "couldn't find the zone's nameservers");

  const answers = await Promise.all(
    servers.map(async (s) => {
      try {
        return { ...s, records: await deps.query(s.ip, name, type, timeoutMs), code: null as string | null };
      } catch (e) {
        return { ...s, records: null, code: codeOf(e) };
      }
    }),
  );
  const answered = answers.filter((a) => a.records !== null || a.code === "ENOTFOUND" || a.code === "ENODATA");
  if (answered.length === 0) return fail("dns", `no authoritative server answered (${answers.map((a) => `${a.host}: ${what(a.code ?? "")}`).join("; ")})`);

  // What most servers say; a server that says otherwise is named.
  const setOf = (a: (typeof answers)[number]) => (a.records ? JSON.stringify(a.records) : a.code!);
  const counts = new Map<string, number>();
  for (const a of answered) counts.set(setOf(a), (counts.get(setOf(a)) ?? 0) + 1);
  const majority = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  const odd = answered.find((a) => setOf(a) !== majority);
  const records = answered.find((a) => setOf(a) === majority)!.records;
  const show = (a: (typeof answers)[number]) => (a.records ? (a.records.length ? a.records.join(", ") : "nothing") : what(a.code!));
  if (odd) return fail("dns_disagree", `the nameservers disagree: ${odd.host} answers ${show(odd)}, the others ${records ? (records.length ? records.join(", ") : "nothing") : what(majority)}`);
  if (!records) return fail("dns", what(majority));
  if (records.length === 0) return fail("dns", "no records");

  const norm = (v: string) => v.trim().toLowerCase().replace(/\.$/, "");
  const missing = (opts.expect ?? []).filter((e) => !records.some((r) => norm(r) === norm(e)));
  if (missing.length) return fail("dns_unexpected", `expected ${missing.join(", ")}, found ${records.join(", ")}`);

  const data = { name, type, records };
  return syntheticResult(url, checkedAt, {
    ok: true,
    timings: { dnsMs: ms(), ttfbMs: ms(), totalMs: ms() },
    title: records.length === 1 ? records[0]! : `${records.length} records`,
    fingerprint: FINGERPRINT_VERSION + createHash("sha256").update(canonicalJson(data)).digest("hex"),
    fingerprintData: data,
  });
}

/** "MX for example.com: added 20 mx2.example.com; removed 10 old.example.com" from two fingerprints' data. */
export function describeRecordChange(before: unknown, after: unknown): string {
  const b = (before as { records?: string[] } | null)?.records ?? [];
  const a = after as { name?: string; type?: string; records?: string[] } | null;
  const now = a?.records ?? [];
  const added = now.filter((r) => !b.includes(r));
  const removed = b.filter((r) => !now.includes(r));
  const parts = [added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean);
  return `${a?.type ?? "records"} for ${a?.name ?? "the name"}: ${parts.join("; ") || "changed"}`;
}
