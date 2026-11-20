// PWA icon derivation (docs/Phase-002.md P2.1): one committed source icon
// (public/favicon.svg) -> every icon the web app manifest and the HTML head
// need, generated at build time by @vite-pwa/assets-generator (pinned).
//
// Based on the built-in `minimal-2023` preset (see the preset's own docs:
// transparent 64/192/512 + favicon.ico, maskable 512, apple 180), with the
// maskable and apple backgrounds set to the brand color instead of the
// default white, so those icons come out as a full-bleed indigo field.
import { defineConfig, type Preset } from "@vite-pwa/assets-generator/config";

const BRAND = "#4f46e5";

const preset: Preset = {
  transparent: {
    sizes: [64, 192, 512],
    favicons: [[48, "favicon.ico"]],
  },
  maskable: {
    sizes: [512],
    resizeOptions: { background: BRAND },
  },
  apple: {
    sizes: [180],
    resizeOptions: { background: BRAND },
  },
};

export default defineConfig({
  headLinkOptions: {
    preset: "2023",
  },
  preset,
  images: "public/favicon.svg",
});
