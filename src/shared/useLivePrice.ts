import { useEffect, useState } from "react";
import { fetchDexPool, fetchXtzUsd, quoteBroUsd } from "./dex";
import { DEX_ADDRESS } from "./ledger";
import type { useWallet } from "./tezos";

const LIVE_REFRESH_MS = 60000;

/** The live BRO/USD price (BRODex quote × Coinbase XTZ/USD), refreshed every minute.
 * It's what the oracle would push now, so use it for estimates; the contracts still
 * price actions with the market assistant's on-chain price. */
export function useLivePrice(wallet: ReturnType<typeof useWallet>) {
  const [live, setLive] = useState<{ broUsd: number; decimals: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [pool, xtzUsd] = await Promise.all([fetchDexPool(wallet.selected.api, DEX_ADDRESS), fetchXtzUsd()]);
        const broUsd = quoteBroUsd(pool, xtzUsd);
        if (cancelled) return;
        setLive(broUsd ? { broUsd, decimals: pool.token.decimals } : null);
        setError(broUsd ? null : "The DEX quote or XTZ/USD price is zero.");
      } catch (error) {
        console.error("Live BRO price:", error);
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      }
    }
    void load();
    const interval = window.setInterval(() => void load(), LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [wallet.selected.api]);

  return {
    /** USD per BRO, or null while loading or unavailable */
    broUsd: live?.broUsd ?? null,
    /** The same price in the ledger unit (BRO base units per USD cent × 10^6) */
    price: live ? BigInt(Math.round(10 ** live.decimals * 10_000 / live.broUsd)) : null,
    error,
  };
}
