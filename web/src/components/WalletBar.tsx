// web/src/components/WalletBar.tsx
// TopBar wallet affordance (M1.5 UI polish contract §WalletMenu). This is the mount
// point TopBar.tsx renders (`<WalletBar />`) — kept as a thin wrapper so Agent 1's
// TopBar line stays untouched while the premium glass dropdown lives in WalletMenu.tsx.
//
// All wallet UX (connect / burner / balances / network switch / copy / Suiscan /
// disconnect) is in WalletMenu, styled only via the pinned tokens + GlassPanel(3).

import { WalletMenu } from "./WalletMenu";

export function WalletBar() {
  return (
    <div className="gix-connect-slot flex items-center">
      <WalletMenu />
    </div>
  );
}
