import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Pure-logic units at the sandcastle.run() seam — the injected/mocked run()
    // means no database, no network, no real agent. They stay fast, so the
    // default timeouts are plenty.
    include: ["**/*.test.ts"],
  },
});
