import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { webhookSender } from "./alerts.js";
import { ConfigError, configFromEnv, jsonSchema, loadConfig, parseConfig, type Config, type Webhook } from "./config.js";
import { Runner } from "./runner.js";
import { pageServer } from "./server.js";
import { TITLE } from "./page.js";

const USAGE = `${TITLE}

Usage:
  agent-ready-uptime watch   [--config FILE] [--state FILE] [--port 8080] [--host 127.0.0.1] [--no-page]
  agent-ready-uptime check   [--config FILE] [--state FILE]     one pass; exit 1 if anything is failing
  agent-ready-uptime init    <https://your.site> [more sites]   write monitor.config.json
  agent-ready-uptime schema                                     print the config's JSON schema

Config: --config, else ./monitor.config.json, else the SITES environment variable
(comma-separated URLs) with DISCORD_WEBHOOK_URL and/or SLACK_WEBHOOK_URL.
`;

/** A usage or config problem: exit code 2, the message on stderr. */
class UsageError extends Error {}
function fail(message: string): never {
  throw new UsageError(message);
}

async function config(path: string | undefined): Promise<{ config: Config; webhooks: Webhook[] }> {
  if (path) return loadConfig(path);
  if (existsSync("monitor.config.json")) return loadConfig("monitor.config.json");
  const fromEnv = configFromEnv(process.env);
  if (fromEnv) return parseConfig(fromEnv);
  throw new ConfigError("no monitor.config.json here and no SITES variable: run `agent-ready-uptime init https://your.site`");
}

/**
 * Run a command. Resolves with the exit code (check: 1 while anything fails), or null
 * for watch, which keeps running until SIGTERM or SIGINT.
 */
export async function run(argv: string[]): Promise<number | null> {
  try {
    return await command(argv);
  } catch (e) {
    if (e instanceof UsageError || e instanceof ConfigError) {
      process.stderr.write(`${e instanceof ConfigError ? "Config: " : ""}${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

async function command(argv: string[]): Promise<number | null> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      state: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "no-page": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command = "watch", ...rest] = positionals;
  if (values.help) return (process.stdout.write(USAGE), 0);

  if (command === "schema") return (process.stdout.write(`${JSON.stringify(jsonSchema(), null, 2)}\n`), 0);

  if (command === "init") {
    if (!rest.length) fail("init needs at least one site URL, e.g. agent-ready-uptime init https://example.com");
    if (existsSync("monitor.config.json")) fail("monitor.config.json already exists");
    const c = configFromEnv({ SITES: rest.join(",") }) as { sites: unknown[] };
    const file = { $schema: "https://unpkg.com/agent-ready-uptime/monitor.config.schema.json", sites: c.sites, alerts: [{ kind: "discord", env: "DISCORD_WEBHOOK_URL" }] };
    parseConfig(file, { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/00000/placeholder-placeholder" });
    await writeFile("monitor.config.json", `${JSON.stringify(file, null, 2)}\n`);
    process.stdout.write("Wrote monitor.config.json. Set DISCORD_WEBHOOK_URL (or edit alerts), then run: npx agent-ready-uptime watch\n");
    return 0;
  }

  if (command !== "watch" && command !== "check") fail(USAGE);
  const { config: cfg, webhooks } = await config(values.config);
  const statePath = values.state ?? process.env.STATE_PATH ?? ".agent-ready-uptime/state.json";
  const runner = await Runner.open(cfg, { statePath, send: webhookSender(webhooks) });
  if (!webhooks.length) process.stderr.write("No alerts configured: problems are only logged and shown on the page.\n");

  if (command === "check") {
    await runner.discover(true);
    await runner.checkAll();
    await runner.stop();
    return runner.failing().length ? 1 : 0;
  }

  // Discovery runs from the loop (now, then every 6 hours), so the homepage checks start at once.
  runner.watch();
  let server: ReturnType<typeof pageServer> | null = null;
  if (!values["no-page"]) {
    const port = Number(values.port ?? process.env.PORT ?? 8080);
    const host = values.host ?? process.env.HOST ?? "127.0.0.1";
    server = pageServer(runner).listen(port, host, () => process.stderr.write(`Status page: http://${host}:${port}/\n`));
  }
  const stop = async () => {
    server?.close();
    await runner.stop();
    process.stdout.write("", () => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return null;
}
