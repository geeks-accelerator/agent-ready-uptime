import net from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { describeError, syntheticResult, type PageCheckResult } from "../http/page-check.js";
import { blocked, classify, isPrivateAddress, privateAllowedFor, publicLookup, type TlsInfo } from "../http/request.js";

/**
 * TCP port checks:
 * connect to `tcp://host:port`, optionally finish a TLS handshake, and optionally send
 * a line and require a reply containing `expect`. Public addresses only, by the same
 * rule as page fetches.
 */
export interface PortCheckOptions {
  timeoutMs?: number;
  tls?: boolean;
  send?: string;
  expect?: string;
}

/** Bytes of the reply read for `expect`. */
const REPLY_BYTES = 4096;

const round = (n: number) => Math.round(n);

export async function checkPort(url: string, opts: PortCheckOptions = {}): Promise<PageCheckResult> {
  const checkedAt = new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let host: string;
  let port: number;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^\[|\]$/g, "");
    port = Number(u.port);
    if (u.protocol !== "tcp:" || !host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("bad");
  } catch {
    return syntheticResult(url, checkedAt, { ok: false, error: "invalid_url", errorDetail: `not a tcp://host:port address: ${url}` });
  }
  const allowPrivate = privateAllowedFor(url);
  if (!allowPrivate && net.isIP(host) !== 0 && isPrivateAddress(host)) {
    return syntheticResult(url, checkedAt, { ok: false, error: "invalid_url", errorDetail: blocked(host).message });
  }

  const t0 = performance.now();
  let tLookup: number | null = null;
  let tConnect: number | null = null;
  let tSecure: number | null = null;
  let tlsInfo: TlsInfo | null = null;

  const outcome = await new Promise<{ ok: true; reply: string } | { ok: false; error: string; detail: string }>((resolve) => {
    let reply = "";
    let settled = false;
    const finish = (v: { ok: true; reply: string } | { ok: false; error: string; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close politely: drain what the server sent (a greeting banner) and send FIN, so it
      // doesn't see a reset; the socket is destroyed a moment later either way.
      socket.removeAllListeners("data");
      socket.on("error", () => {});
      socket.resume();
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
      resolve(v);
    };
    const socket: net.Socket = net.connect({ host, port, ...(allowPrivate ? {} : { lookup: publicLookup as unknown as typeof import("node:dns").lookup }) });
    const timer = setTimeout(() => finish({ ok: false, error: "timeout", detail: `no ${tConnect === null ? "connection" : opts.expect ? "reply" : "TLS handshake"} after ${timeoutMs} ms` }), timeoutMs);
    socket.once("lookup", () => (tLookup = performance.now()));
    socket.once("error", (e: Error & { code?: string }) => finish({ ok: false, error: classify(e), detail: `${describeError(classify(e), null)} (${e.message})` }));

    const talk = (s: net.Socket | TLSSocket) => {
      if (opts.send === undefined && opts.expect === undefined) return finish({ ok: true, reply: "" });
      s.on("data", (chunk: Buffer) => {
        reply += chunk.toString("utf8");
        if (opts.expect !== undefined && reply.includes(opts.expect)) finish({ ok: true, reply });
        else if (reply.length >= REPLY_BYTES) finish({ ok: false, error: "unexpected_reply", detail: `the reply didn't contain ${JSON.stringify(opts.expect)}` });
      });
      s.once("end", () => (opts.expect === undefined ? finish({ ok: true, reply }) : finish({ ok: false, error: "unexpected_reply", detail: `the reply didn't contain ${JSON.stringify(opts.expect)}${reply ? `: ${JSON.stringify(reply.slice(0, 120))}` : " (closed without a reply)"}` })));
      if (opts.send !== undefined) s.write(opts.send);
    };

    socket.once("connect", () => {
      tConnect = performance.now();
      if (!opts.tls) return talk(socket);
      const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host });
      secure.once("error", (e: Error & { code?: string }) => finish({ ok: false, error: classify(e), detail: `${describeError(classify(e), null)} (${e.message})` }));
      secure.once("secureConnect", () => {
        tSecure = performance.now();
        const cert = secure.getPeerCertificate();
        tlsInfo = {
          validFrom: cert?.valid_from ? new Date(cert.valid_from).toISOString() : null,
          validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null,
          issuer: (cert?.issuer?.O as string | undefined) ?? (cert?.issuer?.CN as string | undefined) ?? null,
          protocol: secure.getProtocol?.() ?? null,
        };
        talk(secure);
      });
    });
  });

  const end = performance.now();
  const lookupEnd = tLookup ?? t0;
  const connectEnd = tConnect ?? lookupEnd;
  const timings = {
    dnsMs: round(lookupEnd - t0),
    connectMs: tConnect === null ? 0 : round(connectEnd - lookupEnd),
    tlsMs: tSecure === null ? 0 : round(tSecure - connectEnd),
    // "Time to answer": the connection (and handshake) for a bare port, the reply when there's an exchange.
    ttfbMs: round((opts.expect !== undefined ? end : (tSecure ?? tConnect ?? end)) - t0),
    totalMs: round(end - t0),
  };
  const label = `${host}:${port}`;
  return outcome.ok
    ? syntheticResult(url, checkedAt, { ok: true, timings, tls: tlsInfo, title: opts.expect !== undefined ? `${label} answered` : opts.tls ? `${label} open (TLS)` : `${label} open` })
    : syntheticResult(url, checkedAt, { ok: false, error: outcome.error, errorDetail: `${label}: ${outcome.detail}`, timings, tls: tlsInfo });
}
