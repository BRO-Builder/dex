import { useEffect, useState } from "react";
import { fetchMarketStorage, fromPriceUnit, isPriceStale, type MarketStorage } from "./ledger";
import { fetchTokenBalance, fetchTokenMetadata, type TokenMetadata } from "./tokenMetadata";
import { isValidAddress, type useWallet } from "./tezos";

const MARKET_REFRESH_MS = 60000;

export type Market = {
  address: string;
  storage: MarketStorage;
  token: TokenMetadata;
  /** BRO held by the funding wallet to cover milestone shortfalls and settlements */
  reserve: bigint;
};

/** The market assistant the contracts price against: its on-chain BRO/USD price,
 * the BRO token's metadata and the funding wallet's BRO balance, refreshed every minute. */
export function useMarket(wallet: ReturnType<typeof useWallet>, address: string | undefined) {
  const [market, setMarket] = useState<Market | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  async function reload() {
    if (!address || !isValidAddress(address)) return;
    try {
      const storage = await fetchMarketStorage(wallet.selected.api, address);
      const [token, reserve] = await Promise.all([
        fetchTokenMetadata(wallet.selected.api, storage.tokenAddress, storage.tokenId),
        fetchTokenBalance(wallet.selected.api, storage.fundingWallet, storage.tokenAddress, storage.tokenId),
      ]);
      setMarket({ address, storage, token, reserve });
      setError(null);
    } catch (error) {
      console.error("Market assistant:", error);
      setError(`Couldn't load the market assistant: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setNow(new Date());
    }
  }

  useEffect(() => {
    void reload();
    const interval = window.setInterval(() => void reload(), MARKET_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [wallet.selected.api, address]);

  const price = market && market.storage.price > 0n ? market.storage.price : null;
  return {
    market,
    error,
    reload,
    decimals: market?.token.decimals,
    /** BRO base units per USD cent × 10^6, or null while unset */
    price,
    /** USD per BRO, for display */
    broUsd: price && market ? fromPriceUnit(price, market.token.decimals) : null,
    /** true when the contracts would reject the price (unset or older than max_price_age) */
    stale: market ? isPriceStale(market.storage, now) : false,
  };
}
