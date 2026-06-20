/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // surfaces
        base: "#05070A",
        elev: "#0A0E15",
        glass: "rgba(18, 24, 34, 0.55)",
        "glass-2": "rgba(20, 27, 38, 0.72)",
        "border-glass": "rgba(150, 170, 200, 0.10)",
        "border-glass-2": "rgba(150, 170, 200, 0.18)",
        // text
        primary: "#E6EDF5",
        secondary: "#8A99AD",
        muted: "#566678",
        // accents (Palantir cool)
        accent: "#34D2C3",
        "accent-blue": "#5B8DEF",
        amber: "#F5A623",
        // market semantics (Binance-exact)
        buy: "#0ECB81",
        sell: "#F6465D",
        "buy-bg": "rgba(14, 203, 129, 0.12)",
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
        glass: "12px",
      },
      boxShadow: {
        glass:
          "0 10px 30px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04)",
        "glass-2":
          "0 16px 44px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05)",
        "accent-glow": "0 0 0 1px rgba(52,210,195,0.35), 0 0 18px rgba(52,210,195,0.18)",
      },
      backdropBlur: {
        glass: "20px",
      },
      keyframes: {
        "pulse-dot": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.35", transform: "scale(0.82)" },
        },
        "flash-buy": {
          "0%": { backgroundColor: "rgba(14, 203, 129, 0.28)" },
          "100%": { backgroundColor: "rgba(14, 203, 129, 0)" },
        },
        "flash-sell": {
          "0%": { backgroundColor: "rgba(246, 70, 93, 0.28)" },
          "100%": { backgroundColor: "rgba(246, 70, 93, 0)" },
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
      },
      animation: {
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
        "flash-buy": "flash-buy 600ms ease-out",
        "flash-sell": "flash-sell 600ms ease-out",
        "slide-in": "slide-in 280ms ease-out",
        "fade-in": "fade-in 220ms ease-out",
      },
    },
  },
  plugins: [],
};
