// Minimal local stand-in for the private @higgsfield/quanta design-system
// package (not available outside the Higgsfield platform build). Provides
// just enough of the <NotFound> component API for __root.tsx. Swap for the
// real package if/when it's vendored.
import type { ReactNode } from "react";

export function NotFound({
  className,
  icon,
  title,
  subtitle,
  children,
}: {
  className?: string;
  icon?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={["flex flex-col items-center gap-3 text-center", className].filter(Boolean).join(" ")}>
      {icon}
      {title ? <h1 className="text-xl font-semibold">{title}</h1> : null}
      {subtitle ? <p className="text-q-text-secondary">{subtitle}</p> : null}
      {children}
    </div>
  );
}
