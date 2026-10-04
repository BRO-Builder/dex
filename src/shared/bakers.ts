export type Baker = {
  label: string;
  keyHash: string;
};

export const BAKERS_BY_NETWORK: Record<"mainnet" | "shadownet", Baker[]> = {
  mainnet: [],
  shadownet: [],
};

export function getBakers(network: string): Baker[] {
  return network === "mainnet" ? BAKERS_BY_NETWORK.mainnet : BAKERS_BY_NETWORK.shadownet;
}
