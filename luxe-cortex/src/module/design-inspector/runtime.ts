// Minimal local stand-in for the Higgsfield-platform-only "design inspector"
// runtime (dynamically imported only when __HF_DESIGN_INSPECTOR__ is true,
// i.e. `bun run dev:design`). No-op stub — see ./vite.ts for context.
export function installHiggsfieldDesignInspector(): void {}
