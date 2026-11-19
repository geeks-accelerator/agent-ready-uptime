import { fetchUrl } from "../http/request.js";

/**
 * Domain registration lookups via RDAP (the JSON successor to WHOIS).
 * The RDAP server for each TLD comes from IANA's bootstrap file.
 */

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 3_600_000;

let bootstrap: { at: number; services: Array<[string[], string[]]> } | null = null;

export interface RdapResult {
  domain: string;
  ok: boolean;
  error: string | null;
  expiresAt: string | null;
  registrar: string | null;
  nameservers: string[];
  statusFlags: string[];
}

/** RDAP statuses that mean the domain is (about to be) out of service. */
export const BAD_STATUSES = ["client hold", "server hold", "redemption period", "pending delete", "pending restore", "inactive"];

async function rdapBase(tld: string): Promise<string | null> {
  if (!bootstrap || Date.now() - bootstrap.at > BOOTSTRAP_TTL_MS) {
    const res = await fetchUrl(BOOTSTRAP_URL, { timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024, accept: "application/json" });
    if (res.error || res.statusCode !== 200) {
      if (!bootstrap) throw new Error(`RDAP bootstrap: ${res.error ?? `HTTP ${res.statusCode}`}`);
    } else {
      const json = JSON.parse(res.body.toString("utf8")) as { services: Array<[string[], string[]]> };
      bootstrap = { at: Date.now(), services: json.services };
    }
  }
  const entry = bootstrap!.services.find(([tlds]) => tlds.includes(tld.toLowerCase()));
  const base = entry?.[1].find((u) => u.startsWith("https://")) ?? entry?.[1][0];
  return base ? base.replace(/\/+$/, "") : null;
}

export async function lookupDomain(domain: string): Promise<RdapResult> {
  const result: RdapResult = { domain, ok: false, error: null, expiresAt: null, registrar: null, nameservers: [], statusFlags: [] };
  try {
    const tld = domain.split(".").pop() ?? "";
    const base = await rdapBase(tld);
    if (!base) {
      result.error = `no RDAP server for .${tld}`;
      return result;
    }
    const res = await fetchUrl(`${base}/domain/${encodeURIComponent(domain)}`, {
      timeoutMs: 20_000,
      maxBytes: 2 * 1024 * 1024,
      accept: "application/rdap+json, application/json",
    });
    if (res.error || res.statusCode !== 200) {
      result.error = res.error ?? `HTTP ${res.statusCode}`;
      return result;
    }
    return { ...parseRdap(domain, JSON.parse(res.body.toString("utf8"))), ok: true };
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }
}

interface RdapJson {
  events?: Array<{ eventAction?: string; eventDate?: string }>;
  entities?: Array<{ roles?: string[]; vcardArray?: [string, Array<[string, unknown, string, unknown]>] }>;
  nameservers?: Array<{ ldhName?: string }>;
  status?: string[];
}

export function parseRdap(domain: string, j: RdapJson): RdapResult {
  const exp = j.events?.find((e) => e.eventAction === "expiration")?.eventDate ?? null;
  const registrarEntity = j.entities?.find((e) => e.roles?.includes("registrar"));
  const fn = registrarEntity?.vcardArray?.[1]?.find((v) => v[0] === "fn")?.[3];
  return {
    domain,
    ok: true,
    error: null,
    expiresAt: exp ? new Date(exp).toISOString() : null,
    registrar: typeof fn === "string" ? fn : null,
    nameservers: (j.nameservers ?? [])
      .map((n) => n.ldhName?.toLowerCase().replace(/\.$/, ""))
      .filter((n): n is string => !!n)
      .sort(),
    statusFlags: (j.status ?? []).map((s) => s.toLowerCase()),
  };
}

export function badStatuses(flags: string[]): string[] {
  return flags.filter((f) => BAD_STATUSES.includes(f));
}

/**
 * Registrar locks: while they're set, nobody can change the nameservers,
 * transfer or delete the domain, so one going away is the earliest warning
 * of a change. (A renew lock isn't one: removing it changes nothing risky.)
 */
export const isLock = (flag: string) => /^(client|server) (update|transfer|delete) prohibited$/.test(flag);

/** Locks set before that aren't set now, and locks set now that weren't before. */
export function lockChanges(before: string[], after: string[]): { removed: string[]; added: string[] } {
  return { removed: before.filter((f) => isLock(f) && !after.includes(f)), added: after.filter((f) => isLock(f) && !before.includes(f)) };
}
