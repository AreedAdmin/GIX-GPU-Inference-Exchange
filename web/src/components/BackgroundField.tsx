// Fixed, layered obsidian field: deep base + two faint radial glows (teal TL,
// blue BR) + a faint grid + subtle noise. Panels float above it (contract §1).

export function BackgroundField() {
  return (
    <div
      aria-hidden
      className="fixed inset-0 -z-10 overflow-hidden"
      style={{ background: "var(--bg-base)" }}
    >
      {/* teal glow, top-left */}
      <div
        className="absolute -left-[12%] -top-[14%] h-[55vmax] w-[55vmax] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgba(52,210,195,0.07), rgba(52,210,195,0) 72%)",
          filter: "blur(8px)",
        }}
      />
      {/* blue glow, bottom-right */}
      <div
        className="absolute -bottom-[16%] -right-[10%] h-[58vmax] w-[58vmax] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgba(91,141,239,0.06), rgba(91,141,239,0) 72%)",
          filter: "blur(8px)",
        }}
      />
      {/* faint grid */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage:
            "radial-gradient(ellipse 120% 100% at 50% 0%, #000 35%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 120% 100% at 50% 0%, #000 35%, transparent 100%)",
        }}
      />
      {/* subtle noise */}
      <div
        className="absolute inset-0 opacity-[0.025] mix-blend-soft-light"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
      {/* top vignette toward elevated tone */}
      <div
        className="absolute inset-x-0 top-0 h-40"
        style={{
          background: "linear-gradient(180deg, rgba(10,14,21,0.55), transparent)",
        }}
      />
    </div>
  );
}
