import type { ReactNode } from "react";
import type { useOperations } from "./PoolShell";
import {
  PROJECTS_ADDRESS, bpsToPct, builderShare, formatBro, formatCents, formatDateTime, hasUndrawn, isOpen, latestMark, nextMark,
  pendingHoldPayout, periodEnded, usdToBro, type Project,
} from "../shared/ledger";
import type { useMarket } from "../shared/useMarket";

/** A two-column table of lines, used for the investor estimate and statement. */
export function Lines({ head, rows }: { head: string; rows: [string, ReactNode][] }) {
  return <table className="ms-table lines">
    <thead><tr><th>Line</th><th>{head}</th></tr></thead>
    <tbody>{rows.map(([line, value]) => <tr key={line}><td>{line}</td><td>{value}</td></tr>)}</tbody>
  </table>;
}

/** Actions anyone can take on an open project: pay the interest due from the hold at the
 * latest 30-day mark (`pay_interest`), and hand undrawn money back to investors once the
 * contract period has ended (`release_undrawn`). */
export function useUpkeep({ ops, market, reload }: {
  ops: ReturnType<typeof useOperations>;
  market: ReturnType<typeof useMarket>;
  reload: () => void;
}) {
  const decimals = market.decimals;

  async function payInterest(project: Project) {
    if (!PROJECTS_ADDRESS) return;
    const price = await market.freshPrice(ops.showToast);
    if (!price) return;
    const pending = pendingHoldPayout(project);
    const fee = builderShare(pending, project.builderShareBps);
    ops.setReview({
      title: `Pay interest on #${project.id}`,
      text: `Pays the ${formatCents(pending)} of interest earned up to ${formatDateTime(latestMark(project))} out of the interest hold, `
        + `about ${formatBro(usdToBro(pending, price), decimals)} at the market assistant's current price. `
        + `BRO Builder's ${bpsToPct(project.builderShareBps)} share (${formatCents(fee)}) goes to the funding wallet; `
        + `the rest is allotted to investors, who collect it with Claim Payout. If the hold's BRO is worth less than that now, the funding wallet covers investors' part.`,
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "pay_interest", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`Interest paid on #${project.id}.`);
        reload();
      },
    });
  }

  function releaseUndrawn(project: Project) {
    if (!PROJECTS_ADDRESS) return;
    const undrawn = project.milestones.filter((ms) => ms.drawnAt === null);
    ops.setReview({
      title: `Return undrawn money on #${project.id}`,
      text: `The contract period ended on ${formatDateTime(project.endDate)}. Hands the ${formatBro(undrawn.reduce((sum, ms) => sum + ms.escrowBro, 0n), decimals)} `
        + `escrow of ${undrawn.length} undrawn milestone${undrawn.length === 1 ? "" : "s"} back to investors, as the BRO they deposited. `
        + "They collect it with Claim Payout. Nothing more can be drawn on this project.",
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "release_undrawn", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`Undrawn money returned on #${project.id}.`);
        reload();
      },
    });
  }

  /** The buttons for `project`, or null when neither applies. */
  function actions(project: Project, projectsPaused: boolean | undefined, now = new Date()) {
    if (!isOpen(project)) return null;
    const pending = pendingHoldPayout(project, now);
    const release = hasUndrawn(project) && periodEnded(project, now);
    return <div className="actions-row">
      {pending > 0n
        ? <button className="secondary" type="button" disabled={projectsPaused || market.blocked || !market.market} onClick={() => void payInterest(project)}>
          Pay Interest {formatCents(pending)}
        </button>
        : <span className="muted">No interest due from the hold. Next 30-day mark: {formatDateTime(nextMark(project, now))}.</span>}
      {release && <button className="secondary" type="button" onClick={() => releaseUndrawn(project)}>Release Undrawn</button>}
    </div>;
  }

  return { payInterest, releaseUndrawn, actions };
}
