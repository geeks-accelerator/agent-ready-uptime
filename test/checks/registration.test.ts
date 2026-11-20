import { describe, expect, it } from "vitest";
import { AUTO_RENEW_PERIOD, judgeRegistration, type RegistrationState } from "../../src/checks/domain/registration.js";
import { judge } from "../../src/judge.js";
import type { TargetState } from "../../src/state.js";
import type { Target } from "../../src/targets.js";

const at = (iso: string) => Date.parse(iso);
const reg = (o: Partial<RegistrationState> = {}): RegistrationState => ({ expiresAt: "2027-02-21T00:00:00.000Z", statusFlags: ["client transfer prohibited"], nameservers: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"], ...o });

describe("judgeRegistration", () => {
  it("calls a date moved before expiry a renewal, and one moved after expiry the registry's own", () => {
    const next = reg({ expiresAt: "2028-02-21T00:00:00.000Z" });
    expect(judgeRegistration(reg(), next, at("2027-01-20T00:00:00Z")).renewal).toBe("seen");
    expect(judgeRegistration(reg(), next, at("2027-02-22T00:00:00Z")).renewal).toBe("registry");
    // Before expiry but under the registry's auto-renew status: not proof anyone paid.
    expect(judgeRegistration(reg(), { ...next, statusFlags: [AUTO_RENEW_PERIOD] }, at("2027-01-20T00:00:00Z")).renewal).toBe("registry");
    // A small move (a correction) is no renewal; nor is the first reading.
    expect(judgeRegistration(reg(), reg({ expiresAt: "2027-03-01T00:00:00.000Z" }), at("2027-01-20T00:00:00Z")).renewal).toBeNull();
    expect(judgeRegistration(null, next, at("2027-01-20T00:00:00Z")).renewal).toBeNull();
  });

  it("says when only the registry has renewed it (the registrar may not have been paid)", () => {
    expect(judgeRegistration(reg(), reg({ statusFlags: [AUTO_RENEW_PERIOD, "client transfer prohibited"] }), at("2027-02-22T00:00:00Z")).unpaid).toBe(true);
    expect(judgeRegistration(reg(), reg(), at("2027-02-22T00:00:00Z")).unpaid).toBe(false);
  });

  it("finds bad statuses, removed locks (once there's a reading to compare) and a move to a parking host", () => {
    const j = judgeRegistration(reg(), reg({ statusFlags: ["client hold"], nameservers: ["ns1.pendingrenewaldeletion.com", "ns2.pendingrenewaldeletion.com"] }), at("2027-02-22T00:00:00Z"));
    expect(j.bad).toEqual(["client hold"]);
    expect(j.locks.removed).toEqual(["client transfer prohibited"]);
    expect(j.parked).toEqual(["ns1.pendingrenewaldeletion.com", "ns2.pendingrenewaldeletion.com"]);
    expect(judgeRegistration(null, reg({ statusFlags: ["client hold"] }), 0).locks.removed).toEqual([]);
    // A registrar's normal DNS is never parking.
    expect(judgeRegistration(reg({ nameservers: ["a.ns.cloudflare.com"] }), reg(), 0).parked).toEqual([]);
  });
});

describe("the runner's domain alerts", () => {
  const t = { key: "acme:domain", site: "acme", kind: "domain", label: "acme.com", url: "acme.com" } as unknown as Target;
  const state = (o: Partial<TargetState> = {}): TargetState => ({ ok: true, since: null, checkedAt: null, error: null, detail: null, ttfbMs: null, streak: { failures: 0, firstFailedAt: null, reason: null }, alerted: false, ...o }) as TargetState;
  const outcome = (r: RegistrationState, checkedAt: string) => ({ ok: true, checkedAt, error: null, detail: null, ttfbMs: null, expiresAt: r.expiresAt, registration: r });

  it("alerts once when only the registry renewed it, and never when the registrar did", () => {
    const after = reg({ expiresAt: "2028-02-21T00:00:00.000Z", statusFlags: [AUTO_RENEW_PERIOD, "client transfer prohibited"] });
    const first = judge(t, state({ registration: reg() }), outcome(after, "2027-02-22T10:00:00.000Z"), "Acme");
    expect(first.alerts.map((a) => a.title)).toEqual(["Acme: acme.com expired and may not have been paid for"]);
    expect(judge(t, first.state, outcome(after, "2027-02-22T16:00:00.000Z"), "Acme").alerts).toEqual([]);
    const paid = judge(t, state({ registration: reg() }), outcome(reg({ expiresAt: "2028-02-21T00:00:00.000Z" }), "2027-01-20T10:00:00.000Z"), "Acme");
    expect(paid.alerts).toEqual([]);
  });

  it("alerts on a removed lock and a parking host, and keeps the reading", () => {
    const r = judge(t, state({ registration: reg() }), outcome(reg({ statusFlags: [], nameservers: ["ns1.sedoparking.com"] }), "2026-12-01T00:00:00.000Z"), "Acme");
    expect(r.alerts.map((a) => a.kind)).toEqual(["failing"]);
    expect(r.state.registration?.nameservers).toEqual(["ns1.sedoparking.com"]);
    const lock = judge(t, state({ registration: reg() }), outcome(reg({ statusFlags: ["client delete prohibited"] }), "2026-12-01T00:00:00.000Z"), "Acme");
    expect(lock.alerts.map((a) => a.title)).toEqual(["Acme: acme.com's registrar lock was removed"]);
  });
});
