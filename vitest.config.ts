import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd with the real bindings from wrangler.toml
// (local D1), per docs/ARCHITECTURE.md "Dev tooling".
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
});
