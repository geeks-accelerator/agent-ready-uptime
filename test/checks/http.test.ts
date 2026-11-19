import http from "node:http";
import { type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchUrl, isPrivateAddress } from "../../src/checks/http/request.js";
import { checkPage, describeError } from "../../src/checks/http/page-check.js";
import { siteOrigins } from "../../src/checks/url.js";
import { testServer } from "../../src/checks/testing/servers.js";
import { ms } from "../../src/checks/format.js";

describe("checkPage", () => {
  it("stops at the headers when the body isn't wanted", async () => {
    // Headers at once, then a body that takes 3 s: readBody false must not wait for it.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<p>start</p>");
      const t = setTimeout(() => res.end("x".repeat(100_000)), 3000);
      res.on("close", () => clearTimeout(t));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const t0 = Date.now();
      const r = await fetchUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { readBody: false, timeoutMs: 10_000 });
      expect(r.statusCode).toBe(200);
      expect(r.error).toBeNull();
      expect(r.bytes).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it("accepts response headers past Node's 16 KB default, as browsers do", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "x-big": "a".repeat(40_000) });
      res.end("<title>ok</title>");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const r = await fetchUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { timeoutMs: 5_000 });
      expect(r.error).toBeNull();
      expect(r.statusCode).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});

describe("private addresses", () => {
  it("knows loopback, private, link-local, CGNAT and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "[::1]"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:1.1.1.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("knows mapped addresses as the URL parser writes them (hex), NAT64 and the benchmark range", () => {
    expect(new URL("http://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    for (const ip of ["::ffff:7f00:1", "[::ffff:a9fe:a9fe]", "::ffff:a00:1", "::ffff:c0a8:101", "64:ff9b::7f00:1", "198.18.0.1", "240.0.0.1", "255.255.255.255"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["::ffff:101:101", "198.20.0.1", "not an address"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("request profiles", () => {
  it("browser profile sends Chrome headers; neither profile asks to bypass the cache", async () => {
    let seen: http.IncomingHttpHeaders = {};
    const srv = http.createServer((req, res) => ((seen = req.headers), res.end("ok")));
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
    try {
      await fetchUrl(url, { profile: "browser" });
      expect(seen["user-agent"]).toMatch(/Chrome\/\d+/);
      expect(seen["accept-language"]).toBe("en-US,en;q=0.9");
      expect(seen["sec-fetch-mode"]).toBe("navigate");
      expect(seen["cache-control"]).toBeUndefined();
      await fetchUrl(url);
      expect(seen["user-agent"]).toMatch(/^agent-ready-uptime /);
      expect(seen["cache-control"]).toBeUndefined();
    } finally {
      srv.close();
    }
  });
});

describe("blocked answers (pace)", () => {
  it("stayOn with host:port pairs refuses a redirect to another port on the same host", async () => {
    const srv = await testServer({ "/r": { status: 302, headers: { location: "http://127.0.0.1:1/x" } } });
    try {
      const r = await fetchUrl(`${srv.url}/r`, { stayOn: siteOrigins(srv.url) });
      expect(r.error).toBe("redirect_off_host");
    } finally {
      await srv.close();
    }
  });
});

describe("accurate, not precise: number formatting", () => {
  it("rounds response times to two significant figures, seconds above one", () => {
    expect([87, 149, 199, 995, 1_234, 9_960, 12_400].map((v) => ms(v))).toEqual(["87 ms", "150 ms", "200 ms", "1.0 s", "1.2 s", "10 s", "12 s"]);
    expect(ms(199, { exact: true })).toBe("199 ms");
    expect(ms(null)).toBe("–");
  });
});

describe("shared helpers", () => {
  it("describeError says what evaluate() says", async () => {
    const srv = await testServer({ "/cf": { status: 530, headers: { server: "cloudflare", "cf-ray": "abc" } }, "/down": { status: 503 } });
    try {
      expect((await checkPage(`${srv.url}/cf`)).errorDetail).toBe(describeError("cloudflare_origin_unreachable", 530));
      expect((await checkPage(`${srv.url}/down`)).errorDetail).toBe(describeError("http_503", 503));
    } finally {
      await srv.close();
    }
    expect(describeError("timeout", null)).toBe("Timed out waiting for the server");
  });
});
