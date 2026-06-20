import type { ElementType, ReactNode } from "react";

type Elevation = 1 | 2 | 3;

interface GlassPanelProps {
  children: ReactNode;
  /**
   * 1 = base chrome (sidebar, status bar)
   * 2 = content panels (book, chart, ticket)
   * 3 = floating surfaces (dropdowns, modals) — strongest blur + border + shadow
   */
  elevation?: Elevation;
  /** hover brighten + faint amber edge + pointer */
  interactive?: boolean;
  /** render as a different element (default <section>) */
  as?: ElementType;
  className?: string;
  /** optional chrome header — kept for panels that want a built-in title row */
  title?: ReactNode;
  right?: ReactNode;
  /** flush the body padding (e.g. tables manage their own) */
  flush?: boolean;
}

const ELEV_CLASS: Record<Elevation, string> = {
  1: "glass glass-1",
  2: "glass-2",
  3: "glass-3",
};

/**
 * The pinned glass primitive (m1_5-ui-polish-contract §"GlassPanel API").
 * A refined, subtle frosted surface floating over the amber-tinted obsidian
 * field: backdrop blur + saturate, --glass-bg fill, a 1px gradient border, an
 * inner top highlight (--glass-hi), and a soft drop shadow that scales with
 * elevation. `interactive` adds a hover state (brighter bg + faint amber edge)
 * and a pointer cursor.
 */
export function GlassPanel({
  children,
  elevation = 2,
  interactive = false,
  as,
  className = "",
  title,
  right,
  flush = false,
}: GlassPanelProps) {
  const Tag = (as ?? "section") as ElementType;
  return (
    <Tag
      className={`relative flex min-h-0 flex-col overflow-hidden ${
        elevation === 3 ? "glass-base " : ""
      }${ELEV_CLASS[elevation]} ${
        interactive ? "glass-interactive" : ""
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
    </Tag>
  );
}
