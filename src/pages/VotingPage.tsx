import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ValidationResult, validateKeyHash } from "@taquito/utils";
import { AnimatedLogo } from "../components/AnimatedLogo";
import { LoadingButton, WalletBar } from "../components/Controls";
import { toBigInt } from "../shared/units";
import { isValidAddress, useWallet } from "../shared/tezos";

type TallyEntry = {
  baker: string;
  votes: bigint;
};

type VotingState = {
  delegate: string | null;
  quorumBps: bigint;
  totalShares: bigint;
  myShares: bigint;
  myVote: string | null;
  tally: TallyEntry[];
};

const EMPTY_STATE: VotingState = {
  delegate: null,
  quorumBps: 0n,
  totalShares: 0n,
  myShares: 0n,
  myVote: null,
  tally: [],
};

const DELEGATION_ADDRESS = import.meta.env.VITE_DELEGATION_ADDRESS as string | undefined;

function shortAddress(address: string | null) {
  return address ? `${address.slice(0, 7)}…${address.slice(-5)}` : "—";
}

function readOption(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "Some" in value && typeof value.Some === "string") {
    return value.Some;
  }
  return null;
}

function percentage(votes: bigint, total: bigint) {
  return total > 0n ? `${(Number(votes * 10000n / total) / 100).toFixed(2)}%` : "0.00%";
}

export default function VotingPage() {
  const wallet = useWallet();
  const [baker, setBaker] = useState("");
  const [state, setState] = useState(EMPTY_STATE);
  const [messages, setMessages] = useState(["Loading voting data..."]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [withdrawingVote, setWithdrawingVote] = useState(false);
  const [updatingDelegate, setUpdatingDelegate] = useState<string | null>(null);

  function log(message: string) {
    setMessages((current) => [...current.slice(-4), message]);
  }

  async function readTally() {
    if (!DELEGATION_ADDRESS) throw new Error("Set VITE_DELEGATION_ADDRESS to the delegation contract.");
    const response = await fetch(
      `${wallet.selected.api}/v1/contracts/${DELEGATION_ADDRESS}/bigmaps/tally/keys?active=true&limit=200`,
    );
    if (!response.ok) throw new Error(`TzKT returned HTTP ${response.status}.`);
    const entries: Array<{ key: string; value: string | number }> = await response.json();
    return entries
      .map((entry) => ({ baker: entry.key, votes: BigInt(String(entry.value)) }))
      .filter((entry) => entry.votes > 0n)
      .sort((left, right) => right.votes > left.votes ? 1 : right.votes < left.votes ? -1 : 0);
  }

  async function loadVotingData() {
    if (!DELEGATION_ADDRESS || !isValidAddress(DELEGATION_ADDRESS)) {
      throw new Error("Set VITE_DELEGATION_ADDRESS to a valid KT1 address.");
    }
    setLoading(true);
    try {
      const { toolkit } = await wallet.ensureWallet();
      const contract: any = await toolkit.wallet.at(DELEGATION_ADDRESS);
      const storage: any = await contract.storage();
      const tally = await readTally();
      const myShares = wallet.address ? toBigInt(await storage.shares.get(wallet.address) ?? 0) : 0n;
      const myVote = wallet.address ? readOption(await storage.votes.get(wallet.address)) : null;

      setState({
        delegate: readOption(storage.delegate),
        quorumBps: toBigInt(storage.quorum_bps),
        totalShares: toBigInt(storage.total_shares),
        myShares,
        myVote,
        tally,
      });
      log("Voting data updated.");
    } catch (error) {
      log(`Unable to load voting data: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadVotingData();
  }, [wallet.selected.api, wallet.address]);

  async function send(entrypoint: "vote" | "withdraw_vote" | "update_delegate", argument?: string) {
    if (!wallet.address) {
      log("Connect a wallet first.");
      return;
    }
    if (!DELEGATION_ADDRESS || !isValidAddress(DELEGATION_ADDRESS)) {
      log("Set VITE_DELEGATION_ADDRESS to a valid KT1 address.");
      return;
    }
    if (entrypoint === "vote") setVoting(true);
    if (entrypoint === "withdraw_vote") setWithdrawingVote(true);
    if (entrypoint === "update_delegate") setUpdatingDelegate(argument ?? null);

    try {
      const { toolkit } = await wallet.ensureWallet();
      const contract: any = await toolkit.wallet.at(DELEGATION_ADDRESS);
      const operation = argument === undefined
        ? await contract.methodsObject[entrypoint]().send()
        : await contract.methodsObject[entrypoint](argument).send();
      log(`Operation submitted: ${operation.opHash}`);
      await operation.confirmation();
      log(`${entrypoint} complete.`);
      await loadVotingData();
    } catch (error) {
      log(`${entrypoint} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (entrypoint === "vote") setVoting(false);
      if (entrypoint === "withdraw_vote") setWithdrawingVote(false);
      if (entrypoint === "update_delegate") setUpdatingDelegate(null);
    }
  }

  function submitVote() {
    const candidate = baker.trim();
    if (validateKeyHash(candidate) !== ValidationResult.VALID) {
      log("Enter a valid baker key hash (tz1, tz2, or tz3).");
      return;
    }
    void send("vote", candidate);
  }

  const currentVotes = state.tally.find((entry) => entry.baker === state.delegate)?.votes ?? 0n;

  return (
    <main className="wrap">
      <div className="brand">
        <AnimatedLogo />
        <h1 style={{ paddingTop: "10px" }}>BRO <span>Exchange</span></h1>
        <p style={{ marginTop: "0px" }}>View and manage DEX baker votes.</p>
      </div>
      <WalletBar wallet={wallet} />

      <div className="grid">
        <div className="card">
          <h2>Current Baker</h2>
          <div className="desc">The delegate currently selected by the voting vault.</div>
          <div className="liquidity">
            <div className="label">Current Delegate</div>
            <div className="address-value">{shortAddress(state.delegate)}</div>
            {state.delegate && <code className="address-full">{state.delegate}</code>}
          </div>
          <div className="poolrow"><span>Quorum</span><strong>{(Number(state.quorumBps) / 100).toFixed(2)}%</strong></div>
          <div className="poolrow"><span>Total LP Shares</span><strong>{state.totalShares.toString()}</strong></div>
          <LoadingButton className="primary mt-18" loading={loading} onClick={() => void loadVotingData()}>Refresh Voting Data</LoadingButton>
        </div>

        <div className="card">
          <h2>Your Vote</h2>
          <div className="desc">Your voting weight equals your synchronized LP shares.</div>
          <div className="poolrow"><span>Your LP Shares</span><strong>{wallet.address ? state.myShares.toString() : "Connect wallet"}</strong></div>
          <div className="poolrow"><span>Your Vote</span><strong>{state.myVote ? shortAddress(state.myVote) : wallet.address ? "No vote" : "—"}</strong></div>
          {state.myVote && <code className="address-full">{state.myVote}</code>}
          <label className="modal-label" htmlFor="voting-baker">Baker key hash</label>
          <input id="voting-baker" className="input baker-input" value={baker} onChange={(event) => setBaker(event.target.value)} placeholder="tz1..., tz2..., or tz3..." spellCheck={false} />
          <div className="modal-actions">
            <LoadingButton className="primary" loading={voting} disabled={!wallet.address || state.myShares === 0n} onClick={submitVote}>Vote</LoadingButton>
            <LoadingButton className="secondary" loading={withdrawingVote} disabled={!wallet.address || !state.myVote} onClick={() => void send("withdraw_vote")}>Remove Vote</LoadingButton>
          </div>
        </div>
      </div>

      <div className="card voting-tally">
        <h2>Votes per Baker</h2>
        <div className="desc">Current votes recorded in the delegation contract.</div>
        {state.tally.length === 0 && <div className="notice">No votes yet.</div>}
        {state.tally.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Baker</th><th>Shares</th><th>Share</th><th>Action</th></tr></thead>
              <tbody>
                {state.tally.map((entry) => {
                  const quorumMet = entry.votes * 10000n >= state.totalShares * state.quorumBps;
                  const canUpdate = Boolean(wallet.address) && entry.baker !== state.delegate && quorumMet && entry.votes > currentVotes;
                  return (
                    <tr key={entry.baker}>
                      <td>
                        <code title={entry.baker}>{shortAddress(entry.baker)}</code>
                        {entry.baker === state.delegate && <span className="tag ok">delegate</span>}
                        {entry.baker === state.myVote && <span className="tag warn">your vote</span>}
                        {!quorumMet && <span className="tag">below quorum</span>}
                      </td>
                      <td>{entry.votes.toString()}</td>
                      <td>{percentage(entry.votes, state.totalShares)}</td>
                      <td>
                        <div className="row">
                          {wallet.address && state.myShares > 0n && entry.baker !== state.myVote &&
                            <LoadingButton className="secondary" loading={voting} onClick={() => void send("vote", entry.baker)}>Vote</LoadingButton>}
                          {canUpdate &&
                            <LoadingButton loading={updatingDelegate === entry.baker} onClick={() => void send("update_delegate", entry.baker)}>Make Delegate</LoadingButton>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="notice">A baker needs quorum and more votes than the current delegate to become the delegate.</div>
      </div>

      <div className="status">{messages.join("\n")}</div>
    </main>
  );
}
