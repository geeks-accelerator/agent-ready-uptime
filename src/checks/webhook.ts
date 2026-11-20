import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";
import { fetchUrl } from "./http/request.js";

/** A webhook kind we post to: Discord's and Slack's own, or a generic one (any public HTTPS URL, signed). */
export type WebhookKind = "discord" | "slack" | "webhook";

/**
 * Webhook URLs as a team pastes them.
 * Discord and Slack: only each service's own hosts, over HTTPS, with its path shape.
 * A generic webhook may be any host, so its rule is the shape (HTTPS, a name not a raw
 * IP, no user info, no fragment, at most 2,048 characters) and the address check at
 * connect time: it's posted through `publicFetch`, which refuses private addresses
 * after resolving. Checked on save and again before every post.
 */
const PATTERNS: Record<Exclude<WebhookKind, "webhook">, RegExp> = {
  discord: /^https:\/\/(?:discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/,
  slack: /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,20}\/B[A-Z0-9]{6,20}\/[A-Za-z0-9]{16,64}$/,
};

export const WEBHOOK_KINDS: readonly WebhookKind[] = ["discord", "slack", "webhook"];

export const WEBHOOK_LABEL: Record<WebhookKind, string> = { discord: "Discord", slack: "Slack", webhook: "Webhook" };

export const WEBHOOK_EXAMPLE: Record<WebhookKind, string> = { discord: "https://discord.com/api/webhooks/…", slack: "https://hooks.slack.com/services/…", webhook: "https://example.com/hooks/…" };

/** The longest generic webhook URL we take. */
export const WEBHOOK_URL_MAX = 2048;

export function isWebhook(kind: WebhookKind, url: string): boolean {
  if (kind === "webhook") return isGenericWebhook(url);
  return PATTERNS[kind].test(url.trim());
}

function isGenericWebhook(raw: string): boolean {
  const url = raw.trim();
  if (url.length > WEBHOOK_URL_MAX || /\s/.test(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return u.protocol === "https:" && !u.username && !u.password && !u.hash && net.isIP(host) === 0 && host.includes(".") && !host.endsWith(".");
}

/** "https://discord.com/api/webhooks/123…/ab…yz": enough to recognise, not to use. */
export function maskWebhook(url: string): string {
  const m = /^(https:\/\/[^/]+\/)(.+)\/(\S+)$/.exec(url);
  if (!m) {
    try {
      return `${new URL(url).origin}/…`;
    } catch {
      return "set";
    }
  }
  const secret = m[3]!;
  return `${m[1]}${m[2]!.slice(0, 18)}…/${secret.slice(0, 2)}…${secret.slice(-2)}`;
}

/**
 * A channel's answer: accepted; unreachable (retry with backoff, given up after an
 * hour); or refused for a reason (`gone`: the destination no longer exists). When to
 * send is the notifier's to decide, never a channel's.
 */
export type SendResult = "ok" | "failed" | { rejected: string; gone?: boolean };

/**
 * Retry an HTTP post through 429s (honouring Retry-After, capped) and 5xx, as every webhook channel does.
 * `warn` hears each retry and refusal (a service's text included, so it's for logs only, never a page).
 */
export async function postWithRetries(
  name: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  url: string,
  body: () => { body: string | FormData; headers: Record<string, string> },
  timeoutMs: number,
  warn: (message: string) => void = () => {},
): Promise<SendResult> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetchImpl(url, { method: "POST", ...body(), signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return "ok";
      if (res.status === 429) {
        const json = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const header = Number(res.headers.get("retry-after"));
        const waitS = json.retry_after ?? (Number.isFinite(header) && header > 0 ? header : 2);
        warn(`${name.toLowerCase()} rate limited; retrying in ${waitS}s`);
        await sleep(Math.min(Math.ceil(waitS * 1000) + 100, 60_000));
        continue;
      }
      if (res.status >= 500) {
        await sleep(1000 * attempt);
        continue;
      }
      const text = await res.text().catch(() => "");
      warn(`${name.toLowerCase()} webhook rejected message: HTTP ${res.status} ${text}`.slice(0, 500));
      // A webhook that no longer exists (deleted channel, revoked app) says so, for the dashboard.
      const missing = res.status === 404 || res.status === 410 || /no_service|channel_not_found|channel_is_archived|invalid_token|no_team/.test(text);
      return { rejected: missing ? `the ${name} webhook no longer exists (HTTP ${res.status})` : `rejected by ${name}` };
    } catch (e) {
      // An address we never post to (a private one, found after resolving): no retry would change it.
      if ((e as { code?: string }).code === "SM_BLOCKED") {
        warn(`${name.toLowerCase()} webhook refused: ${(e as Error).message}`);
        return { rejected: "the webhook's address is private" };
      }
      warn(`${name.toLowerCase()} webhook error (attempt ${attempt}): ${(e as Error).message}`);
      await sleep(1000 * attempt);
    }
  }
  warn(`${name.toLowerCase()} webhook: post failed after 5 attempts`);
  return "failed";
}

/**
 * A new signing secret for a generic webhook, as Standard Webhooks writes one:
 * `whsec_` and 32 random bytes in base64 (https://www.standardwebhooks.com/).
 */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

/**
 * Standard Webhooks' signature: base64 HMAC-SHA256, keyed by the secret's bytes (after
 * `whsec_`), over `id.timestamp.body`, written `v1,<signature>`. Receivers verify it with
 * the spec's libraries in any language; `timestamp` is in seconds.
 */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** The headers a signed post carries: Standard Webhooks' three, and JSON. */
export function webhookHeaders(secret: string, id: string, body: string, now: number = Date.now()): Record<string, string> {
  const timestamp = Math.floor(now / 1000);
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signWebhook(secret, id, timestamp, body),
  };
}

/**
 * A `fetch` for posting to a URL someone pasted: `fetchUrl`'s POST, so the address is
 * resolved once and refused if it's private (the `SM_BLOCKED` error, which
 * `postWithRetries` answers without retrying), redirects are never followed, the wait
 * is capped at 10 seconds and at most 4 KB of the answer is read. Pass a `user-agent`
 * header to name the sender.
 */
export const publicFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const r = await fetchUrl(url, {
    method: (init?.method as "POST" | undefined) ?? "POST",
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
    headers,
    accept: "*/*",
    timeoutMs: 10_000,
    maxBytes: 4096,
  });
  if (r.error === "invalid_url" && /private address/.test(r.errorMessage ?? "")) throw Object.assign(new Error(r.errorMessage!), { code: "SM_BLOCKED" });
  if (r.error || r.statusCode === null) throw new Error(r.errorMessage ?? r.error ?? "no answer");
  const out = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : v);
  const empty = r.statusCode === 204 || r.statusCode === 205 || r.statusCode === 304;
  return new Response(empty ? null : new Uint8Array(r.body), { status: r.statusCode, headers: out });
};
