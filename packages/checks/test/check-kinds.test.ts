import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { checkPort } from "../src/net/port.js";
import { describeRecordChange, normalise } from "../src/net/dns.js";
import { specSchema } from "../src/spec.js";

describe("TCP port checks", () => {
  it("refuses a private address unless local addresses are switched on", async () => {
    const prev = process.env.MONITOR_ALLOW_LOCAL;
    delete process.env.MONITOR_ALLOW_LOCAL;
    try {
      const r = await checkPort("tcp://10.0.0.5:22");
      expect(r).toMatchObject({ ok: false, error: "invalid_url" });
      expect(r.errorDetail).toContain("refused to connect to a private address");
    } finally {
      process.env.MONITOR_ALLOW_LOCAL = prev;
    }
  });
});

describe("DNS record checks", () => {
  it("normalises records so the same set always compares equal, and describes a change", () => {
    expect(normalise("MX", [{ priority: 20, exchange: "B.example.com." }, { priority: 10, exchange: "a.example.com" }])).toEqual(["10 a.example.com", "20 b.example.com"]);
    expect(normalise("TXT", [["v=spf1 ", "-all"]])).toEqual(["v=spf1 -all"]);
    expect(normalise("CAA", [{ critical: 0, issue: "letsencrypt.org" }])).toEqual(["0 issue letsencrypt.org"]);
    expect(describeRecordChange({ records: ["10 old.example.com"] }, { name: "example.com", type: "MX", records: ["10 new.example.com"] })).toBe("MX for example.com: added 10 new.example.com; removed 10 old.example.com");
  });
});

describe("config and the second location", () => {
  it("lets the second location run port and DNS specs, and only well-formed ones", () => {
    expect(specSchema.safeParse({ kind: "port", url: "tcp://mail.s.test:465", options: { tls: true, timeoutMs: 10_000 } }).success).toBe(true);
    expect(specSchema.safeParse({ kind: "dns", url: "dns://s.test/MX", options: { expect: ["10 mx.s.test"] } }).success).toBe(true);
    expect(specSchema.safeParse({ kind: "port", url: "http://s.test", options: {} }).success).toBe(false);
    expect(specSchema.safeParse({ kind: "dns", url: "dns://s.test/ANY", options: {} }).success).toBe(false);
    expect(specSchema.safeParse({ kind: "page", url: "https://s.test/", options: { seoChecks: false } }).success).toBe(true);
  });
});
