export type Baker = {
  label: string;
  keyHash: string;
};

export const BAKERS_BY_NETWORK: Record<"mainnet" | "shadownet", Baker[]> = {
  mainnet: [
    {
      label: "BRO Builder LLC",
      keyHash: "tz3SWuUUY48j43ATzd1hpCy4X726PYR3fEXT"
    }
  ],
  shadownet: [],
};

export function getBakers(network: string): Baker[] {
  return network === "mainnet" ? BAKERS_BY_NETWORK.mainnet : BAKERS_BY_NETWORK.shadownet;
}
