import { fetchTokenMetadata, type TokenMetadata } from "./tokenMetadata";
import { isValidAddress } from "./tezos";
import { toBigInt } from "./units";

export type DexPool = {
  contractAddress: string;
  tokenAddress: string;
  tokenId: string;
  token: TokenMetadata;
  xtzPool: bigint;
  tokenPool: bigint;
  totalShares: bigint;
};

const COINBASE_URL = "https://api.coinbase.com/v2/prices/XTZ-USD/spot";

export async function fetchDexPool(api: string, address: string | undefined): Promise<DexPool> {
  if (!address || !isValidAddress(address)) {
    throw new Error("Set VITE_DEX_ADDRESS to a valid KT1 address.");
  }
  const response = await fetch(`${api}/v1/contracts/${address}/storage`);
  if (!response.ok) throw new Error(`DEX storage request failed (HTTP ${response.status}).`);
  const storage = await response.json();
  const tokenId = String(storage.token_id);
  const token = await fetchTokenMetadata(api, storage.token_address, tokenId);
  return {
    contractAddress: address,
    tokenAddress: storage.token_address,
    tokenId,
    token,
    xtzPool: toBigInt(storage.xtz_pool),
    tokenPool: toBigInt(storage.token_pool),
    totalShares: toBigInt(storage.total_shares),
  };
}

export async function fetchXtzUsd(): Promise<number> {
  const response = await fetch(COINBASE_URL);
  if (!response.ok) throw new Error(`Coinbase price request failed (HTTP ${response.status}).`);
  const price = await response.json();
  return Number(price.data?.amount);
}

export function poolRatio(pool: DexPool | null) {
  return pool && pool.xtzPool > 0n ? Number(pool.tokenPool) / 10 ** pool.token.decimals / (Number(pool.xtzPool) / 1e6) : null;
}

export function spotBroUsd(pool: DexPool | null, xtzUsd: number | null) {
  const ratio = poolRatio(pool);
  return ratio && xtzUsd !== null ? xtzUsd / ratio : null;
}
