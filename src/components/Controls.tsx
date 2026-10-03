import type { ReactNode } from "react";
import { useState } from "react";
import { useWallet } from "../shared/tezos";

export function LoadingButton({ loading, children, disabled, className = "", onClick }: {
  loading: boolean; children: ReactNode; disabled?: boolean; className?: string; onClick: () => void;
}) {
  return <button className={className} disabled={disabled || loading} aria-busy={loading} onClick={onClick}>
    {loading && <span className="spinner" aria-hidden="true" />}
    {loading ? "Processing..." : children}
  </button>;
}

export function WalletBar({ wallet }: { wallet: ReturnType<typeof useWallet> }) {
  const [loading, setLoading] = useState(false);
  async function toggle() {
    setLoading(true);
    try { await (wallet.address ? wallet.disconnect() : wallet.connect()); } finally { setLoading(false); }
  }
  return   <div className="wallet">
  <div className="wallet-left">
    <span className="network-label">{wallet.selected.label}</span>
    <span className="wallet-status">{wallet.address ? wallet.address : "Wallet not connected"}</span>
    </div>
    <LoadingButton className="connect" loading={loading} onClick={() => void toggle()}>{wallet.address ? "Disconnect" : "Connect Wallet"}</LoadingButton>
  </div>;
}
