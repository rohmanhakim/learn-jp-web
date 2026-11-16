import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin wires the Worker (wrangler.toml `main`) into the
// Vite dev server and builds client + worker into one deployable.
export default defineConfig({
  plugins: [svelte(), cloudflare({ viteEnvironment: { name: "worker" } })],
});
