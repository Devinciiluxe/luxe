// Minimal local stand-in for the private @higgsfield/quanta design-system
// package (not available outside the Higgsfield platform build). Provides
// just enough of the `button()` class-name helper API for __root.tsx's
// not-found page. Swap for the real package if/when it's vendored.
type ButtonVariant = "primary" | "secondary" | "outline" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

export function button(
  opts: { variant?: ButtonVariant; size?: ButtonSize } = {},
  ...extra: (string | undefined)[]
): string {
  const { variant = "primary", size = "md" } = opts;
  const base = "inline-flex items-center justify-center rounded-md font-medium transition-colors";
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-q-text-primary text-q-background-primary hover:opacity-90",
    secondary: "bg-q-background-secondary text-q-text-primary hover:opacity-90",
    outline: "border border-q-text-primary text-q-text-primary",
    ghost: "text-q-text-primary hover:bg-q-background-secondary",
  };
  const sizes: Record<ButtonSize, string> = {
    sm: "h-8 px-3 text-sm",
    md: "h-10 px-4 text-sm",
    lg: "h-12 px-6 text-base",
  };
  return [base, variants[variant], sizes[size], ...extra].filter(Boolean).join(" ");
}
