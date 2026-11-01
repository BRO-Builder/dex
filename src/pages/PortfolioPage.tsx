import { useEffect, useState } from "react";
import { ConfigError, PoolShell, useOperations, withOperator } from "../components/PoolShell";
import {
  FUNDING_ADDRESS, PROJECTS_ADDRESS, STATUS_LABELS, amountDue, bpsToPct, defaultableAt, entitlement, fetchInvestments, formatBro, formatCents,
  formatDate, formatDateTime, isRefundable, parseCents, payoutFor, unclaimedApproved, usdToBro, usdToBroUp,
  type Investment, type Milestone, type Project,
} from "../shared/ledger";
import { useLedger } from "../shared/useLedger";
import { useMarket } from "../shared/useMarket";
import { useWallet } from "../shared/tezos";

function milestoneState(project: Project, ms: Milestone) {
  if (ms.claimed) return "Claimed";
  if (ms.approvedAt) return "Approved";
  if (ms.index === project.currentMilestone && ms.dueAt) return `Due ${formatDate(ms.dueAt)}`;
  return "Upcoming";
}

export default function PortfolioPage() {
  const wallet = useWallet();
  const ledger = useLedger(wallet);
  const market = useMarket(wallet, ledger.storage?.projects.market);
  const ops = useOperations(wallet);
  const [investments, setInvestments] = useState<Investment[] | null>(null);
  const [repayAmounts, setRepayAmounts] = useState<Record<number, string>>({});

  const decimals = market.decimals;
  const projects = ledger.projects ?? [];
  const byId = new Map(projects.map((project) => [project.id, project]));
  const myProjects = wallet.address ? projects.filter((project) => project.contractor === wallet.address) : [];
  const fundingPaused = ledger.storage?.funding.paused;
  const projectsPaused = ledger.storage?.projects.paused;
  const ledgerUnlinked = Boolean(market.market && market.market.storage.ledger !== PROJECTS_ADDRESS);
  const staleMessage = "The BRO price on the market assistant is out of date, so the contract would reject this. Try again after the oracle updates it.";

  /** Why a claim of these milestones would fail now, or null. The contractor gets BRO worth the
   * milestones' net USD; when that exceeds their escrow, the funding wallet pays the rest. */
  function claimBlocker(ready: Milestone[]) {
    if (!market.market || !market.price) return "The market assistant isn't loaded yet.";
    if (market.stale) return staleMessage;
    const need = usdToBro(ready.reduce((sum, ms) => sum + ms.netUsd, 0n), market.price);
    const shortfall = need - ready.reduce((sum, ms) => sum + ms.escrowBro, 0n);
    if (shortfall <= 0n) return null;
    if (ledgerUnlinked) return "The market assistant isn't linked to the projects contract, so it can't cover this claim's shortfall.";
    if (shortfall > market.market.reserve) {
      return `The BRO price has fallen since funding, and the funding wallet's balance (${formatBro(market.market.reserve, decimals)}) `
        + `can't cover the ${formatBro(shortfall, decimals)} shortfall yet.`;
    }
    return null;
  }

  async function loadInvestments() {
    if (!wallet.address || ledger.error) return setInvestments(null);
    try {
      setInvestments(await fetchInvestments(wallet.selected.api, wallet.address));
    } catch (error) {
      ops.showToast(`Couldn't load your investments: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  useEffect(() => {
    void loadInvestments();
  }, [wallet.address, wallet.selected.api, ledger.error]);

  function reload() {
    void ledger.reload();
    void loadInvestments();
  }

  function refund(project: Project, investment: Investment) {
    if (!FUNDING_ADDRESS) return;
    ops.setReview({
      title: `Refund #${project.id}`,
      text: `Returns your ${formatBro(investment.bro, decimals)} deposit. ${project.status === "Funding" ? "The project missed its funding deadline and will be marked failed." : ""}`,
      steps: [{ contract: FUNDING_ADDRESS, entrypoint: "refund", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`Refunded #${project.id}.`);
        reload();
      },
    });
  }

  function claimPayout(project: Project, investment: Investment) {
    if (!PROJECTS_ADDRESS) return;
    ops.setReview({
      title: `Claim payout from #${project.id}`,
      text: `Pays you ${formatBro(payoutFor(project, investment), decimals)}, your share of the settled pool.`,
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "claim_payout", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`Payout claimed from #${project.id}.`);
        reload();
      },
    });
  }

  function claimMilestones(project: Project) {
    if (!PROJECTS_ADDRESS) return;
    const ready = unclaimedApproved(project);
    const netUsd = ready.reduce((sum, ms) => sum + ms.netUsd, 0n);
    const blocker = claimBlocker(ready);
    if (blocker || !market.price) {
      ops.showToast(blocker ?? "The market assistant isn't loaded yet.");
      return;
    }
    ops.setReview({
      title: `Claim milestone${ready.length === 1 ? "" : "s"} on #${project.id}`,
      text: `Pays you BRO worth ${formatCents(netUsd)}`
        + ` (${formatBro(usdToBro(netUsd, market.price), decimals)} at the market assistant's current price)`
        + ` for ${ready.map((ms) => `M${ms.index + 1}`).join(", ")}. The BRO amount is fixed when the operation is included, at the price then.`,
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "claim_milestone", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`Claimed on #${project.id}.`);
        reload();
      },
    });
  }

  async function repay(project: Project) {
    const storage = ledger.storage?.projects;
    if (!PROJECTS_ADDRESS || !storage || !market.price) return;
    if (market.stale) {
      ops.showToast(staleMessage);
      return;
    }
    const owed = amountDue(project) - project.repaidUsd;
    const input = repayAmounts[project.id]?.trim() ?? "";
    const cents = parseCents(input);
    if (!cents || cents <= 0n) {
      ops.showToast("Enter a dollar amount to repay (up to 2 decimals).");
      return;
    }
    const usd = cents > owed ? owed : cents;
    const owner = await ops.requireAddress();
    if (!owner) return;
    ops.setReview({
      title: `Repay #${project.id}`,
      text: `Pays ${formatCents(usd)} of the ${formatCents(owed)} still owed`
        + `, ${formatBro(usdToBroUp(usd, market.price), decimals)} at the market assistant's current price. `
        + "The BRO amount is fixed at the price when the operation is included. The projects contract may move your BRO only for this one operation.",
      steps: withOperator({ address: storage.tokenAddress, tokenId: storage.tokenId }, owner, PROJECTS_ADDRESS, [
        { contract: PROJECTS_ADDRESS, entrypoint: "repay", params: { project_id: String(project.id), usd_cents: usd.toString() } },
      ]),
      onDone: () => {
        setRepayAmounts((current) => ({ ...current, [project.id]: "" }));
        ops.showToast(`Repaid ${formatCents(usd)} on #${project.id}.`);
        reload();
      },
    });
  }

  const now = new Date();

  return <PoolShell wallet={wallet} active="portfolio" title="Portfolio" subtitle="Your investments and the projects you're building.">
    <ConfigError message={ledger.error} />
    {fundingPaused && <ConfigError message="Funding is paused by its admin. Refunds are disabled for now." />}
    {projectsPaused && <ConfigError message="Projects are paused by their admin. Milestone claims, repayments and payouts are disabled for now." />}
    <ConfigError message={market.error} />
    {market.stale && <ConfigError message="The BRO price on the market assistant is out of date, so milestone claims and repayments are disabled until the oracle updates it." />}
    {ledgerUnlinked && <ConfigError message="The market assistant isn't linked to the projects contract, so claims and settlements that need the funding wallet will fail. The market admin can link it on the BRO Builder Web3 Portal's projects setup page." />}
    {!wallet.address && !ledger.error && (
      <div className="card"><div className="empty">Connect your wallet to see your investments and projects.</div></div>
    )}

    {wallet.address && <div className="grid">
      <div className="card">
        <h2>My Investments</h2>
        <div className="desc">You are owed your BRO plus each project's interest once it settles.</div>
        {investments === null && <div className="empty">Loading investments...</div>}
        {investments?.length === 0 && <div className="empty">You haven't invested yet. Browse open projects on the Build Pool page.</div>}
        {investments?.map((investment) => {
          const project = byId.get(investment.projectId);
          if (!project) return null;
          const settled = project.status === "Repaid" || project.status === "Defaulted";
          return (
            <div className="loan" key={investment.projectId}>
              <div className="loan-head">
                <div>
                  <h3>{project.title}</h3>
                  <div className="loc">#{project.id} · {project.site.city}, {project.site.state}</div>
                </div>
                <div className="loan-tags"><span className="loan-tag">{STATUS_LABELS[project.status]}</span></div>
              </div>
              <div className="detail"><span>Deposited</span><span>{formatBro(investment.bro, decimals)} ({formatCents(investment.usd)})</span></div>
              <div className="detail"><span>Interest</span><span>{bpsToPct(project.interestBps)}</span></div>
              {!settled && <div className="detail"><span>Owed at Settlement</span><span>{formatBro(entitlement(project, investment.bro), decimals)}</span></div>}
              {settled && <div className="detail"><span>Your Payout</span><span>{formatBro(payoutFor(project, investment), decimals)}</span></div>}
              {project.uncoveredBro > 0n && (
                <div className="detail"><span>Pool Shortfall</span><span>{formatBro(project.uncoveredBro, decimals)} not covered</span></div>
              )}
              {project.status === "Funding" && <div className="detail"><span>Funding Deadline</span><span>{formatDate(project.fundingDeadline)}</span></div>}
              <div className="actions-row">
                {isRefundable(project, now) && (
                  <button className="connect" type="button" disabled={fundingPaused} onClick={() => refund(project, investment)}>Refund</button>
                )}
                {settled && !investment.settledClaimed && (
                  <button className="connect" type="button" disabled={projectsPaused} onClick={() => claimPayout(project, investment)}>Claim Payout</button>
                )}
                {settled && investment.settledClaimed && <span className="muted">Payout claimed.</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>My Projects</h2>
        <div className="desc">Claim approved milestones, then repay the total in dollar installments.</div>
        {ledger.projects === null && !ledger.error && <div className="empty">Loading projects...</div>}
        {ledger.projects !== null && myProjects.length === 0 && <div className="empty">You haven't submitted a project from this wallet.</div>}
        {myProjects.map((project) => {
          const due = amountDue(project);
          const owed = due - project.repaidUsd;
          const ready = unclaimedApproved(project);
          const blocker = ready.length > 0 ? claimBlocker(ready) : null;
          const defaultAt = ledger.storage ? defaultableAt(project, ledger.storage.projects.graceDays) : null;
          const cents = parseCents(repayAmounts[project.id]?.trim() ?? "");
          return (
            <div className="loan" key={project.id}>
              <div className="loan-head">
                <div>
                  <h3>{project.title}</h3>
                  <div className="loc">#{project.id} · {project.site.city}, {project.site.state}</div>
                </div>
                <div className="loan-tags"><span className="loan-tag">{STATUS_LABELS[project.status]}</span></div>
              </div>
              <div className="detail"><span>Budget</span><span>{formatCents(project.budgetUsd)}</span></div>
              <div className="detail"><span>Funded</span><span>{formatCents(project.fundedUsd)} ({formatBro(project.fundedBro, decimals)})</span></div>
              {project.fundedAt && <div className="detail"><span>Funded On</span><span>{formatDate(project.fundedAt)}</span></div>}
              {defaultAt && (
                <div className="detail"><span>Default Possible After</span><span>{formatDateTime(defaultAt)}</span></div>
              )}

              {project.fundedAt && (
                <div className="table-wrap">
                  <table className="ms-table">
                    <thead><tr><th>#</th><th>Milestone</th><th>Amount</th><th>Status</th></tr></thead>
                    <tbody>
                      {project.milestones.map((ms) => (
                        <tr key={ms.index}>
                          <td>M{ms.index + 1}</td>
                          <td>{ms.description}</td>
                          <td>
                            {ms.approvedAt ? formatCents(ms.netUsd) : formatCents(ms.usd)}
                            {ms.lateFeeUsd > 0n && <div className="muted">−{formatCents(ms.lateFeeUsd)} late fee</div>}
                          </td>
                          <td>{milestoneState(project, ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {project.status === "Active" && ready.length > 0 && (
                <div className="actions-row">
                  <button className="connect" type="button" disabled={projectsPaused || Boolean(blocker)} onClick={() => claimMilestones(project)}>
                    Claim {formatCents(ready.reduce((sum, ms) => sum + ms.netUsd, 0n))}
                  </button>
                  {blocker && !market.stale && <span className="muted">{blocker}</span>}
                </div>
              )}

              {(project.status === "Repaying" || project.status === "Repaid") && (
                <>
                  <div className="detail"><span>Total Repayment</span><span>{formatCents(due)}</span></div>
                  <div className="detail"><span>Repaid</span><span>{formatCents(project.repaidUsd)} ({formatBro(project.repaidBro, decimals)})</span></div>
                  <div className="detail total"><span>Still Owed</span><span>{formatCents(owed)}</span></div>
                </>
              )}
              {project.status === "Repaying" && (
                <>
                  <div className="fundrow">
                    <input
                      className="field"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder={`Up to ${formatCents(owed)}`}
                      aria-label="Amount to repay in USD"
                      value={repayAmounts[project.id] ?? ""}
                      onChange={(event) => setRepayAmounts((current) => ({ ...current, [project.id]: event.target.value }))}
                    />
                    <div className="token">USD</div>
                    <button className="connect" type="button" disabled={projectsPaused || market.stale || !market.price} onClick={() => void repay(project)}>Repay</button>
                  </div>
                  <div className="est">
                    {cents && cents > 0n && market.price
                      ? `≈ ${formatBro(usdToBroUp(cents > owed ? owed : cents, market.price), decimals)} at the market assistant's current price`
                      : ""}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>}

    {ops.elements}
  </PoolShell>;
}
