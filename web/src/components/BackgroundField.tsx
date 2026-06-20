// Fixed, layered field behind the glass cluster (contract §"Background"):
// deep --bg-0 base + a faint grid + a soft amber-tinted radial glow centered
// behind the panels so the backdrop blur has warm light to refract. Subtle;
// minimal motion (perf + investor-demo taste).

export function BackgroundField() {
  return (
    <div
      aria-hidden
      className="fixed inset-0 -z-10 overflow-hidden"
      style={{ background: "var(--bg-0)" }}
    >
      {/* base vertical wash toward the raised tone, keeps the field from going flat */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, var(--bg-1) 0%, var(--bg-0) 55%, var(--bg-0) 100%)",
        }}
      />

      {/* primary amber glow — broad, centered-high, behind the panel cluster */}
      <div
        className="absolute left-1/2 top-[-18%] h-[78vmax] w-[78vmax] -translate-x-1/2 rounded-full motion-safe:animate-glow-drift"
        style={{
          background:
            "radial-gradient(closest-side, rgba(226,162,59,0.10), rgba(226,162,59,0.03) 55%, rgba(226,162,59,0) 74%)",
          filter: "blur(10px)",
        }}
      />
      {/* secondary, deeper-gold pool low-left for warmth + depth */}
      <div
        className="absolute -bottom-[20%] -left-[8%] h-[52vmax] w-[52vmax] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgba(244,184,78,0.05), rgba(244,184,78,0) 72%)",
          filter: "blur(8px)",
        }}
      />

      {/* faint grid, masked to fade off the top */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px)",
          backgroundSize: "34px 34px",
          maskImage:
            "radial-gradient(ellipse 130% 105% at 50% 0%, #000 32%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 130% 105% at 50% 0%, #000 32%, transparent 100%)",
        }}
      />

      {/* very subtle noise to break up gradient banding */}
      <div
        className="absolute inset-0 opacity-[0.022] mix-blend-soft-light"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />

      {/* top vignette toward the raised tone */}
      <div
        className="absolute inset-x-0 top-0 h-40"
        style={{
          background:
            "linear-gradient(180deg, rgba(19,26,35,0.5), transparent)",
        }}
      />
    </div>
  );
}
