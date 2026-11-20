import crypto, { type KeyObject } from "node:crypto";

/**
 * Web Bot Auth: HTTP Message Signatures (RFC 9421) that say which operator sent a request, so a
 * site's CDN can tell a verified monitor from anything else using its user agent
 * (draft-ietf-webbotauth-httpsig-protocol). Ed25519 only, the algorithm every verifier takes.
 *
 * - Each request carries `Signature-Agent` (the operator's https origin, where its keys are
 *   published), `Signature-Input` and `Signature`, covering `@authority` and `signature-agent`, with
 *   `created`, `expires`, `keyid` (the key's JWK thumbprint), a nonce and `tag="web-bot-auth"`.
 * - The keys are a JWK Set at `<agent>/.well-known/http-message-signatures-directory`, and that
 *   response is itself signed (`tag="http-message-signatures-directory"`) by each key it lists.
 *
 * `@authority` is the host the request goes to, so a redirect to another host needs a new
 * signature: `fetchUrl` signs each hop itself (`FetchOptions.sign`).
 */

/** Where an operator's key directory lives, under its `Signature-Agent` origin. */
export const SIGNATURES_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
/** The directory's media type. */
export const SIGNATURES_DIRECTORY_TYPE = "application/http-message-signatures-directory+json";

/** How long a request signature is good for: short, so a captured one can't be replayed for long. */
const REQUEST_TTL_S = 300;
/** A directory response's signature: it may be cached, so it lasts longer. */
const DIRECTORY_TTL_S = 86_400;

export interface Signer {
  /** The operator's https origin, sent as `Signature-Agent` (e.g. https://monitor.example). */
  agent: string;
  key: KeyObject;
  /** The public key as a JWK (`kty`, `crv`, `x`). */
  publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  /** RFC 7638 thumbprint of the public key, base64url: the `keyid`. */
  keyId: string;
  /**
   * How `Signature-Agent` is written: "item" is a bare quoted URL (what ChatGPT's agent and
   * Cloudflare's guide send); "dictionary" labels it (`agent="…"`, the draft's later form).
   */
  form: "item" | "dictionary";
}

/**
 * A signer from a private key (a JWK with `d`, or PKCS #8 PEM) and the operator's origin. Throws
 * on anything but an Ed25519 private key or an https origin.
 */
export function signerFrom(privateKey: string, agent: string, form: Signer["form"] = "item"): Signer {
  const origin = new URL(agent);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("the signature agent must be an https origin");
  const trimmed = privateKey.trim();
  const key = trimmed.startsWith("{")
    ? crypto.createPrivateKey({ key: JSON.parse(trimmed) as Record<string, string>, format: "jwk" })
    : crypto.createPrivateKey(trimmed);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the signing key must be Ed25519");
  const jwk = crypto.createPublicKey(key).export({ format: "jwk" }) as { x: string };
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x } as const;
  return { agent: origin.origin, key, publicJwk, keyId: jwkThumbprint(publicJwk), form };
}

/** A new Ed25519 key as a private JWK (for `MONITOR_SIGNING_KEY`), and its public half. */
export function newSigningKey(): { privateJwk: string; publicJwk: Signer["publicJwk"] } {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  return { privateJwk: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }), publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x } };
}

/** RFC 7638: SHA-256 over the required members in lexicographic order, base64url. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string }): string {
  return crypto.createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("base64url");
}

/** `@authority` (RFC 9421 §2.2.3): the host, lower case, with the port only when it isn't the scheme's default. */
export function authorityOf(url: URL): string {
  const port = url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) ? `:${url.port}` : "";
  return `${url.hostname.toLowerCase()}${port}`;
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

interface Params {
  created: number;
  expires: number;
  keyId: string;
  nonce?: string;
  tag: string;
}

const paramsText = (components: string[], p: Params) =>
  `(${components.join(" ")});created=${p.created};expires=${p.expires};keyid=${quote(p.keyId)};alg="ed25519"${p.nonce ? `;nonce=${quote(p.nonce)}` : ""};tag=${quote(p.tag)}`;

/** The signature base (RFC 9421 §2.5) for the given component lines and parameters. */
export function signatureBase(lines: Array<[string, string]>, p: Params): string {
  return [...lines.map(([name, value]) => `${name}: ${value}`), `"@signature-params": ${paramsText(lines.map(([n]) => n), p)}`].join("\n");
}

const sign = (s: Signer, base: string) => crypto.sign(null, Buffer.from(base), s.key).toString("base64");

/**
 * The three headers that sign a request to `url` as `s.agent`. `now` is in seconds (for tests).
 * The label is `sig1`, and in the dictionary form the agent's label is `agent`.
 */
export function signatureHeaders(url: string | URL, s: Signer, now = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(32).toString("base64")): Record<string, string> {
  const u = typeof url === "string" ? new URL(url) : url;
  const agentValue = s.form === "dictionary" ? `agent=${quote(s.agent)}` : quote(s.agent);
  const agentComponent = s.form === "dictionary" ? `"signature-agent";key="agent"` : `"signature-agent"`;
  const p: Params = { created: now, expires: now + REQUEST_TTL_S, keyId: s.keyId, nonce, tag: "web-bot-auth" };
  const lines: Array<[string, string]> = [
    [`"@authority"`, authorityOf(u)],
    [agentComponent, s.form === "dictionary" ? quote(s.agent) : agentValue],
  ];
  return {
    "signature-agent": agentValue,
    "signature-input": `sig1=${paramsText(lines.map(([n]) => n), p)}`,
    signature: `sig1=:${sign(s, signatureBase(lines, p))}:`,
  };
}

/**
 * The key directory's response for `s` (and older keys still in use, for rotation): its JWK Set and
 * the headers that sign it, one signature per key, covering `@authority` (the operator's own host).
 * Every key listed must be one we hold: a directory's signature proves it.
 */
export function signaturesDirectory(signers: Signer[], now = Math.floor(Date.now() / 1000)): { body: string; headers: Record<string, string> } {
  if (!signers.length) throw new Error("no keys");
  const body = JSON.stringify({ keys: signers.map((s) => s.publicJwk) });
  const authority = authorityOf(new URL(signers[0]!.agent));
  const inputs: string[] = [];
  const signatures: string[] = [];
  signers.forEach((s, i) => {
    const p: Params = { created: now, expires: now + DIRECTORY_TTL_S, keyId: s.keyId, tag: "http-message-signatures-directory" };
    const lines: Array<[string, string]> = [[`"@authority"`, authority]];
    inputs.push(`sig${i + 1}=${paramsText([`"@authority"`], p)}`);
    signatures.push(`sig${i + 1}=:${sign(s, signatureBase(lines, p))}:`);
  });
  return { body, headers: { "content-type": SIGNATURES_DIRECTORY_TYPE, "signature-input": inputs.join(", "), signature: signatures.join(", ") } };
}

/**
 * Check one signed request's headers against a public key (our own tests, and a local check of a
 * key before it goes live). Covers only what `signatureHeaders` makes; it isn't a general verifier.
 */
export function verifySignatureHeaders(url: string | URL, headers: Record<string, string>, publicJwk: { kty: string; crv: string; x: string }, now = Math.floor(Date.now() / 1000)): "verified" | "expired" | "invalid" {
  const u = typeof url === "string" ? new URL(url) : url;
  const input = /^sig1=\((.*?)\);(.*)$/.exec(headers["signature-input"] ?? "");
  const sig = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(headers.signature ?? "");
  if (!input || !sig) return "invalid";
  const components = input[1]!.split(" ");
  const params = Object.fromEntries(input[2]!.split(";").map((kv) => {
    const at = kv.indexOf("=");
    return [kv.slice(0, at), kv.slice(at + 1).replace(/^"|"$/g, "")];
  }));
  if (params.tag !== "web-bot-auth" || params.keyid !== jwkThumbprint(publicJwk)) return "invalid";
  const lines: Array<[string, string]> = components.map((c) => {
    if (c === `"@authority"`) return [c, authorityOf(u)];
    if (c.startsWith(`"signature-agent"`)) {
      const v = headers["signature-agent"] ?? "";
      return [c, c.includes(";key=") ? v.replace(/^[a-z0-9_-]+=/, "") : v];
    }
    return [c, ""];
  });
  const base = [...lines.map(([n, v]) => `${n}: ${v}`), `"@signature-params": (${input[1]});${input[2]}`].join("\n");
  const key = crypto.createPublicKey({ key: { ...publicJwk }, format: "jwk" });
  if (!crypto.verify(null, Buffer.from(base), key, Buffer.from(sig[1]!, "base64"))) return "invalid";
  return Number(params.expires) < now ? "expired" : "verified";
}
