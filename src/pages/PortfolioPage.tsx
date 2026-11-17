import { useEffect, useState } from "react";
import { Lines, useUpkeep } from "../components/PoolParts";
import { ConfigError, PoolShell, useOperations, withOperator } from "../components/PoolShell";
import {
  FUNDING_ADDRESS, PROJECTS_ADDRESS, STATUS_LABELS, amountDue, bpsToPct, builderShare, claimable, dailyRatePct, defaultableAt, drawSplit,
  drawable, drawnUsd, fetchInvestments, formatBro, formatCents, formatDate, formatDateTime, hasUndrawn, holdTarget, interestAt,
  investorShare, isOpen, isRefundable, lateFeeStart, owed, parseCents, periodEnded, toTimestamp, usdToBro, usdToBroUp,
  type Investment, type Milestone, type Project,
} from "../shared/ledger";
import { formatUnits } from "../shared/units";
import { useLedger } from "../shared/useLedger";
import { useLivePrice } from "../shared/useLivePrice";
import { useMarket } from "../shared/useMarket";
import { useWallet } from "../shared/tezos";

function milestoneState(project: Project, ms: Milestone) {
  if (ms.drawnAt) return ms.usd > 0n && ms.outstandingUsd === 0n ? "Drawn, repaid" : `Drawn ${formatDate(ms.drawnAt)}`;
  if (project.released) return "Returned to investors";
  if (ms.approvedAt) return "Approved";
  if (project.status === "Active" && ms.index === project.currentMilestone && ms.dueAt) return `Due ${formatDate(ms.dueAt)}`;
  return "Upcoming";
}

export default function PortfolioPage() {
  const wallet = useWallet();
  const ledger = useLedger(wallet);
  const market = useMarket(wallet, ledger.storage?.projects.market);
  const live = useLivePrice(wallet);
  const ops = useOperations(wallet);
  const upkeep = useUpkeep({ ops, market, reload });
  const [investments, setInvestments] = useState<Investment[] | null>(null);
  const [repayAmounts, setRepayAmounts] = useState<Record<number, string>>({});
  const [endDates, setEndDates] = useState<Record<number, string>>({});

  const decimals = market.decimals;
  const projects = ledger.projects ?? [];
  const byId = new Map(projects.map((project) => [project.id, project]));
  const myProjects = wallet.address ? projects.filter((project) => project.contractor === wallet.address) : [];
  const fundingPaused = ledger.storage?.funding.paused;
  const projectsPaused = ledger.storage?.projects.paused;
  const ledgerUnlinked = Boolean(market.market && market.market.storage.ledger !== PROJECTS_ADDRESS);
  const staleMessage = "The BRO price on the market assistant is out of date, so the contract would reject this. Try again after the oracle updates it.";

  /** Why a draw would fail now, or null. The draw needs BRO worth the milestones' USD amount (the part
   * paid out plus the part kept for the interest hold); when that exceeds their escrow, the funding
   * wallet pays the rest. Hold payouts due at the same time can need a cover too; those aren't checked. */
  function drawBlocker(project: Project, ready: Milestone[], freshPrice?: bigint) {
    if (periodEnded(project)) return `The contract period ended on ${formatDateTime(project.endDate)}, so nothing more can be drawn.`;
    if (!market.market) return "The market assistant isn't loaded yet.";
    if (market.blocked) return staleMessage;
    // A stale price will be updated before drawing, so it can't tell yet whether there's a shortfall
    const price = freshPrice ?? (market.stale ? null : market.price);
    if (!price) return null;
    const split = drawSplit(project, ready.reduce((sum, ms) => sum + ms.usd, 0n));
    const need = usdToBro(split.paid, price) + usdToBro(split.withheld, price);
    const shortfall = need - ready.reduce((sum, ms) => sum + ms.escrowBro, 0n);
    if (shortfall <= 0n) return null;
    if (ledgerUnlinked) return "The market assistant isn't linked to the projects contract, so it can't cover this draw's shortfall.";
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
      text: `Pays you ${formatBro(claimable(project, investment), decimals)}: your share of what has been allotted to investors so far `
        + "(interest payouts, returned undrawn money and, once settled, your principal), less what you've already claimed.",
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "claim_payout", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`Payout claimed from #${project.id}.`);
        reload();
      },
    });
  }

  async function draw(project: Project) {
    if (!PROJECTS_ADDRESS) return;
    const ready = drawable(project);
    const cents = ready.reduce((sum, ms) => sum + ms.usd, 0n);
    const notReady = drawBlocker(project, ready);
    if (notReady) {
      ops.showToast(notReady);
      return;
    }
    const price = await market.freshPrice(ops.showToast);
    if (!price) return;
    const blocker = drawBlocker(project, ready, price);
    if (blocker) {
      ops.showToast(blocker);
      return;
    }
    const split = drawSplit(project, cents);
    ops.setReview({
      title: `Draw milestone${ready.length === 1 ? "" : "s"} on #${project.id}`,
      text: `Draws ${ready.map((ms) => `M${ms.index + 1}`).join(", ")}, worth ${formatCents(cents)}. `
        + (split.withheld > 0n
          ? `${formatCents(split.withheld)} is withheld for the interest hold (${formatCents(project.holdUsd)} of ${formatCents(holdTarget(project))} held so far), so you receive ${formatCents(split.paid)}`
          : `The interest hold is complete, so you receive all ${formatCents(cents)}`)
        + ` (${formatBro(usdToBro(split.paid, price), decimals)} at the market assistant's current price). `
        + `Interest at ${bpsToPct(project.monthlyRateBps)} a month (${dailyRatePct(project.monthlyRateBps)} a day, partial days in full) runs on the drawn ${formatCents(cents)} from now until repaid. `
        + "The BRO amount is fixed at the price when the operation is included.",
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "claim_milestone", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`Drew on #${project.id}.`);
        reload();
      },
    });
  }

  async function repay(project: Project) {
    const storage = ledger.storage?.projects;
    if (!PROJECTS_ADDRESS || !storage || !market.market) return;
    if (market.blocked) {
      ops.showToast(staleMessage);
      return;
    }
    const debt = owed(project, storage.graceDays);
    let usd = 0n;
    if (debt.due > 0n) {
      const cents = parseCents(repayAmounts[project.id]?.trim() ?? "");
      if (!cents || cents <= 0n) {
        ops.showToast("Enter a dollar amount to repay (up to 2 decimals).");
        return;
      }
      usd = cents > debt.due ? debt.due : cents;
    }
    const owner = await ops.requireAddress();
    if (!owner) return;
    const price = await market.freshPrice(ops.showToast);
    if (!price) return;
    const settles = usd >= debt.due;
    const text = (debt.due === 0n
      ? "Nothing is owed (the interest hold covers the interest so far), so this settles the project now. "
      : `Pays ${formatCents(usd)} of the ${formatCents(debt.due)} owed now`
        + (debt.fee > 0n ? ` (including a ${bpsToPct(debt.feeBps)} late fee on what is paid)` : "")
        + `, about ${formatBro(usdToBroUp(usd, price), decimals)} at the market assistant's current price. `
        + "It pays the late fee on it first, then interest above the hold, then principal (oldest draws first), which stops its interest. ")
      + (settles
        ? "Paying everything settles the project: the unused hold comes off the debt, the last interest payout runs to now"
          + (hasUndrawn(project) ? ", and undrawn money goes back to investors, so you can't draw any more" : "") + ". "
        : "")
      + "Interest grows daily, so a few cents can remain if a new day starts before this is included. "
      + "The projects contract may move your BRO only for this one operation.";
    ops.setReview({
      title: `Repay #${project.id}`,
      text,
      steps: withOperator({ address: storage.tokenAddress, tokenId: storage.tokenId }, owner, PROJECTS_ADDRESS, [
        { contract: PROJECTS_ADDRESS, entrypoint: "repay", params: { project_id: String(project.id), usd_cents: usd.toString() } },
      ]),
      onDone: () => {
        setRepayAmounts((current) => ({ ...current, [project.id]: "" }));
        ops.showToast(usd > 0n ? `Repaid ${formatCents(usd)} on #${project.id}.` : `Settled #${project.id}.`);
        reload();
      },
    });
  }

  function proposeEndDate(project: Project) {
    if (!PROJECTS_ADDRESS) return;
    const input = endDates[project.id] ?? "";
    // local start of the day, like the estimated completion on the Build Pool form
    const proposed = input ? new Date(`${input}T00:00:00`) : null;
    if (!proposed || Number.isNaN(proposed.getTime())) {
      ops.showToast("Pick the end date to propose.");
      return;
    }
    ops.setReview({
      title: `Propose end date for #${project.id}`,
      text: `Proposes ${formatDateTime(proposed)} as the project's end date, the end of the contract period: no draws after it, undrawn money goes back to investors, `
        + `and the late fee starts after the ${graceDays}-day grace period. It only counts once the projects admin approves it`
        + (project.endDate ? `; until then the approved end date ${formatDateTime(project.endDate)} stays in force, late fee included.` : ".")
        + (project.proposedEndDate ? ` This replaces your pending proposal (${formatDateTime(project.proposedEndDate)}).` : ""),
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "propose_end_date", params: { project_id: String(project.id), end_date: toTimestamp(proposed) } }],
      onDone: () => {
        setEndDates((current) => ({ ...current, [project.id]: "" }));
        ops.showToast(`End date proposed for #${project.id}.`);
        reload();
      },
    });
  }

  /** The investor's statement after launch (live while open, final once settled), laid out like the Build Pool estimate. */
  function statement(project: Project, investment: Investment) {
    const settled = project.status === "Repaid" || project.status === "Defaulted";
    const drawn = drawnUsd(project);
    const firstDraw = project.milestones.reduce<Date | null>((first, ms) => ms.drawnAt && (!first || ms.drawnAt < first) ? ms.drawnAt : first, null);
    const paidInterest = project.holdUsedUsd + project.interestPaidUsd;
    const earned = settled ? paidInterest : interestAt(project, now);
    const fee = builderShare(earned, project.builderShareBps);
    const undrawnBro = project.milestones.reduce((sum, ms) => sum + (ms.drawnAt === null ? ms.escrowBro : 0n), 0n);
    const drawnBro = project.milestones.reduce((sum, ms) => sum + (ms.drawnAt !== null ? ms.escrowBro : 0n), 0n);
    const mine = (amount: bigint) => investorShare(project, amount, investment);
    const rows: [string, string][] = [
      ["Money used", drawn > 0n ? `${formatCents(drawn)} drawn${firstDraw ? ` from ${formatDate(firstDraw)}` : ""} (your share ${formatCents(mine(drawn))})` : "Nothing drawn yet"],
      [settled ? "Interest earned" : "Interest earned so far", formatCents(mine(earned))],
      [`BRO Builder service fee (${bpsToPct(project.builderShareBps)})`, `-${formatCents(mine(fee))}`],
      ["Your interest", `${formatCents(mine(earned - fee))}${settled ? "" : ` (${formatCents(mine(paidInterest - builderShare(paidInterest, project.builderShareBps)))} paid out so far)`}`],
      ["Undrawn money returned", project.released ? formatBro(mine(undrawnBro), decimals) : hasUndrawn(project) ? "After the end date or at repayment" : "None"],
      ["Principal returned", settled ? formatBro(mine(drawnBro), decimals) : "At full repayment"],
      ...(project.uncoveredBro > 0n ? [["Not covered by the funding wallet", formatBro(mine(project.uncoveredBro), decimals)] as [string, string]] : []),
      ["Claimed so far", formatBro(investment.claimedBro, decimals)],
      ["Claimable now", formatBro(claimable(project, investment), decimals)],
    ];
    return <>
      <Lines head={`Your ${bpsToPct(project.fundedBro > 0n ? investment.bro * 10000n / project.fundedBro : 0n)}`} rows={rows} />
      {!settled && (
        <div className="muted">
          Interest so far is estimated from on-chain data up to now. It is paid out from the hold at each 30-day mark, and any interest above the hold when the contractor repays.
        </div>
      )}
    </>;
  }

  const now = new Date();
  const graceDays = ledger.storage?.projects.graceDays ?? 0;

  return <PoolShell wallet={wallet} active="portfolio" title="Portfolio" subtitle="Your investments and the projects you're building.">
    <ConfigError message={ledger.error} />
    {fundingPaused && <ConfigError message="Funding is paused by its admin. Refunds are disabled for now." />}
    {projectsPaused && <ConfigError message="Projects are paused by their admin. Draws, interest payouts, repayments and payout claims are disabled for now." />}
    <ConfigError message={market.error} />
    {market.blocked && <ConfigError message="The BRO price on the market assistant is out of date, so draws, interest payouts and repayments are disabled until the oracle updates it." />}
    {ledgerUnlinked && <ConfigError message="The market assistant isn't linked to the projects contract, so draws, payouts and settlements that need the funding wallet will fail. The market admin can link it on the BRO Builder Web3 Portal's projects setup page." />}
    {!wallet.address && !ledger.error && (
      <div className="card"><div className="empty">Connect your wallet to see your investments and projects.</div></div>
    )}

    {wallet.address && <div className="grid">
      <div className="card">
        <h2>My Investments</h2>
        <div className="desc">
          You earn each project's monthly rate on your share of the money drawn, paid every 30 days. Undrawn money comes back to you, and your
          principal comes back at full repayment. Claim what has been allotted to you at any time.
        </div>
        {investments === null && <div className="empty">Loading investments...</div>}
        {investments?.length === 0 && <div className="empty">You haven't invested yet. Browse open projects on the Build Pool page.</div>}
        {investments?.map((investment) => {
          const project = byId.get(investment.projectId);
          if (!project) return null;
          const toClaim = project.launched ? claimable(project, investment) : 0n;
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
              <div className="detail"><span>Monthly Rate</span><span>{bpsToPct(project.monthlyRateBps)} on drawn money</span></div>
              {project.status === "Funding" && <div className="detail"><span>Funding Deadline</span><span>{formatDate(project.fundingDeadline)}</span></div>}
              {project.launched && statement(project, investment)}
              <div className="actions-row">
                {isRefundable(project, now) && (
                  <button className="connect" type="button" disabled={fundingPaused} onClick={() => refund(project, investment)}>Refund</button>
                )}
                {project.launched && (
                  <button className="connect" type="button" disabled={projectsPaused || toClaim === 0n} onClick={() => claimPayout(project, investment)}>
                    Claim {formatBro(toClaim, decimals)}
                  </button>
                )}
              </div>
              {project.launched && upkeep.actions(project, projectsPaused, now)}
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>My Projects</h2>
        <div className="desc">
          Draw approved milestones (the interest hold is withheld from your first draws), then repay at any time in dollar installments: what you
          drew plus the interest charged by the day on it, minus the hold. Propose your end date for the projects admin to approve: it ends the contract
          period, and you repay in full within the {graceDays}-day grace period after it to avoid a late fee.
        </div>
        {ledger.projects === null && !ledger.error && <div className="empty">Loading projects...</div>}
        {ledger.projects !== null && myProjects.length === 0 && <div className="empty">You haven't submitted a project from this wallet.</div>}
        {myProjects.map((project) => {
          const open = isOpen(project);
          const debt = owed(project, graceDays, now);
          const feeStart = lateFeeStart(project, graceDays);
          const ready = drawable(project);
          const readyUsd = ready.reduce((sum, ms) => sum + ms.usd, 0n);
          const split = drawSplit(project, readyUsd);
          const blocker = ready.length > 0 ? drawBlocker(project, ready) : null;
          const defaultAt = defaultableAt(project, graceDays);
          const cents = parseCents(repayAmounts[project.id]?.trim() ?? "");
          const interest = open ? debt.interest : project.holdUsedUsd + project.interestPaidUsd;
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
              <div className="detail"><span>Monthly Rate</span><span>{bpsToPct(project.monthlyRateBps)} ({dailyRatePct(project.monthlyRateBps)} a day) on drawn money</span></div>
              <div className="detail"><span>Funded</span><span>{formatCents(project.fundedUsd)} ({formatBro(project.fundedBro, decimals)})</span></div>
              {project.fundedAt && <div className="detail"><span>Funded On</span><span>{formatDate(project.fundedAt)}</span></div>}
              {project.fundedAt && (
                <div className="detail"><span>End Date</span><span>{project.endDate ? `${formatDateTime(project.endDate)}${periodEnded(project, now) ? " (period ended)" : ""}` : "Not approved yet"}</span></div>
              )}
              {open && project.proposedEndDate && (
                <div className="detail"><span>Proposed End Date</span><span>{formatDateTime(project.proposedEndDate)} (waiting for the admin)</span></div>
              )}
              {open && feeStart && (
                <div className="detail">
                  <span>{now > feeStart ? "Late Fee Running Since" : "Repay in Full By"}</span>
                  <span>{formatDateTime(feeStart)}</span>
                </div>
              )}
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
                          <td>{formatCents(ms.usd)}</td>
                          <td>{milestoneState(project, ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {project.status === "Active" && ready.length > 0 && (
                <>
                  <div className="actions-row">
                    <button className="connect" type="button" disabled={projectsPaused || Boolean(blocker)} onClick={() => void draw(project)}>
                      Draw {formatCents(readyUsd)}
                    </button>
                    {blocker && !market.blocked && <span className="muted">{blocker}</span>}
                  </div>
                  {!blocker && (
                    <div className="est">
                      {split.withheld > 0n
                        ? `${formatCents(split.withheld)} is withheld for the interest hold, so you receive ${formatCents(split.paid)}.`
                        : `The interest hold is complete, so you receive all ${formatCents(readyUsd)}.`}
                    </div>
                  )}
                </>
              )}

              {project.launched && (
                <>
                  <div className="detail"><span>Drawn</span><span>{formatCents(drawnUsd(project))}</span></div>
                  <div className="detail">
                    <span>Interest Hold</span>
                    <span>{formatCents(project.holdUsd)} of {formatCents(holdTarget(project))} withheld · {formatCents(project.holdUsedUsd)} paid out</span>
                  </div>
                  <div className="detail"><span>{open ? "Interest So Far" : "Interest Paid"}</span><span>{formatCents(interest)}</span></div>
                  <div className="detail"><span>Repaid</span><span>{formatCents(project.repaidUsd)}{project.lateFeeUsd > 0n ? ` (incl. ${formatCents(project.lateFeeUsd)} late fee)` : ""}</span></div>
                </>
              )}
              {open && (
                <>
                  <div className="detail">
                    <span>Owed Now</span>
                    <span>
                      {formatCents(debt.principal)} principal + {formatCents(debt.interest)} interest − {formatCents(project.holdUsd)} hold
                      {project.interestPaidUsd > 0n ? ` − ${formatCents(project.interestPaidUsd)} interest paid` : ""}
                      {debt.fee > 0n ? ` + ${formatCents(debt.fee)} late fee (${bpsToPct(debt.feeBps)})` : ""}
                    </span>
                  </div>
                  <div className="detail total"><span>Total to Settle</span><span>{formatCents(debt.due)}</span></div>
                </>
              )}
              {project.status === "Defaulted" && (
                <div className="detail total"><span>Owed at Default</span><span>{formatCents(amountDue(project, graceDays, now))} (not collected)</span></div>
              )}

              {open && upkeep.actions(project, projectsPaused, now)}

              {open && (debt.due === 0n
                ? (
                  <div className="actions-row">
                    <button className="connect" type="button" disabled={projectsPaused || market.blocked || !market.market} onClick={() => void repay(project)}>
                      Nothing Owed: Settle Now
                    </button>
                  </div>
                )
                : (
                  <>
                    <div className="fundrow">
                      <input
                        className="field"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder={`Up to ${formatCents(debt.due)}`}
                        aria-label="Amount to repay in USD"
                        value={repayAmounts[project.id] ?? ""}
                        onChange={(event) => setRepayAmounts((current) => ({ ...current, [project.id]: event.target.value }))}
                      />
                      <div className="token">USD</div>
                      <button className="secondary" type="button" onClick={() => setRepayAmounts((current) => ({ ...current, [project.id]: formatUnits(debt.due, 2) }))}>
                        Pay All
                      </button>
                      <button className="connect" type="button" disabled={projectsPaused || market.blocked || !market.market} onClick={() => void repay(project)}>Repay</button>
                    </div>
                    <div className="est">
                      {cents && cents > 0n && live.price
                        ? `≈ ${formatBro(usdToBroUp(cents > debt.due ? debt.due : cents, live.price), decimals)} at the live BRO price`
                        : project.status === "Active" && hasUndrawn(project) ? "Repaying everything early ends the project and returns undrawn money to investors." : ""}
                    </div>
                  </>
                ))}

              {open && (
                <div className="fundrow">
                  <input
                    className="field"
                    type="date"
                    aria-label="End date to propose"
                    value={endDates[project.id] ?? ""}
                    onChange={(event) => setEndDates((current) => ({ ...current, [project.id]: event.target.value }))}
                  />
                  <button className="secondary" type="button" onClick={() => proposeEndDate(project)}>Propose End Date</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>}

    {ops.elements}
  </PoolShell>;
}
