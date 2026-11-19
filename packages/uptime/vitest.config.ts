import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The checks package from its source in this workspace, as tsconfig.json's paths do for tsc.
  resolve: { alias: [{ find: /^agent-ready-checks\/(.*)$/, replacement: fileURLToPath(new URL("../checks/src/$1", import.meta.url)) }] },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
  },
});
