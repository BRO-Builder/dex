import { useEffect, useMemo, useState } from "react";
import { AnimatedLogo } from "../components/AnimatedLogo";
import { LoadingButton, WalletBar } from "../components/Controls";
import { getBakers } from "../shared/bakers";
import { fetchTokenBalance, fetchTokenMetadata, type TokenMetadata } from "../shared/tokenMetadata";
import { formatUnits, parseUnits, toBigInt } from "../shared/units";
import { isValidAddress, useWallet } from "../shared/tezos";
import { ValidationResult, validateKeyHash } from "@taquito/utils";

type Pool = {
  contractAddress: string;
  tokenAddress: string;
  tokenId: string;
  token: TokenMetadata;
  xtzPool: bigint;
  tokenPool: bigint;
  totalShares: bigint;
};

type Direction = "xtz-bro" | "bro-xtz";

const DEX_ADDRESS = import.meta.env.VITE_DEX_ADDRESS as string | undefined;
const DELEGATION_ADDRESS = import.meta.env.VITE_DELEGATION_ADDRESS as string | undefined;
const COINBASE_URL = "https://api.coinbase.com/v2/prices/XTZ-USD/spot";
const XTZ_LOGO_URL = "https://services.tzkt.io/v1/avatars-dark/tz3UQN6nBQHofmgQ3pZannhiYE2CT7TEZFim";

function money(value: number | null, digits = 2) {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function number(value: number | null, digits = 4) {
  return value === null || !Number.isFinite(value) ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function calculateOutput(pool: Pool, amount: bigint, direction: Direction) {
  const input = direction === "xtz-bro" ? pool.xtzPool : pool.tokenPool;
  const output = direction === "xtz-bro" ? pool.tokenPool : pool.xtzPool;
  if (amount <= 0n || input <= 0n || output <= 0n) return 0n;
  return output - (input * output) / (input + amount);
}

export default function DexPage() {
  const wallet = useWallet();
  const [pool, setPool] = useState<Pool | null>(null);
  const [balances, setBalances] = useState<{ xtz: bigint | null; token: bigint | null }>({ xtz: null, token: null });
  const [xtzUsd, setXtzUsd] = useState<number | null>(null);
  const [direction, setDirection] = useState<Direction>("xtz-bro");
  const [tab, setTab] = useState<"swap" | "liquidity">("swap");
  const [pay, setPay] = useState("");
  const [activePreset, setActivePreset] = useState<number | null>(null);
  const [xtzIn, setXtzIn] = useState("");
  const [activeLiquidityPreset, setActiveLiquidityPreset] = useState<number | null>(null);
  const [selectedBaker, setSelectedBaker] = useState("");
  const [customBaker, setCustomBaker] = useState("");
  const [bakerModalOpen, setBakerModalOpen] = useState(false);
  const [slippage, setSlippage] = useState("1");
  const [messages, setMessages] = useState(["Loading pool data..."]);
  const [loading, setLoading] = useState(true);
  const [swapping, setSwapping] = useState(false);
  const [addingLiquidity, setAddingLiquidity] = useState(false);
  const [authorizing, setAuthorizing] = useState(true);
  const [transaction, setTransaction] = useState<{ hash: string; url: string } | null>(null);

  function log(message: string) {
    setMessages((current) => [...current.slice(-4), message]);
  }

  async function loadData() {
    if (!DEX_ADDRESS || !isValidAddress(DEX_ADDRESS)) {
      throw new Error("Set VITE_DEX_ADDRESS to a valid KT1 address.");
    }
    const [storageResponse, priceResponse] = await Promise.all([
      fetch(`${wallet.selected.api}/v1/contracts/${DEX_ADDRESS}/storage`),
      fetch(COINBASE_URL),
    ]);
    if (!storageResponse.ok) throw new Error(`DEX storage request failed (HTTP ${storageResponse.status}).`);
    if (!priceResponse.ok) throw new Error(`Coinbase price request failed (HTTP ${priceResponse.status}).`);
    const storage = await storageResponse.json();
    const price = await priceResponse.json();
    const tokenId = String(storage.token_id);
    const token = await fetchTokenMetadata(wallet.selected.api, storage.token_address, tokenId);
    setPool({
      contractAddress: DEX_ADDRESS,
      tokenAddress: storage.token_address,
      tokenId,
      token,
      xtzPool: toBigInt(storage.xtz_pool),
      tokenPool: toBigInt(storage.token_pool),
      totalShares: toBigInt(storage.total_shares),
    });
    setXtzUsd(Number(price.data?.amount));
    setMessages(["Pool data updated."]);
  }

  async function loadBalances() {
    if (!wallet.address || !pool) {
      setBalances({ xtz: null, token: null });
      return;
    }
    const { toolkit } = await wallet.ensureWallet();
    const [xtz, token] = await Promise.all([
      toolkit.tz.getBalance(wallet.address).then(toBigInt),
      fetchTokenBalance(wallet.selected.api, wallet.address, pool.tokenAddress, pool.tokenId),
    ]);
    setBalances({ xtz, token });
  }

  useEffect(() => {
    setLoading(true);
    void loadData()
      .catch((error) => log(`Unable to load pool: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => setLoading(false));
  }, [wallet.selected.api]);

  useEffect(() => {
    void loadBalances().catch((error) => {
      setBalances({ xtz: null, token: null });
      log(`Unable to load wallet balances: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [wallet.address, pool?.tokenAddress, pool?.tokenId, wallet.selected.api]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadData().catch((error) => log(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 60000);
    return () => window.clearInterval(interval);
  }, [wallet.selected.api]);

  const slippagePercent = Math.max(0, Math.min(50, Number(slippage) || 0));
  const directionDecimals = direction === "xtz-bro" ? 6 : pool?.token.decimals ?? 0;
  const outputDecimals = direction === "xtz-bro" ? pool?.token.decimals ?? 0 : 6;
  const amountIn = pool ? parseUnits(pay, directionDecimals) : null;
  const output = pool && amountIn ? calculateOutput(pool, amountIn, direction) : 0n;
  const minimum = output * BigInt(Math.round((100 - slippagePercent) * 100)) / 10000n;
  const ratio = pool && pool.xtzPool > 0n ? Number(pool.tokenPool) / 10 ** pool.token.decimals / (Number(pool.xtzPool) / 1e6) : null;
  const liquidityUsd = pool && xtzUsd !== null ? Number(pool.xtzPool) / 1e6 * xtzUsd * 2 : null;
  const broUsd = ratio && xtzUsd !== null ? xtzUsd / ratio : null;
  const priceImpact = pool && amountIn && output > 0n
    ? Math.max(0, 1 - Number(output) / Number((direction === "xtz-bro" ? pool.tokenPool : pool.xtzPool))) * 100
    : null;
  const liquidityToken = pool ? parseUnits(xtzIn, 6) : null;
  const matchingToken = pool && liquidityToken && pool.xtzPool > 0n ? pool.tokenPool * liquidityToken / pool.xtzPool : 0n;
  const sharePercent = pool && liquidityToken && pool.xtzPool + liquidityToken > 0n
    ? Number(liquidityToken) / Number(pool.xtzPool + liquidityToken) * 100 : null;

  async function swap() {
    if (!pool || !wallet.address || !amountIn || amountIn <= 0n) return;
    setSwapping(true);
    try {
      const { toolkit } = await wallet.ensureWallet();
      const dex: any = await toolkit.wallet.at(pool.contractAddress);
      let operation: any;
      if (direction === "xtz-bro") {
        operation = await dex.methodsObject.xtz_to_token(minimum.toString()).send({ amount: Number(amountIn), mutez: true });
      } else {
        const call = dex.methodsObject.token_to_xtz({
          token_amount: amountIn.toString(),
          min_xtz_out: minimum.toString(),
        });
        if (authorizing) {
          const token: any = await toolkit.wallet.at(pool.tokenAddress);
          const authorize = token.methodsObject.update_operators([{
            add_operator: {
              owner: wallet.address,
              operator: pool.contractAddress,
              token_id: pool.tokenId
            },
          }]);
          operation = await toolkit.wallet.batch().withContractCall(authorize).withContractCall(call).send();
        } else {
          operation = await call.send();
        }
      }
      log(`Swap submitted: ${operation.opHash}`);
      await operation.confirmation();
      setTransaction({
        hash: operation.opHash,
        url: `${wallet.selected.explorer}/${operation.opHash}`,
      });
      log("Swap complete.");
      setPay("");
      await loadData();
      await loadBalances();
    } catch (error) {
      log(`Swap failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSwapping(false);
    }
  }

  async function addLiquidity() {
    if (!pool || !wallet.address || !liquidityToken || liquidityToken <= 0n || matchingToken <= 0n) return;
    setAddingLiquidity(true);
    try {
      const { toolkit } = await wallet.ensureWallet();
      const dex: any = await toolkit.wallet.at(pool.contractAddress);
      const call = dex.methodsObject.add_liquidity("0");
      let operation: any;
      if (authorizing) {
        const token: any = await toolkit.wallet.at(pool.tokenAddress);
        const authorize = token.methodsObject.update_operators([{
          add_operator: {
            owner: wallet.address,
            operator: pool.contractAddress,
            token_id: pool.tokenId
          },
        }]);
        operation = await toolkit.wallet.batch()
          .withContractCall(authorize)
          .withTransfer(call.toTransferParams({ amount: Number(liquidityToken), mutez: true }))
          .send();
      } else {
        operation = await call.send({ amount: Number(liquidityToken), mutez: true });
      }
      log(`Liquidity submitted: ${operation.opHash}`);
      await operation.confirmation();
      setTransaction({
        hash: operation.opHash,
        url: `${wallet.selected.explorer}/${operation.opHash}`,
      });
      log("Liquidity added.");
      setXtzIn("");
      await loadData();
      await loadBalances();
      await voteForBaker();
    } catch (error) {
      log(`Liquidity failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAddingLiquidity(false);
    }
  }

  async function voteForBaker() {
    const baker = customBaker.trim() || selectedBaker;
    if (!baker) return;
    if (!DELEGATION_ADDRESS || !isValidAddress(DELEGATION_ADDRESS)) {
      log("Baker vote skipped: set VITE_DELEGATION_ADDRESS to a valid KT1 address.");
      return;
    }
    if (validateKeyHash(baker) !== ValidationResult.VALID) {
      log("Baker vote skipped: enter a valid Tezos key hash.");
      return;
    }
    if (!window.confirm(`Vote your liquidity shares for ${baker}?`)) {
      log("Baker vote skipped.");
      return;
    }

    try {
      const { toolkit } = await wallet.ensureWallet();
      const delegation: any = await toolkit.wallet.at(DELEGATION_ADDRESS);
      const operation = await delegation.methodsObject.vote(baker).send();
      log(`Baker vote submitted: ${operation.opHash}`);
      await operation.confirmation();
      log("Baker vote complete.");
    } catch (error) {
      log(`Baker vote failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const payToken = direction === "xtz-bro" ? "XTZ" : pool?.token.symbol ?? "BRO";
  const receiveToken = direction === "xtz-bro" ? pool?.token.symbol ?? "BRO" : "XTZ";
  const payBalance = direction === "xtz-bro" ? balances.xtz : balances.token;
  const receiveBalance = direction === "xtz-bro" ? balances.token : balances.xtz;
  const formatBalance = (value: bigint | null, decimals: number, symbol: string) =>
    value === null ? "—" : `${formatUnits(value, decimals, 6)} ${symbol}`;
  const currencyUnit = (symbol: string, imageUrl?: string) => (
    <div className="token">
      <img className="token-logo" src={imageUrl} alt="" aria-hidden="true" />
      {symbol}
    </div>
  );
  const bakers = getBakers(wallet.network);
  const setAmountPercent = (percent: number) => {
    if (payBalance === null) return;
    const feeReserve = direction === "xtz-bro" && percent === 100 ? 100000n : 0n;
    const available = payBalance > feeReserve ? payBalance - feeReserve : 0n;
    const amount = available * BigInt(percent) / 100n;
    setPay(amount > 0n ? formatUnits(amount, directionDecimals, 8) : "");
    setActivePreset(percent);
  };
  const setLiquidityAmountPercent = (percent: number) => {
    if (balances.xtz === null) return;
    const feeReserve = percent === 100 ? 100000n : 0n;
    const available = balances.xtz > feeReserve ? balances.xtz - feeReserve : 0n;
    const amount = available * BigInt(percent) / 100n;
    setXtzIn(amount > 0n ? formatUnits(amount, 6, 8) : "");
    setActiveLiquidityPreset(percent);
  };

  return <main className="wrap">
    <div className="brand">
      <AnimatedLogo />
      <h1 style={{ paddingTop: "10px" }}>BRO <span>Exchange</span></h1>
      <p style={{ marginTop: "0px" }}>Swap BRO Token or provide liquidity.</p>
    </div>
    <WalletBar wallet={wallet} />
    <div className="stats">
      <div className="stat">
        <div className="label">BRO Price</div>
        <div className="value">{money(broUsd, 5)}</div>
        <div className="sub">Pool spot price</div>
      </div>
      <div className="stat">
        <div className="label">Pool Ratio</div>
        <div className="value">{ratio ? `1 XTZ ≈ ${number(ratio, 4)} BRO` : "—"}</div>
        <div className="sub">Current reserve ratio</div>
      </div>
      <div className="stat">
        <div className="label">Total Liquidity</div>
        <div className="value">{money(liquidityUsd)}</div>
        <div className="sub">BRO / XTZ pool</div>
      </div>
    </div>
    <div className="grid">
      <div className="card">
        <div className="tabs">
          <button className={tab === "swap" ? "tab active" : "tab"} onClick={() => setTab("swap")}>SWAP</button>
          <button className={tab === "liquidity" ? "tab active" : "tab"} onClick={() => setTab("liquidity")}>LIQUIDITY</button>
        </div>

        { tab === "swap" && (
          <section>
            <h2>Swap {pool?.token.symbol ?? "BRO"}</h2>
            <div className="desc">Exchange {pool?.token.symbol ?? "BRO"} and XTZ using the current pool.</div>
            <div className="box">
              <div className="top">
                <span>You Pay</span>
                <span id="payBalance">Balance: {formatBalance(payBalance, directionDecimals, payToken)}</span>
              </div>
              <div className="row">
                <input className="input" value={pay} onChange={(event) => { setPay(event.target.value); setActivePreset(null); }} type="number" min="0" step="any" placeholder="0.00" />
                {currencyUnit(payToken, direction === "xtz-bro" ? XTZ_LOGO_URL : pool?.token.imageUrl)}
              </div>
            </div>

            <div className="amount-presets">
              {[25, 50, 75, 100].map((percent) => (
                <button
                  type="button"
                  className={activePreset === percent ? "amount-preset active" : "amount-preset"}
                  data-percent={percent}
                  disabled={!wallet.address || payBalance === null}
                  onClick={() => setAmountPercent(percent)}
                  key={percent}
                >
                  {percent === 100 ? "MAX" : `${percent}%`}
                </button>
              ))}
            </div>

            <button className="arrow" onClick={() => { setDirection(direction === "xtz-bro" ? "bro-xtz" : "xtz-bro"); setPay(""); setActivePreset(null); }}>↕</button>
            <div className="box">
              <div className="top">
                <span>You Receive</span>
                <span>Balance: {formatBalance(receiveBalance, outputDecimals, receiveToken)}</span>
              </div>
              <div className="row">
                <input className="input" readOnly value={output ? formatUnits(output, outputDecimals, 6) : ""} placeholder="0.00" />
                {currencyUnit(receiveToken, direction === "xtz-bro" ? pool?.token.imageUrl : XTZ_LOGO_URL)}
              </div>
            </div>
            <div className="details">
              <div className="detail">
                <span>Pool Price</span>
                <span>{ratio ? direction === "xtz-bro" ? `1 XTZ ≈ ${number(ratio, 6)} BRO` : `1 BRO ≈ ${number(1 / ratio, 8)} XTZ` : "—"}</span>
              </div>

              <div className="detail">
                <span>Price Impact</span>
                <span>{priceImpact === null ? "—" : `${priceImpact.toFixed(2)}%`}</span>
              </div>

              <div className="detail">
                <span>Minimum Received</span>
                <span>{output ? `${formatUnits(minimum, outputDecimals, 6)} ${receiveToken}` : "—"}</span>
              </div>

              <div className="detail">
                <span>Slippage</span>
                <span>{slippagePercent.toFixed(2)}%</span>
              </div>
              <div className="slip">
                { [0.5, 1, 2, 5].map((value) => (
                  <button key={value} className={slippage === String(value) ? "active" : ""} onClick={() => setSlippage(String(value))}>{value}%</button>
                )) }
                <input className="custom" value={slippage} onChange={(event) => setSlippage(event.target.value)} placeholder="Custom" />
              </div>
            </div>

            { direction === "bro-xtz" && (
              <label className="check">
                <input type="checkbox" checked={authorizing} onChange={(event) => setAuthorizing(event.target.checked)} />
                Authorize the DEX in the same transaction
              </label>
            ) }
            <LoadingButton className="primary mt-18" loading={swapping} disabled={loading || !pool || !wallet.address || !amountIn || amountIn <= 0n} onClick={() => void swap()}>{wallet.address ? "Swap" : "Connect Wallet to Swap"}</LoadingButton>
          </section>
        ) }

        { tab === "liquidity" && (
          <section>
            <h2>Add Liquidity</h2>
            <div className="desc">Supply {pool?.token.symbol ?? "BRO"} and XTZ to the pool at the current ratio.</div>
            <div className="liquidity">
              <div className="liqbig">{money(liquidityUsd)}</div>
              <div className="liqsub">Current pool liquidity</div>
            </div>

            <div className="box">
              <div className="top">
                <span>XTZ Amount</span>
                <span id="xtzBalance">Balance: {formatBalance(balances.xtz, 6, "XTZ")}</span>
              </div>

              <div className="row">
                <input className="input" value={xtzIn} onChange={(event) => { setXtzIn(event.target.value); setActiveLiquidityPreset(null); }} type="number" placeholder="0.00" />
                {currencyUnit("XTZ", XTZ_LOGO_URL)}
              </div>
            </div>

            <div className="amount-presets">
              {[25, 50, 75, 100].map((percent) => (
                <button
                  type="button"
                  className={activeLiquidityPreset === percent ? "amount-preset active" : "amount-preset"}
                  data-percent={percent}
                  disabled={!wallet.address || balances.xtz === null}
                  onClick={() => setLiquidityAmountPercent(percent)}
                  key={percent}
                >
                  {percent === 100 ? "MAX" : `${percent}%`}
                </button>
              ))}
            </div>

            <div className="box">
              <div className="top">
                <span>{pool?.token.symbol ?? "BRO"} Amount</span>
                <span id="broBalance">Balance: {formatBalance(balances.token, pool?.token.decimals ?? 0, pool?.token.symbol ?? "BRO")}</span>
              </div>
              <div className="row">
                <input className="input" readOnly value={matchingToken ? formatUnits(matchingToken, pool?.token.decimals ?? 0, 6) : ""} placeholder="0.00" />
                {currencyUnit(pool?.token.symbol ?? "BRO", pool?.token.imageUrl)}
              </div>
            </div>

            <div className="details">
              <div className="detail">
                <span>Pool Ratio</span>
                <span>{ratio ? `1 XTZ ≈ ${number(ratio, 6)} ${pool?.token.symbol}` : "—"}</span>
              </div>

              <div className="detail">
                <span>Estimated Pool Share</span>
                <span>{sharePercent === null ? "—" : `${sharePercent.toFixed(4)}%`}</span>
              </div>
            </div>

            <div className="baker-choice">
              <div>
                <div className="top">
                  <span>Vote for a baker</span>
                  <span>Optional</span>
                </div>
                <div className="baker-summary">
                  {customBaker || (selectedBaker && bakers.find((baker) => baker.keyHash === selectedBaker)?.label) || "No baker selected"}
                </div>
              </div>
              <button type="button" className="secondary" onClick={() => setBakerModalOpen(true)}>Choose baker</button>
            </div>

            <label className="check">
              <input type="checkbox" checked={authorizing} onChange={(event) => setAuthorizing(event.target.checked)} />
              Authorize the DEX in the same transaction
            </label>
            <LoadingButton className="primary mt-18" loading={addingLiquidity} disabled={loading || !pool || !wallet.address || !liquidityToken || liquidityToken <= 0n || matchingToken <= 0n} onClick={() => void addLiquidity()}>{wallet.address ? "Add Liquidity" : "Connect Wallet to Add Liquidity"}</LoadingButton>
          </section>
        ) }
      </div>
      <div className="card">
        <h2>{pool?.token.symbol ?? "BRO"} / XTZ Pool</h2>
        <div className="desc">Live information from the deployed BRO Builder pool.</div>
        <div className="poolrow">
          <span>Pair</span>
          <strong>{pool?.token.symbol ?? "BRO"} / XTZ</strong>
        </div>

        <div className="poolrow">
          <span>BRO Price</span>
          <strong>{money(broUsd, 5)}</strong>
        </div>

        <div className="poolrow">
          <span>1 XTZ</span>
          <strong>{ratio ? `${number(ratio, 6)} ${pool?.token.symbol}` : "—"}</strong>
        </div>

        <div className="poolrow">
          <span>1 BRO</span>
          <strong>{ratio ? `${number(1 / ratio, 8)} XTZ` : "—"}</strong>
        </div>

        <div className="poolrow">
          <span>XTZ Reserve</span>
          <strong>{pool ? `${formatUnits(pool.xtzPool, 6)} XTZ` : "—"}</strong>
        </div>

        <div className="poolrow">
          <span>{pool?.token.symbol ?? "BRO"} Reserve</span>
          <strong>{pool ? `${formatUnits(pool.tokenPool, pool.token.decimals)} ${pool.token.symbol}` : "—"}</strong>
        </div>

        <div className="liquidity">
          <div className="label">Total Liquidity</div>
          <div className="liqbig">{money(liquidityUsd)}</div>
          <div className="liqsub">Estimated USD value of both reserves.</div>
        </div>

        <div className="poolrow">
          <span>Price Source</span>
          <strong>Coinbase XTZ/USD</strong>
        </div>

        <div className="poolrow">
          <span>Updated</span>
          <strong>{loading ? "Loading..." : new Date().toLocaleTimeString()}</strong>
        </div>
      </div>
    </div>

    {bakerModalOpen && (
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setBakerModalOpen(false);
      }}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="baker-modal-title">
          <div className="modal-header">
            <div>
              <h2 id="baker-modal-title">Choose a baker</h2>
              <div className="desc">Your wallet will ask for a separate vote confirmation after liquidity is added.</div>
            </div>
            <button type="button" className="modal-close" aria-label="Close baker selection" onClick={() => setBakerModalOpen(false)}>×</button>
          </div>
          <label className="modal-label" htmlFor="baker-select">Configured baker</label>
          <select
            id="baker-select"
            className="baker-select"
            value={selectedBaker}
            onChange={(event) => {
              setSelectedBaker(event.target.value);
              setCustomBaker("");
            }}
          >
            <option value="">Select a configured baker</option>
            {bakers.map((baker) => (
              <option key={baker.keyHash} value={baker.keyHash}>{baker.label}</option>
            ))}
          </select>
          <div className="modal-or">or</div>
          <label className="modal-label" htmlFor="custom-baker">Custom baker key hash</label>
          <input
            id="custom-baker"
            className="input baker-input"
            value={customBaker}
            onChange={(event) => {
              setCustomBaker(event.target.value);
              setSelectedBaker("");
            }}
            placeholder="tz1, tz2, or tz3 key hash"
            spellCheck={false}
          />
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => {
              setSelectedBaker("");
              setCustomBaker("");
              setBakerModalOpen(false);
            }}>Clear</button>
            <button type="button" className="primary" onClick={() => setBakerModalOpen(false)}>Use this baker</button>
          </div>
        </div>
      </div>
    )}

    <div className="status">
      {messages.join("\n")}
      {transaction && (
        <div>
          <a href={transaction.url} target="_blank" rel="noreferrer">
            View transaction {transaction.hash}
          </a>
        </div>
      )}
    </div>
  </main>;
}
