import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { cloudflare } from "@cloudflare/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

// The Cloudflare plugin wires the Worker (wrangler.toml `main`) into the
// Vite dev server and builds client + worker into one deployable.
//
// PWA (docs/Phase-002.md P2.1, decision D-1): vite-plugin-pwa (pinned to an
// exact version) precaches the client build so the app boots offline.
// The Cloudflare plugin builds the client into `dist/client` (root
// `build.outDir` + environment name) while the top-level resolved
// `build.outDir` stays `dist`, so the client output is passed explicitly:
// sw.js / manifest.webmanifest must land where Workers Static Assets serves
// them (root scope, for start_url "/" + root registration scope), and the
// precache glob must cover the client bundle only — never `dist/worker`.
const pwaPlugins = VitePWA({
  outDir: "dist/client",
  strategies: "generateSW",
  // D-1: autoUpdate, no update-prompt UI (UX.md: no chrome the user must
  // interpret); the session snapshot lives in IndexedDB, outside the
  // precache swap, so a silent update never loses work.
  registerType: "autoUpdate",
  // Icons are derived from public/favicon.svg at build time via the
  // external config (pwa-assets.config.ts) — see P2.1.
  pwaAssets: { config: true },
  manifest: {
    name: "learn-jp-web",
    short_name: "learn-jp",
    description: "Guided 10-minute Japanese practice sessions.",
    display: "standalone",
    start_url: "/",
    theme_color: "#4f46e5",
    background_color: "#ffffff",
    icons: [
      { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
      { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  },
  workbox: {
    // App shell: precached HTML + JS/CSS chunks (incl. the wanakana chunk
    // from Phase 1.5) + icons. The web manifest is NOT globbed here: the
    // plugin pushes manifest.webmanifest into additionalManifestEntries
    // itself, so matching it in the glob too would duplicate the precache
    // entry. Defaults already provide navigateFallback → precached
    // index.html and cleanupOutdatedCaches: true.
    globPatterns: ["**/*.{js,css,html,ico,png,svg}"],
    // A previous build's sw.js sits in the output dir; never precache it.
    globIgnores: ["sw.js"],
  },
});

// vite-plugin-pwa has no Vite-environment awareness (checked at 2.0.0):
// left alone it also runs during the Worker build and drops registerSW.js
// + manifest.webmanifest into dist/worker. Restrict every plugin it returns
// to the client environment — the only one a browser sees. config /
// configResolved keep running at the top level; Vite only skips the
// environment-scoped hooks (transformIndexHtml, generateBundle,
// closeBundle) for the other environments.
for (const plugin of pwaPlugins) {
  if (plugin) plugin.applyToEnvironment = (environment) => environment.name === "client";
}

export default defineConfig({
  plugins: [svelte(), cloudflare({ viteEnvironment: { name: "worker" } }), ...pwaPlugins],
});

