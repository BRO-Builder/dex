import { useEffect, useState } from "react";
import { fetchMarketStorage, fromPriceUnit, isPriceStale, type MarketStorage } from "./ledger";
import { ORACLE_URL, requestPriceUpdate } from "./oracle";
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

  /** The on-chain price to use for an action, updated first if the oracle says it's due.
   * A failed update only matters if the current price can't be used. Returns null
   * after reporting why through `notify`. */
  async function freshPrice(notify: (message: string) => void) {
    if (!address) return null;
    if (ORACLE_URL) notify("Checking the BRO price…");
    let failure: string | null = null;
    try {
      await requestPriceUpdate(wallet.selected.api);
    } catch (error) {
      console.error("Price update:", error);
      failure = error instanceof Error ? error.message : String(error);
    }
    try {
      const storage = await fetchMarketStorage(wallet.selected.api, address);
      void reload();
      if (!isPriceStale(storage)) return storage.price;
      notify(failure ?? "The BRO price on the market assistant is out of date, so the contract would reject this. Try again shortly.");
    } catch (error) {
      notify(`Couldn't load the BRO price: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  const price = market && market.storage.price > 0n ? market.storage.price : null;
  const stale = market ? isPriceStale(market.storage, now) : false;
  return {
    market,
    error,
    reload,
    freshPrice,
    decimals: market?.token.decimals,
    /** BRO base units per USD cent × 10^6, or null while unset */
    price,
    /** USD per BRO, for display */
    broUsd: price && market ? fromPriceUnit(price, market.token.decimals) : null,
    /** true when the contracts would reject the price (unset or older than max_price_age) */
    stale,
    /** true when a stale price can't be fixed from here, so price-based actions are disabled */
    blocked: stale && !ORACLE_URL,
  };
}
