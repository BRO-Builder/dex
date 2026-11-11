export type TokenMetadata = { symbol: string; decimals: number; imageUrl?: string };

export async function fetchTokenMetadata(api: string, contract: string, tokenId: string): Promise<TokenMetadata> {
  const query = new URLSearchParams({ contract, tokenId, limit: "1" });
  const response = await fetch(`${api}/v1/tokens?${query}`);
  if (!response.ok) throw new Error(`Token metadata request failed (HTTP ${response.status}).`);
  const [token] = await response.json();
  const metadata = token?.metadata ?? {};
  const decimals = Number(metadata.decimals);
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error("Token decimals are unavailable.");
  return {
    symbol: metadata.symbol || "BRO",
    decimals,
    imageUrl: metadata.thumbnailUri || metadata.displayUri || undefined,
  };
}

export async function fetchTokenBalance(api: string, account: string, contract: string, tokenId: string): Promise<bigint> {
  const query = new URLSearchParams({
    account,
    "token.contract": contract,
    "token.tokenId": tokenId,
    limit: "1",
  });
  const response = await fetch(`${api}/v1/tokens/balances?${query}`);
  if (!response.ok) throw new Error(`Token balance request failed (HTTP ${response.status}).`);
  const [balance] = await response.json();
  return BigInt(balance?.balance ?? "0");
}
