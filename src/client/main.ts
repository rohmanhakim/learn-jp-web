import { mount } from "svelte";
import App from "./App.svelte";
import { registerSW } from "virtual:pwa-register";

// P2.1 (docs/Phase-002.md): register the precached app shell so the app
// boots offline. `registerType: "autoUpdate"` (vite.config.ts, D-1) means a
// new service worker takes over silently — no update-prompt UI. In dev the
// plugin's devOptions are disabled, so this is a no-op until built.
registerSW({ immediate: true });

const target = document.getElementById("app");
if (!target) {
  throw new Error("#app mount target missing from index.html");
}

const app = mount(App, { target });

export default app;
