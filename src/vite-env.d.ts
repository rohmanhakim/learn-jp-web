/// <reference types="vite/client" />

// No svelte-check in Phase 0 — declare Svelte components for plain tsc.
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<Record<string, unknown>>;
  export default component;
}
