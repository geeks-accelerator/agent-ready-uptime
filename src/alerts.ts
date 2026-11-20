import { randomUUID } from "node:crypto";
import { isWebhook, postWithRetries, publicFetch, WEBHOOK_LABEL, webhookHeaders, type SendResult } from "./checks/webhook.js";
import type { Webhook } from "./config.js";
import { alertDetail, type Alert, type AlertKind } from "./judge.js";

/**
 * One message per alert, to every webhook: what broke and nothing else (no link to
 * anything but the site). Discord never mentions anyone: alert text can carry a
 * site's words, and "@everyone" in them must not ping a channel.
 */
const COLOR: Record<AlertKind, number> = { down: 0xd64545, failing: 0xd68a1f, expiring: 0xd68a1f, changed: 0x3d7dd8, up: 0x2f9e5b, recovered: 0x2f9e5b };
const EMOJI: Record<AlertKind, string> = { down: "🔴", failing: "🟠", expiring: "🟠", changed: "🔵", up: "🟢", recovered: "🟢" };

/** Discord's limits: a title of 256 characters, a description of 4,096. */
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function discordPayload(a: Alert): unknown {
  return {
    username: "agent-ready-uptime",
    allowed_mentions: { parse: [] },
    embeds: [{ title: cut(a.title, 256), description: cut([alertDetail(a, "discord"), a.url].filter(Boolean).join("\n"), 4096), color: COLOR[a.kind], timestamp: a.at }],
  };
}

export function slackPayload(a: Alert): unknown {
  // Slack's mrkdwn: escape &, < and > so a site's text can't make a link or a mention.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { text: cut([`${EMOJI[a.kind]} *${esc(a.title)}*`, slackDetail(a, esc), esc(a.url)].filter(Boolean).join("\n"), 3000) };
}

/** Slack: the site's words escaped, our date markup left as markup. */
function slackDetail(a: Alert, esc: (s: string) => string): string | null {
  const escaped = { ...a, detail: a.detail === null ? null : esc(a.detail) };
  return alertDetail(escaped, "slack");
}

/**
 * A generic webhook's body: the alert as JSON, versioned. The title and detail are the
 * alert's own words, which can quote a site (a page's title, an error), so they're data
 * for the receiver to escape, never markup.
 */
export function webhookPayload(a: Alert, id: string): Record<string, unknown> {
  return { type: `alert.${a.kind}`, version: 1, id, at: a.at, kind: a.kind, site: a.site, target: a.target, title: a.title, detail: a.detail, ...(a.when ? { when: a.when } : {}), url: a.url };
}

export interface Sender {
  (a: Alert): Promise<void>;
}

/** Post each alert to each webhook (retrying 429s and 5xx); a refusal is logged, never thrown. */
export function webhookSender(webhooks: Webhook[], o: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; warn?: (m: string) => void } = {}): Sender {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const warn = o.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  return async (a) => {
    await Promise.all(
      webhooks.map(async (w) => {
        // Checked again before every post (the config was checked on load): a URL never goes anywhere else.
        if (!isWebhook(w.kind, w.url)) return warn(`${w.kind}: not a ${w.kind} webhook URL; skipped`);
        if (w.kind === "webhook") {
          // Signed (Standard Webhooks), and posted through publicFetch: any host, never a private address.
          const id = `msg_${randomUUID()}`;
          const body = JSON.stringify(webhookPayload(a, id));
          const r: SendResult = await postWithRetries("Webhook", o.fetchImpl ?? publicFetch, sleep, w.url, () => ({ body, headers: { ...webhookHeaders(w.secret!, id, body), "user-agent": "agent-ready-uptime-webhooks/1" } }), 15_000, warn);
          if (r !== "ok") warn(`webhook: alert not delivered (${r === "failed" ? "unreachable" : r.rejected})`);
          return;
        }
        const body = JSON.stringify(w.kind === "discord" ? discordPayload(a) : slackPayload(a));
        const r: SendResult = await postWithRetries(WEBHOOK_LABEL[w.kind], o.fetchImpl ?? fetch, sleep, w.url, () => ({ body, headers: { "content-type": "application/json" } }), 15_000, warn);
        if (r !== "ok") warn(`${w.kind}: alert not delivered (${r === "failed" ? "unreachable" : r.rejected})`);
      }),
    );
  };
}
