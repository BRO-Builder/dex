export type TokenMetadata = { symbol: string; decimals: number };

export async function fetchTokenMetadata(api: string, contract: string, tokenId: string): Promise<TokenMetadata> {
  const query = new URLSearchParams({ contract, tokenId, limit: "1" });
  const response = await fetch(`${api}/v1/tokens?${query}`);
  if (!response.ok) throw new Error(`Token metadata request failed (HTTP ${response.status}).`);
  const [token] = await response.json();
  const metadata = token?.metadata ?? {};
  const decimals = Number(metadata.decimals);
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error("Token decimals are unavailable.");
  return { symbol: metadata.symbol || "BRO", decimals };
}
