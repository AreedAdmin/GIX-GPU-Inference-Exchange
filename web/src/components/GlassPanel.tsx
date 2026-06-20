import type { ReactNode } from "react";

interface GlassPanelProps {
  children: ReactNode;
  className?: string;
  /** stronger surface (tickets, modals) — surface-glass-2 + border-glass-2 */
  strong?: boolean;
  /** flush the body padding (e.g. tables manage their own) */
  flush?: boolean;
  title?: ReactNode;
  right?: ReactNode;
}

/** The §1 glass primitive. A frosted panel floating over the obsidian field. */
export function GlassPanel({
  children,
  className = "",
  strong = false,
  flush = false,
  title,
  right,
}: GlassPanelProps) {
  return (
    <section
      className={`relative flex min-h-0 flex-col overflow-hidden ${
        strong ? "glass-2" : "glass"
      } ${className}`}
    >
      {(title || right) && (
        <header className="flex h-8 shrink-0 items-center justify-between border-b border-border-glass px-3">
          {typeof title === "string" ? (
            <span className="label-micro text-secondary">{title}</span>
          ) : (
            title
          )}
          {right}
        </header>
      )}
      <div className={`flex min-h-0 flex-1 flex-col ${flush ? "" : "p-3"}`}>
        {children}
      </div>
    </section>
  );
}
