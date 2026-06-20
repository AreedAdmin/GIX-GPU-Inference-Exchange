// web/src/components/WalletMenu.tsx
// Agent 2 — premium glass wallet menu (M1.5 UI polish contract §WalletMenu).
//
// Two connection paths, ONE dropdown UI:
//   • Real wallet (testnet/live): dapp-kit — useWallets / useConnectWallet /
//     useCurrentAccount / useDisconnectWallet, balances via useSuiClientQuery('getBalance').
//   • Burner (demo / localnet): the existing store path (useGix → connectWallet /
//     account / balances / refreshBalances, backed by src/trade/burner.ts).
//
// Styling consumes ONLY the PINNED design tokens + the pinned GlassPanel(3) surface
// (see WalletMenu.css). No new colors; amber is brand/interactive, balances stay neutral,
// directional/danger stays red. index.css / TopBar / panels are NOT touched (Agent 1).

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  useConnectWallet,
  useCurrentAccount,
  useDisconnectWallet,
  useSuiClientContext,
  useSuiClientQuery,
  useWallets,
} from "@mysten/dapp-kit";
import type { WalletWithRequiredFeatures } from "@mysten/wallet-standard";
import { GlassPanel as RawGlassPanel } from "./GlassPanel";
import { useGix } from "../store";
import { loadChainConfig, type GixNetwork } from "../trade/config";
import { clearBurner } from "../trade/burner";
import "./WalletMenu.css";

const cfg = loadChainConfig();

// ── GlassPanel against the PINNED API ────────────────────────────────────────
// The contract pins `<GlassPanel elevation={1|2|3} interactive>`. Agent 1 owns
// GlassPanel.tsx and ships that signature at integration; we code against it now.
// The cast keeps `tsc` green while Agent 1's version may still expose the interim
// props — at integration the real props are a superset, so this stays valid and
// the dropdown gets the elevation-3 floating-surface glass for free.
interface PinnedGlassPanelProps {
  children: ReactNode;
  className?: string;
  elevation?: 1 | 2 | 3;
  interactive?: boolean;
  as?: keyof JSX.IntrinsicElements;
}
const GlassPanel = RawGlassPanel as unknown as ComponentType<PinnedGlassPanelProps>;

const USDC_DECIMALS = 6;

/** Network switcher options (contract: testnet / localnet). */
const NETWORKS: { id: GixNetwork; label: string }[] = [
  { id: "localnet", label: "Local" },
  { id: "testnet", label: "Testnet" },
];

function truncAddr(addr: string): string {
  // 0x12ab…cd34
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtUnits(base: bigint | number, decimals: number, dp: number): string {
  const n = typeof base === "bigint" ? Number(base) / 10 ** decimals : base;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Deterministic jazzicon-ish gradient avatar derived from the address. SVG, no deps. */
function Avatar({ address, large = false }: { address: string; large?: boolean }) {
  const { a, b, rot } = useMemo(() => {
    let h = 2166136261;
    for (let i = 0; i < address.length; i++) {
      h ^= address.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const hue1 = h % 360;
    const hue2 = (hue1 + 90 + ((h >> 8) % 120)) % 360;
    return {
      a: `hsl(${hue1} 70% 55%)`,
      b: `hsl(${hue2} 65% 45%)`,
      rot: h % 360,
    };
  }, [address]);
  const id = useId();
  return (
    <svg
      className={`wm-avatar${large ? " wm-avatar--lg" : ""}`}
      viewBox="0 0 32 32"
      aria-hidden
    >
      <defs>
        <linearGradient id={`g${id}`} gradientTransform={`rotate(${rot} .5 .5)`}>
          <stop offset="0%" stopColor={a} />
          <stop offset="100%" stopColor={b} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="16" fill={`url(#g${id})`} />
      <circle cx={(rot % 24) + 4} cy={((rot >> 3) % 24) + 4} r="7" fill={b} opacity="0.55" />
    </svg>
  );
}

// ── small inline icons (stroke = currentColor) ───────────────────────────────
function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {d.split("|").map((seg, i) => (
        <path key={i} d={seg} />
      ))}
    </svg>
  );
}
const ICONS = {
  copy: "M9 9h11v11H9z|M5 15V4h11",
  check: "M5 12l4.5 4.5L19 7",
  external: "M14 4h6v6|M20 4l-9 9|M19 13v6H5V5h6",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4|M16 17l5-5-5-5|M21 12H9",
  caret: "M6 9l6 6 6-6",
  plug: "M9 7V3|M15 7V3|M6 11h12v3a6 6 0 0 1-12 0z|M12 20v2",
  spark: "M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4|M21 4v5h-5",
};

/** Suiscan account URL for the active network. */
function suiscanUrl(network: string, addr: string): string {
  const net = network === "localnet" ? "testnet" : network; // localnet has no scan; degrade
  return `https://suiscan.xyz/${net}/account/${addr}`;
}

// ─────────────────────────────────────────────────────────────────────────────

export function WalletMenu() {
  const isRealWalletPath = cfg.network !== "localnet";
  return isRealWalletPath ? <RealWalletMenu /> : <BurnerWalletMenu />;
}

// ── REAL WALLET (dapp-kit) ───────────────────────────────────────────────────
function RealWalletMenu() {
  const account = useCurrentAccount();
  const wallets = useWallets();
  const { mutate: connect, isPending: connecting } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();
  const ctx = useSuiClientContext();

  // Burner is still offered as a demo entry even on the real path.
  const { connectWallet: connectBurner, account: burnerAccount } = useGix();

  const address = account?.address ?? burnerAccount?.address ?? null;

  // dapp-kit balances (refetched when the dropdown opens — see Dropdown.onOpen).
  const usdcType = cfg.usdcType;
  const creditType = cfg.market.creditType;
  const queryEnabled = !!account?.address;

  const suiQ = useSuiClientQuery(
    "getBalance",
    { owner: account?.address ?? "", coinType: "0x2::sui::SUI" },
    { enabled: queryEnabled },
  );
  const usdcQ = useSuiClientQuery(
    "getBalance",
    { owner: account?.address ?? "", coinType: usdcType },
    { enabled: queryEnabled && !!usdcType },
  );
  const creditQ = useSuiClientQuery(
    "getBalance",
    { owner: account?.address ?? "", coinType: creditType },
    { enabled: queryEnabled && !!creditType },
  );

  const refetchBalances = useCallback(() => {
    if (!queryEnabled) return;
    void suiQ.refetch();
    void usdcQ.refetch();
    void creditQ.refetch();
  }, [queryEnabled, suiQ, usdcQ, creditQ]);

  const balances: BalanceRow[] = [
    { sym: "SUI", amt: suiQ.data ? fmtUnits(BigInt(suiQ.data.totalBalance), 9, 4) : "—" },
    {
      sym: "MOCK_USDC",
      amt:
        usdcQ.data && !usdcQ.isError
          ? fmtUnits(BigInt(usdcQ.data.totalBalance), USDC_DECIMALS, 2)
          : undefined,
    },
    {
      sym: "Credit",
      amt:
        creditQ.data && !creditQ.isError
          ? fmtUnits(BigInt(creditQ.data.totalBalance), 0, 0)
          : undefined,
    },
  ];

  const headlineSui = suiQ.data ? fmtUnits(BigInt(suiQ.data.totalBalance), 9, 3) : "—";

  // ── disconnected: Connect CTA + wallet list ────────────────────────────────
  if (!address) {
    return (
      <Dropdown
        onOpen={() => {}}
        trigger={(toggle, open) => (
          <button
            type="button"
            className="wm-trigger wm-trigger--connect"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
            disabled={connecting}
          >
            <span className="wm-dot" />
            {connecting ? "Connecting…" : "Connect Wallet"}
            <span className="wm-caret">
              <Icon d={ICONS.caret} size={12} />
            </span>
          </button>
        )}
      >
        {(close) => (
          <ConnectList
            wallets={wallets}
            onPick={(w) => {
              connect({ wallet: w }, { onSettled: close });
            }}
            onBurner={() => {
              void connectBurner().finally(close);
            }}
          />
        )}
      </Dropdown>
    );
  }

  // ── connected ──────────────────────────────────────────────────────────────
  return (
    <Dropdown
      onOpen={refetchBalances}
      trigger={(toggle, open) => (
        <ConnectedPill
          address={address}
          sui={headlineSui}
          open={open}
          onClick={toggle}
        />
      )}
    >
      {(close) => (
        <ConnectedBody
          address={address}
          balances={balances}
          network={ctx.network}
          availableNetworks={Object.keys(ctx.networks)}
          onSelectNetwork={(n) => ctx.selectNetwork(n)}
          onRefresh={refetchBalances}
          onDisconnect={() => {
            disconnect();
            close();
          }}
        />
      )}
    </Dropdown>
  );
}

// ── BURNER (localnet demo) ───────────────────────────────────────────────────
function BurnerWalletMenu() {
  const { account, balances, connecting, connectWallet, refreshBalances } = useGix();
  const ctx = useSuiClientContext();
  const address = account?.address ?? null;

  const rows: BalanceRow[] = [
    { sym: "SUI", amt: balances ? fmtUnits(balances.sui, 0, 4) : "—" },
    { sym: "MOCK_USDC", amt: balances ? fmtUnits(balances.usdc, 0, 2) : undefined },
    {
      sym: "Credit",
      amt:
        balances?.creditsScu != null ? fmtUnits(balances.creditsScu, 0, 0) : undefined,
    },
  ];
  const headlineSui = balances ? fmtUnits(balances.sui, 0, 3) : "—";

  if (!address) {
    return (
      <Dropdown
        onOpen={() => {}}
        trigger={(toggle, open) => (
          <button
            type="button"
            className="wm-trigger wm-trigger--connect"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
            disabled={connecting}
          >
            <span className="wm-dot" />
            {connecting ? "Connecting…" : "Connect Wallet"}
            <span className="wm-caret">
              <Icon d={ICONS.caret} size={12} />
            </span>
          </button>
        )}
      >
        {(close) => (
          <ConnectList
            wallets={[]}
            onBurner={() => {
              void connectWallet().finally(close);
            }}
          />
        )}
      </Dropdown>
    );
  }

  return (
    <Dropdown
      onOpen={() => void refreshBalances()}
      trigger={(toggle, open) => (
        <ConnectedPill address={address} sui={headlineSui} open={open} onClick={toggle} />
      )}
    >
      {(close) => (
        <ConnectedBody
          address={address}
          balances={rows}
          network={ctx.network}
          availableNetworks={Object.keys(ctx.networks)}
          onSelectNetwork={(n) => ctx.selectNetwork(n)}
          onRefresh={() => void refreshBalances()}
          isBurner
          onDisconnect={() => {
            clearBurner();
            close();
            // Hard refresh re-reads the (now absent) burner so the UI returns to the
            // Connect state without mutating the store from outside its own actions.
            window.location.reload();
          }}
        />
      )}
    </Dropdown>
  );
}

// ── shared building blocks ───────────────────────────────────────────────────

interface BalanceRow {
  sym: string;
  amt?: string;
}

function ConnectedPill({
  address,
  sui,
  open,
  onClick,
}: {
  address: string;
  sui: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="wm-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
      title={address}
    >
      <Avatar address={address} />
      <span className="wm-pill__addr">{truncAddr(address)}</span>
      <span className="wm-pill__sep" aria-hidden />
      <span className="wm-pill__bal">{sui} SUI</span>
      <span className="wm-caret">
        <Icon d={ICONS.caret} size={12} />
      </span>
    </button>
  );
}

function ConnectList({
  wallets,
  onPick,
  onBurner,
}: {
  wallets: WalletWithRequiredFeatures[];
  onPick?: (w: WalletWithRequiredFeatures) => void;
  onBurner: () => void;
}) {
  return (
    <div className="wm-panel" role="menu" aria-label="Connect a wallet">
      <div className="wm-section-label">Detected wallets</div>
      {wallets.length === 0 && (
        <div className="wm-row" aria-disabled style={{ cursor: "default" }}>
          <span className="wm-row__label wm-row__sub">No browser wallets detected</span>
        </div>
      )}
      {wallets.map((w) => (
        <button
          key={w.name}
          type="button"
          role="menuitem"
          className="wm-row"
          onClick={() => onPick?.(w)}
        >
          {w.icon ? (
            <img
              src={w.icon}
              alt=""
              width={18}
              height={18}
              style={{ borderRadius: 5, flex: "0 0 auto" }}
            />
          ) : (
            <span className="wm-row__icon">
              <Icon d={ICONS.plug} size={16} />
            </span>
          )}
          <span className="wm-row__label">{w.name}</span>
        </button>
      ))}
      <div className="wm-divider" />
      <button type="button" role="menuitem" className="wm-row" onClick={onBurner}>
        <span className="wm-row__icon">
          <Icon d={ICONS.spark} size={16} />
        </span>
        <span className="wm-row__label">Burner</span>
        <span className="wm-row__sub">demo</span>
      </button>
    </div>
  );
}

function ConnectedBody({
  address,
  balances,
  network,
  availableNetworks,
  onSelectNetwork,
  onRefresh,
  onDisconnect,
  isBurner = false,
}: {
  address: string;
  balances: BalanceRow[];
  network: string;
  availableNetworks: string[];
  onSelectNetwork: (n: string) => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  isBurner?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — noop */
    }
  }, [address]);

  const netOptions = NETWORKS.filter((n) => availableNetworks.includes(n.id));

  return (
    <div className="wm-panel" role="menu" aria-label="Wallet">
      {/* header: avatar + full address + copy */}
      <div className="wm-head">
        <Avatar address={address} large />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="wm-head__addr">{address}</div>
          <div className="wm-head__meta">
            {isBurner ? "Burner · demo signer" : "Connected wallet"}
          </div>
        </div>
        <button
          type="button"
          className={`wm-copy${copied ? " is-copied" : ""}`}
          onClick={copy}
          aria-label={copied ? "Address copied" : "Copy address"}
          title={copied ? "Copied" : "Copy address"}
        >
          <Icon d={copied ? ICONS.check : ICONS.copy} size={14} />
        </button>
      </div>

      <div className="wm-divider" />

      {/* network badge + switcher */}
      <div className="wm-netrow">
        <span className="wm-net-badge">
          <span className="wm-dot" />
          {network}
        </span>
        {netOptions.length > 1 && (
          <div className="wm-net-switch" role="group" aria-label="Switch network">
            {netOptions.map((n) => (
              <button
                key={n.id}
                type="button"
                className="wm-net-opt"
                aria-pressed={network === n.id}
                onClick={() => onSelectNetwork(n.id)}
              >
                {n.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="wm-divider" />

      {/* balances */}
      <div className="wm-section-label" style={{ display: "flex", alignItems: "center" }}>
        <span style={{ flex: 1 }}>Balances</span>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh balances"
          title="Refresh balances"
          style={{
            border: 0,
            background: "transparent",
            color: "var(--text-dim, #5c6b7a)",
            cursor: "pointer",
            display: "inline-flex",
            padding: 0,
          }}
        >
          <Icon d={ICONS.refresh} size={12} />
        </button>
      </div>
      {balances.map((b) => (
        <div className="wm-bal" key={b.sym}>
          <span className="wm-bal__sym">{b.sym}</span>
          <span className={`wm-bal__amt${b.amt == null ? " wm-bal__amt--muted" : ""}`}>
            {b.amt ?? "—"}
          </span>
        </div>
      ))}

      <div className="wm-divider" />

      {/* footer: suiscan + disconnect */}
      <div className="wm-foot">
        <a
          className="wm-row"
          role="menuitem"
          href={suiscanUrl(network, address)}
          target="_blank"
          rel="noreferrer"
        >
          <span className="wm-row__icon">
            <Icon d={ICONS.external} size={15} />
          </span>
          <span className="wm-row__label">View on Suiscan</span>
        </a>
        <button
          type="button"
          role="menuitem"
          className="wm-row wm-row--danger"
          onClick={onDisconnect}
        >
          <span className="wm-row__icon">
            <Icon d={ICONS.logout} size={15} />
          </span>
          <span className="wm-row__label">{isBurner ? "Reset burner" : "Disconnect"}</span>
        </button>
      </div>
    </div>
  );
}

// ── Dropdown shell: open/close anim, click-outside + Esc, focus + a11y ─────────
function Dropdown({
  trigger,
  children,
  onOpen,
}: {
  trigger: (toggle: () => void, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next) onOpen();
      return next;
    });
  }, [onOpen]);

  // click-outside + Esc
  useEffect(() => {
    if (!open) return;
    function onDocMouse(e: MouseEvent) {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        // return focus to the trigger
        const btn = anchorRef.current?.querySelector<HTMLButtonElement>(".wm-trigger");
        btn?.focus();
      }
    }
    document.addEventListener("mousedown", onDocMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // roving focus: move through menu items with Arrow keys
  const onPanelKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Tab") return;
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], .wm-copy, .wm-net-opt',
      ) ?? [],
    ).filter((el) => !el.hasAttribute("disabled"));
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Tab") return; // let natural tab order work
    e.preventDefault();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const nextIdx = idx < 0 ? 0 : (idx + dir + items.length) % items.length;
    items[nextIdx]?.focus();
  }, []);

  // focus first item when opening
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"], .wm-copy',
      );
      first?.focus();
    }, 20);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <div className="wm-anchor" ref={anchorRef}>
      {trigger(toggle, open)}
      {open && (
        <div
          className="wm-dropdown wm-dropdown--enter"
          ref={panelRef}
          onKeyDown={onPanelKeyDown}
        >
          <GlassPanel elevation={3} interactive className="wm-panel-surface">
            {children(close)}
          </GlassPanel>
        </div>
      )}
    </div>
  );
}
