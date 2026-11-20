import { readFile } from "node:fs/promises";
import { z } from "zod";
import { openDefaultsShape, openSiteSchema, type OpenSite } from "./checks/config.js";
import { isWebhook, WEBHOOK_EXAMPLE, WEBHOOK_KINDS, type WebhookKind } from "./checks/webhook.js";

/**
 * monitor.config.json: the sites (the same keys the hosted service reads, from the
 * checks package), where alerts go, and how often each kind of check runs. Webhook
 * URLs are secrets, so a config usually names the environment variable holding one.
 */
const alertSchema = z
  .strictObject({
    kind: z.enum(WEBHOOK_KINDS as [WebhookKind, ...WebhookKind[]]),
    /** The webhook URL itself (keep the file private), or… */
    url: z.string().optional(),
    /** …the environment variable that holds it, e.g. "DISCORD_WEBHOOK_URL". */
    env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    /** A generic webhook's signing secret (`whsec_…`, Standard Webhooks): the environment variable that holds it. */
    secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  })
  .refine((a) => (a.url === undefined) !== (a.env === undefined), "set url or env, not both")
  .refine((a) => (a.kind === "webhook") === (a.secretEnv !== undefined), "a webhook names its signing secret's variable (secretEnv); Discord and Slack have none");

export const configSchema = z.strictObject({
  $schema: z.string().optional(),
  sites: z.array(openSiteSchema).min(1),
  alerts: z.array(alertSchema).default([]),
  defaults: z.strictObject(openDefaultsShape).prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type Site = OpenSite;
export interface Webhook {
  kind: WebhookKind;
  url: string;
  /** A generic webhook's signing secret. */
  secret?: string;
}

/** The JSON schema editors use for monitor.config.json (`agent-ready-uptime schema`). */
export function jsonSchema(): unknown {
  return z.toJSONSchema(configSchema, { io: "input" });
}

export class ConfigError extends Error {}

/** Parse a config: the schema, unique slugs, and each webhook's URL (from the file or its env var) on its service's own hosts. */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): { config: Config; webhooks: Webhook[] } {
  const r = configSchema.safeParse(raw);
  if (!r.success) throw new ConfigError(z.prettifyError(r.error));
  const config = r.data;
  const slugs = new Set<string>();
  for (const s of config.sites) {
    if (slugs.has(s.slug)) throw new ConfigError(`two sites are called "${s.slug}": slugs must be unique`);
    slugs.add(s.slug);
  }
  const webhooks = config.alerts.map((a, i): Webhook => {
    const url = a.url ?? env[a.env!];
    if (!url) throw new ConfigError(`alerts[${i}]: ${a.env} isn't set`);
    if (!isWebhook(a.kind, url)) throw new ConfigError(`alerts[${i}]: not a ${a.kind} webhook URL (expected ${WEBHOOK_EXAMPLE[a.kind]})`);
    if (a.secretEnv === undefined) return { kind: a.kind, url: url.trim() };
    const secret = env[a.secretEnv];
    if (!secret || !/^whsec_[A-Za-z0-9+/=]{32,}$/.test(secret)) throw new ConfigError(`alerts[${i}]: ${a.secretEnv} isn't a signing secret (whsec_…; \`agent-ready-uptime secret\` makes one)`);
    return { kind: a.kind, url: url.trim(), secret };
  });
  return { config, webhooks };
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<{ config: Config; webhooks: Webhook[] }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError(`no config at ${path} (see the README for an example)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${path} isn't JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw, env);
}

/** A config from the environment alone (SITES and the webhook variables): a Railway deploy needs no file. */
export function configFromEnv(env: NodeJS.ProcessEnv): unknown | null {
  const urls = (env.SITES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return null;
  return {
    sites: urls.map((url) => ({ slug: slugOf(url), name: new URL(url).hostname.replace(/^www\./, ""), url })),
    alerts: [
      ...(env.DISCORD_WEBHOOK_URL ? [{ kind: "discord", env: "DISCORD_WEBHOOK_URL" }] : []),
      ...(env.SLACK_WEBHOOK_URL ? [{ kind: "slack", env: "SLACK_WEBHOOK_URL" }] : []),
      ...(env.WEBHOOK_URL ? [{ kind: "webhook", env: "WEBHOOK_URL", secretEnv: "WEBHOOK_SECRET" }] : []),
    ],
  };
}

function slugOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
