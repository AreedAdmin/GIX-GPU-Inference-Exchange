import { GixProvider } from "./store";
import { AppShell } from "./components/AppShell";
import { WalletProvider } from "./wallet/WalletProvider";

export default function App() {
  return (
    <WalletProvider>
      <GixProvider>
        <AppShell />
      </GixProvider>
    </WalletProvider>
  );
}
