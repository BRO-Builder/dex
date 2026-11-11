import { InMemorySigner } from "@taquito/signer";
import { TezosToolkit } from "@taquito/taquito";
import type { Config } from "./config.js";

const REQUEST_TIMEOUT_MS = 30_000;

export type OracleResult =
  /** The on-chain price is younger than the threshold; nothing was sent. */
  | { status: "skipped"; reason: string; onchain_age_seconds: number }
  /** A recent update may not be indexed yet; wait for `op_hash` instead of sending another. */
  | { status: "pending"; reason: string; op_hash: string }
  /** `update_price` was injected, not yet included in a block. */
  | { status: "pushed"; reason: string; op_hash: string; price: string; bro_usd: number; xtz_usd: number }
  /** DRY_RUN=1: this is what would have been sent. */
  | { status: "dry_run"; reason: string; price: string; bro_usd: number; xtz_usd: number };

async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Request to ${new URL(url).host} failed (HTTP ${response.status}): ${body}`);
  }
  return response.json();
}

/**
 * Sends BROMarketAssistant.update_price on demand.
 *
 * Age is the only rule: a request sends a transaction only when the on-chain
 * price is unset or at least `minPriceAgeSeconds` old, so transactions can never
 * outpace 24h / threshold per day however often the public endpoint is called.
 *
 * Price = BRODex `get_price_token_to_xtz(1 BRO)` × Coinbase XTZ/USD, in the
 * ledger's unit: BRO base units per USD cent × 10^6. Keep it in sync with
 * server/oracle/src/Oracle.php.
 */
export class Oracle {
  private readonly tezos: TezosToolkit;
  private inFlight: Promise<OracleResult> | null = null;
  /** Last `price_updated_at` read from chain (ms). Saves upstream reads while it's still fresh. */
  private updatedAt: number | null = null;
  private lastPush: { at: number; opHash: string } | null = null;

  constructor(private readonly config: Config, signer: InMemorySigner) {
    this.tezos = new TezosToolkit(config.rpcUrl);
    this.tezos.setProvider({ signer });
  }

  /** Requests that arrive during a run share its result, so one wallet counter is ever in use. */
  run(): Promise<OracleResult> {
    this.inFlight ??= this.evaluate().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async evaluate(): Promise<OracleResult> {
    const threshold = this.config.minPriceAgeSeconds;

    if (this.lastPush && Date.now() - this.lastPush.at < this.config.pendingSeconds * 1000) {
      return { status: "pending", reason: "An update was just sent.", op_hash: this.lastPush.opHash };
    }
    const cachedAge = this.updatedAt === null ? null : Math.floor((Date.now() - this.updatedAt) / 1000);
    if (cachedAge !== null && cachedAge < threshold) {
      return { status: "skipped", reason: `Updated ${cachedAge} s ago.`, onchain_age_seconds: cachedAge };
    }

    const market = await json(`${this.config.tzktUrl}/v1/contracts/${this.config.marketAddress}/storage`);
    const address = await this.tezos.signer.publicKeyHash();
    if (market.oracle !== address) {
      throw new Error(`The market assistant's oracle is ${market.oracle ?? "unknown"}, not this key's address ${address}.`);
    }
    if (Number(market.max_price_age) <= threshold) {
      throw new Error(`PRICE_MIN_AGE_SECONDS (${threshold}) must be below the market's max_price_age (${market.max_price_age}).`);
    }

    const updatedAt = Date.parse(market.price_updated_at);
    const age = Math.floor((Date.now() - updatedAt) / 1000);
    const unset = BigInt(market.price) === 0n;
    if (!unset && age < threshold) {
      this.updatedAt = updatedAt;
      return { status: "skipped", reason: `Updated ${age} s ago.`, onchain_age_seconds: age };
    }

    const reason = unset ? "No price on-chain yet." : `On-chain price is ${age} s old.`;
    const quote = await this.quote();
    if (this.config.dryRun) {
      return { status: "dry_run", reason, ...quote };
    }

    const contract = await this.tezos.contract.at(this.config.marketAddress);
    const operation = await contract.methodsObject.update_price!(quote.price).send();
    this.lastPush = { at: Date.now(), opHash: operation.hash };
    return { status: "pushed", reason, op_hash: operation.hash, ...quote };
  }

  private async quote() {
    const { tzktUrl, rpcUrl, dexAddress, coinbaseUrl } = this.config;
    const dex = await json(`${tzktUrl}/v1/contracts/${dexAddress}/storage`);
    const query = new URLSearchParams({ contract: dex.token_address, tokenId: String(dex.token_id), limit: "1" });
    const tokens = await json(`${tzktUrl}/v1/tokens?${query}`);
    const decimals = Number(tokens[0]?.metadata?.decimals ?? NaN);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new Error("BRO token decimals are unavailable from TzKT.");
    }

    const view = await json(`${rpcUrl}/chains/main/blocks/head/helpers/scripts/run_script_view`, {
      method: "POST",
      body: JSON.stringify({
        contract: dexAddress,
        view: "get_price_token_to_xtz",
        input: { int: `1${"0".repeat(decimals)}` },
        chain_id: await this.tezos.rpc.getChainId(),
        unparsing_mode: "Readable",
      }),
    });
    const mutez = Number(view?.data?.int ?? 0);

    const coinbase = await json(coinbaseUrl);
    const xtzUsd = Number(coinbase?.data?.amount ?? 0);

    const broUsd = mutez / 1e6 * xtzUsd;
    if (!(mutez > 0) || !(xtzUsd > 0) || !(broUsd > 0)) {
      throw new Error("Price inputs are unavailable (DEX quote or XTZ/USD is zero).");
    }
    // BRO base units per cent × 10^6 = 10^decimals × 10^6 / (broUsd × 100)
    const price = BigInt(Math.round(10 ** decimals * 10_000 / broUsd));
    if (price <= 0n) throw new Error("Computed price is zero.");
    return { price: price.toString(), bro_usd: broUsd, xtz_usd: xtzUsd };
  }
}
