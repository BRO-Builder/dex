import { validateContractAddress, ValidationResult } from "@taquito/utils";

/** Default endpoints per network; TEZOS_RPC_URL / TZKT_API_URL override them. */
const NETWORKS = {
  shadownet: { rpc: "https://rpc.tzkt.io/shadownet", tzkt: "https://api.shadownet.tzkt.io" },
  mainnet: { rpc: "https://rpc.tzkt.io/mainnet", tzkt: "https://api.tzkt.io" },
} as const;

export type Config = ReturnType<typeof loadConfig>;

function env(name: string) {
  return process.env[name]?.trim() || undefined;
}

function required(name: string) {
  const value = env(name);
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

function seconds(name: string, fallback: number) {
  const value = env(name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number.`);
  return Number(value);
}

function contract(name: string) {
  const value = required(name);
  if (validateContractAddress(value) !== ValidationResult.VALID) throw new Error(`${name} must be a KT1 address.`);
  return value;
}

export function loadConfig() {
  const network = (env("TEZOS_NETWORK") ?? "shadownet").toLowerCase();
  if (network !== "shadownet" && network !== "mainnet") {
    throw new Error(`TEZOS_NETWORK must be one of: ${Object.keys(NETWORKS).join(", ")}.`);
  }
  const endpoints = NETWORKS[network];
  return {
    network,
    secretKey: required("ORACLE_SECRET_KEY"),
    rpcUrl: (env("TEZOS_RPC_URL") ?? endpoints.rpc).replace(/\/+$/, ""),
    tzktUrl: (env("TZKT_API_URL") ?? endpoints.tzkt).replace(/\/+$/, ""),
    marketAddress: contract("MARKET_ADDRESS"),
    dexAddress: contract("DEX_ADDRESS"),
    coinbaseUrl: env("COINBASE_URL") ?? "https://api.coinbase.com/v2/prices/XTZ-USD/spot",
    minPriceAgeSeconds: seconds("PRICE_MIN_AGE_SECONDS", 900),
    pendingSeconds: seconds("PENDING_PUSH_SECONDS", 120),
    allowedOrigins: (env("ALLOWED_ORIGINS") ?? "https://dex.brobuilder.eidoriantan.com")
      .split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean),
    port: seconds("PORT", 3001),
    dryRun: env("DRY_RUN") === "1",
  };
}
