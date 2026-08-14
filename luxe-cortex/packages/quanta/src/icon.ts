// Minimal local stand-in for the private @higgsfield/quanta design-system
// package. Type-only export used by src/lib/quanta-material-icons.ts.
import type { ComponentType, SVGProps } from "react";

export type IconGlyph = ComponentType<SVGProps<SVGSVGElement>>;
