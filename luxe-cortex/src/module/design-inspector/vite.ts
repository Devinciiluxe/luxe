// Minimal local stand-in for the Higgsfield-platform-only "design inspector"
// dev tooling (visual click-to-edit overlay in the platform's builder UI).
// Not present in either source app export and only relevant inside the
// Higgsfield platform itself, so this is a no-op stub: it lets vite.config.ts
// import successfully and disables the feature (HF_DESIGN_INSPECTOR mode).
import type { Plugin } from "vite";

export function higgsfieldDesignInspectorVitePlugin(_enabled: boolean): Plugin {
  return { name: "higgsfield-design-inspector-stub" };
}

export function higgsfieldDesignSourceBabelPlugin() {
  return { visitor: {} };
}
