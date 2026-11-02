export type Baker = {
  label: string;
  keyHash: string;
  logo?: string;
};

export const BAKERS_BY_NETWORK: Record<"mainnet" | "shadownet", Baker[]> = {
  mainnet: [
    {
      label: "BRO Builder LLC",
      keyHash: "tz3SWuUUY48j43ATzd1hpCy4X726PYR3fEXT",
      logo: "https://www.brobuilder.llc/images/nav-icon-baker.png"
    }
  ],
  shadownet: [
    {
      label: "BRO Builder LLC",
      keyHash: "tz3SWuUUY48j43ATzd1hpCy4X726PYR3fEXT",
      logo: "https://www.brobuilder.llc/images/nav-icon-baker.png"
    },
    {
      label: "Teztnets",
      keyHash: "tz1TnEtqDV9mZyts2pfMy6Jw1BTPs4LMjL8M"
    },
    {
      label: "TF Test Baker",
      keyHash: "tz3Q67aMz7gSMiQRcW729sXSfuMtkyAHYfqc"
    }
  ],
};

export function getBakers(network: string): Baker[] {
  return network === "mainnet" ? BAKERS_BY_NETWORK.mainnet : BAKERS_BY_NETWORK.shadownet;
}
