/** A webhook kind we post to. */
export type WebhookKind = "discord" | "slack";

/**
 * Webhook URLs as a team pastes them.
 * Only each kind's own hosts, over HTTPS, with its path shape: a pasted URL is never
 * fetched anywhere else (an internal address, a metadata IP). Checked on save and
 * again before every post.
 */
const PATTERNS: Record<WebhookKind, RegExp> = {
  discord: /^https:\/\/(?:discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/,
  slack: /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,20}\/B[A-Z0-9]{6,20}\/[A-Za-z0-9]{16,64}$/,
};

export const WEBHOOK_KINDS: readonly WebhookKind[] = ["discord", "slack"];

export const WEBHOOK_LABEL: Record<WebhookKind, string> = { discord: "Discord", slack: "Slack" };

export const WEBHOOK_EXAMPLE: Record<WebhookKind, string> = { discord: "https://discord.com/api/webhooks/…", slack: "https://hooks.slack.com/services/…" };

export function isWebhook(kind: WebhookKind, url: string): boolean {
  return PATTERNS[kind].test(url.trim());
}

/** "https://discord.com/api/webhooks/123…/ab…yz": enough to recognise, not to use. */
export function maskWebhook(url: string): string {
  const m = /^(https:\/\/[^/]+\/)(.+)\/(\S+)$/.exec(url);
  if (!m) return "set";
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
      warn(`${name.toLowerCase()} webhook error (attempt ${attempt}): ${(e as Error).message}`);
      await sleep(1000 * attempt);
    }
  }
  warn(`${name.toLowerCase()} webhook: post failed after 5 attempts`);
  return "failed";
}
