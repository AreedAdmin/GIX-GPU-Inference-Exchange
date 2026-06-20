/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // All driven by the pinned :root tokens (single source of truth in
        // src/index.css). Tailwind utilities resolve to the same vars the inline
        // styles use, so the amber/gold re-skin is uniform.
        // surfaces
        base: "var(--bg-0)",
        elev: "var(--bg-1)",
        "bg-2": "var(--bg-2)",
        glass: "var(--glass-bg)",
        "glass-2": "var(--glass-bg)",
        "border-glass": "var(--glass-border)",
        "border-glass-2": "var(--accent-dim)",
        // text
        primary: "var(--text-hi)",
        secondary: "var(--text-lo)",
        muted: "var(--text-dim)",
        // amber/gold accent — brand + interactive (NOT directional price)
        accent: "var(--accent)",
        "accent-strong": "var(--accent-strong)",
        "accent-blue": "var(--text-lo)", // legacy alias → neutral (no competing blue)
        amber: "var(--accent)", // legacy alias → the amber accent
        // directional / financial — KEEP green-up, red-down
        buy: "var(--up)",
        sell: "var(--down)",
        "buy-bg": "rgba(46, 189, 133, 0.12)",
        "sell-bg": "rgba(246, 70, 93, 0.12)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        micro: ["10px", "14px"],
        small: ["11px", "15px"],
        base: ["13px", "18px"],
      },
      borderRadius: {
        glass: "var(--radius)",
        "glass-sm": "var(--radius-sm)",
      },
      boxShadow: {
        glass:
          "0 10px 30px rgba(0,0,0,0.45), inset 0 1px 0 var(--glass-hi)",
        "glass-2":
          "0 16px 44px rgba(0,0,0,0.55), inset 0 1px 0 var(--glass-hi)",
        "accent-glow":
          "0 0 0 1px var(--accent-glow), 0 0 18px var(--accent-dim)",
      },
      backdropBlur: {
        glass: "var(--glass-blur)",
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.35", transform: "scale(0.82)" },
        },
        "flash-buy": {
          "0%": { backgroundColor: "rgba(46, 189, 133, 0.26)" },
          "100%": { backgroundColor: "rgba(46, 189, 133, 0)" },
        },
        "flash-sell": {
          "0%": { backgroundColor: "rgba(246, 70, 93, 0.26)" },
          "100%": { backgroundColor: "rgba(246, 70, 93, 0)" },
        },
        // amber last-price / selection flash (brand accent, not directional)
        "flash-accent": {
          "0%": { backgroundColor: "rgba(226, 162, 59, 0.28)" },
          "100%": { backgroundColor: "rgba(226, 162, 59, 0)" },
        },
        "slide-in": {
          "0%": { opacity: "0", transform: "translateY(-6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        // very slow, faint breathing of the background amber glow
        "glow-drift": {
          "0%, 100%": { opacity: "0.85", transform: "translateX(-50%) scale(1)" },
          "50%": { opacity: "1", transform: "translateX(-50%) scale(1.05)" },
        },
      },
      animation: {
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
        "flash-buy": "flash-buy 600ms ease-out",
        "flash-sell": "flash-sell 600ms ease-out",
        "flash-accent": "flash-accent 600ms ease-out",
        "slide-in": "slide-in 280ms ease-out",
        "fade-in": "fade-in 220ms ease-out",
        "glow-drift": "glow-drift 18s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
