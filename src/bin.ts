#!/usr/bin/env node
import { run } from "./cli.js";

/** Exit once stdout and stderr have flushed: process.exit() right after a write to a pipe drops it. */
const exit = (code: number) => process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));

run(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) exit(code);
  },
  (e) => {
    process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
    // 2, not 1: a crash is the run failing, never a check failing (CI can retry it).
    exit(2);
  },
);
