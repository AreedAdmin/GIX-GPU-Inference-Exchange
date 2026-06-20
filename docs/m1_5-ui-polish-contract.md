# M1.5 UI Polish — pinned contract (glassmorphism + wallet dropdown)

Shared source of truth for two parallel agents. **Amber/gold accent, refined-subtle
glass.** Both agents code against the pinned tokens + the `GlassPanel` API below so
their work composes at integration. Stack: React + Vite, plain CSS variables in
`src/index.css` (match the existing approach — no new CSS framework).

## Design tokens — PINNED (Agent 1 declares in `:root`, Agent 2 consumes)

```css
/* Backdrop */
--bg-0: #0A0D12;   /* deepest base */
--bg-1: #0E131A;   /* app surface */
--bg-2: #131A23;   /* raised */

/* Amber/gold accent — brand + interactive (NOT directional price) */
--accent:        #E2A23B;
--accent-strong: #F4B84E;
--accent-dim:    rgba(226,162,59,0.14);
--accent-glow:   rgba(226,162,59,0.34);

/* Glass recipe (refined & subtle) */
--glass-bg:       rgba(148,163,184,0.06);
--glass-border:   rgba(226,232,240,0.10);
--glass-hi:       rgba(255,255,255,0.06);  /* inner top highlight */
--glass-blur:     14px;
--glass-saturate: 130%;

/* Directional / financial — KEEP green-up, red-down (trader convention) */
--up:   #2EBD85;
--down: #F6465D;

/* Text */
--text-hi:  #E6EDF3;
--text-lo:  #9FB0C0;
--text-dim: #5C6B7A;

--radius: 12px;
--radius-sm: 8px;
```

**Color rule:** amber is the **brand/interactive** accent — primary CTAs (Buy/Connect),
active market row, focus rings, "last price" flash, sparklines, selection. Order-book
bid/ask and P&L stay **green(`--up`)/red(`--down`)** — do NOT recolor directional data amber.

## `GlassPanel` API — PINNED (Agent 1 implements, Agent 2 reuses)

```tsx
<GlassPanel elevation={1 | 2 | 3} interactive?={boolean} as?={keyof JSX.IntrinsicElements} className?={string}>
```
- **elevation 1** = base chrome (sidebar, status bar); **2** = content panels (book, chart,
  ticket); **3** = floating surfaces (dropdowns, modals) — strongest blur + border + shadow.
- Recipe per panel: `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))`,
  `background: var(--glass-bg)`, 1px gradient border, inner top highlight (`--glass-hi`),
  soft drop shadow scaling with elevation.
- `interactive` adds a hover state (slightly brighter bg + faint amber edge) and pointer.

## Background (Agent 1, `BackgroundField.tsx`)
Deep `--bg-0` base + a faint grid + a soft radial **amber-tinted** glow behind the panel
cluster, so the blur has something to refract. Subtle; no heavy motion (perf + investor-demo taste).

## File ownership — NO overlap

**Agent 1 — Glass design system + re-skin.** Owns and may edit:
`src/index.css`, `src/components/GlassPanel.tsx`, `src/components/BackgroundField.tsx`, and
re-skins `AppShell`, `TopBar`, `MarketsSidebar`, `OrderBook`, `OrderTicket`,
`PositionsPanel`, `PriceChart`, `RecentTrades`, `ResultViewer`, `StatusBar`, `ConnectionDot`.
- MUST keep `TopBar.tsx`'s `<WalletBar />` mount line intact.
- MUST NOT edit `WalletBar.tsx` or create `WalletMenu.tsx`.

**Agent 2 — Wallet dropdown.** Owns and may edit/create:
`src/components/WalletBar.tsx` (rewrite to render the new menu) and a new
`src/components/WalletMenu.tsx` (+ optional co-located `WalletMenu.css`).
- Reuses `GlassPanel elevation={3}` + the pinned CSS vars for the dropdown surface.
- MUST NOT edit `src/index.css`, `TopBar.tsx`, or any panel component.
- dapp-kit hooks: `useCurrentAccount`, `useWallets`, `useConnectWallet`,
  `useDisconnectWallet`, `useSuiClientQuery` (balances). Keep the existing burner option
  (`src/trade/burner.ts`). Wallet provider is `src/wallet/WalletProvider.tsx` (don't change).

### WalletMenu spec
- **Disconnected:** amber glass "Connect Wallet" button → `GlassPanel(3)` dropdown listing
  detected wallets + a **"Burner (demo)"** entry.
- **Connected:** pill = jazzicon avatar + truncated address + SUI balance → dropdown with:
  full address + **copy**, **network badge/switcher** (testnet/localnet), **balances**
  (SUI, MOCK_USDC, active market's Credit), **"View on Suiscan"**, **Disconnect**.
- Dropdown: open/close animation, click-outside + `Esc` to close, keyboard-navigable, a11y roles.

## Done = green
`npm run build` clean; dev server renders; all panels share the glass system; wallet
dropdown connects/disconnects (real wallet + burner), shows balances, copies address,
switches/opens explorer. Integration (mounting is already `<WalletBar/>` in TopBar) needs no code move.
