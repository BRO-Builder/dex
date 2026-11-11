import { useEffect, useState } from "react";
import { ConfigError, PoolShell, useOperations } from "../components/PoolShell";
import {
  PROJECTS_ADDRESS, STATUS_LABELS, bpsToPct, defaultableAt, formatBro, formatCents, formatDate, formatDateTime,
  lateFee, lateFeeStart, toTimestamp, type Project,
} from "../shared/ledger";
import { fetchTokenBalance } from "../shared/tokenMetadata";
import { useLedger } from "../shared/useLedger";
import { useMarket } from "../shared/useMarket";
import { useWallet } from "../shared/tezos";

type Role = "admin" | "nft" | "none" | "unknown";

export default function ApproverPage() {
  const wallet = useWallet();
  const ledger = useLedger(wallet);
  const market = useMarket(wallet, ledger.storage?.projects.market);
  const ops = useOperations(wallet);
  const [role, setRole] = useState<Role>("unknown");
  const [now, setNow] = useState(() => new Date());

  const decimals = market.decimals;
  const storage = ledger.storage?.projects;
  const projects = ledger.projects ?? [];

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!wallet.address || !storage) return setRole("unknown");
      if (wallet.address === storage.admin) return setRole("admin");
      if (!storage.nft) return setRole("none");
      try {
        const balance = await fetchTokenBalance(wallet.selected.api, wallet.address, storage.nft.address, storage.nft.tokenId);
        if (!cancelled) setRole(balance > 0n ? "nft" : "none");
      } catch (error) {
        console.error("Approver NFT:", error);
        if (!cancelled) setRole("unknown");
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [wallet.address, wallet.selected.api, storage]);

  const canAct = role === "admin" || role === "nft";
  const pending = projects.filter((project) => project.status === "Active" && project.currentMilestone < project.milestones.length);
  const proposals = projects.filter((project) => (project.status === "Active" || project.status === "Repaying") && project.proposedEndDate);
  const watch = storage
    ? projects
      .map((project) => ({ project, at: defaultableAt(project, storage.graceDays) }))
      .filter((item): item is { project: Project; at: Date } => item.at !== null)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
    : [];

  function approve(project: Project) {
    if (!PROJECTS_ADDRESS) return;
    const ms = project.milestones[project.currentMilestone];
    if (!ms) return;
    ops.setReview({
      title: `Approve M${ms.index + 1} on #${project.id}`,
      text: `Approves "${ms.description}". The contractor can then claim its full ${formatCents(ms.usd)}; there is no fee for a late approval.`
        + (ms.index + 1 < project.milestones.length ? ` M${ms.index + 2} falls due ${project.milestones[ms.index + 1].durationDays} days after this approval.` : ""),
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "approve_milestone", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`Approved M${ms.index + 1} on #${project.id}.`);
        void ledger.reload();
      },
    });
  }

  function approveEndDate(project: Project) {
    if (!PROJECTS_ADDRESS || !project.proposedEndDate || !storage) return;
    const proposed = project.proposedEndDate;
    ops.setReview({
      title: `Approve end date for #${project.id}`,
      text: `Sets the end date to ${formatDateTime(proposed)}`
        + (project.endDate ? `, replacing ${formatDateTime(project.endDate)}` : "")
        + `. The late fee and default start after it plus the ${storage.graceDays}-day grace period.`
        + (proposed < now ? " This date is already in the past." : "")
        + " If the contractor changes the proposal before this is included, the approval fails.",
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "approve_end_date", params: { project_id: String(project.id), end_date: toTimestamp(proposed) } }],
      onDone: () => {
        ops.showToast(`End date approved for #${project.id}.`);
        void ledger.reload();
      },
    });
  }

  function rejectEndDate(project: Project) {
    if (!PROJECTS_ADDRESS) return;
    ops.setReview({
      title: `Reject end date for #${project.id}`,
      text: `Drops the proposed ${formatDateTime(project.proposedEndDate)}. ${project.endDate ? `The approved end date ${formatDateTime(project.endDate)} stays in force.` : "The project still has no approved end date."}`,
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "reject_end_date", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`Proposal rejected for #${project.id}.`);
        void ledger.reload();
      },
    });
  }

  function markDefault(project: Project) {
    if (!PROJECTS_ADDRESS) return;
    const unclaimed = project.milestones.filter((ms) => !ms.claimed).reduce((sum, ms) => sum + ms.escrowBro, 0n);
    ops.setReview({
      title: `Mark #${project.id} as defaulted`,
      text: `Ends the project. Unclaimed escrow (${formatBro(unclaimed, decimals)}) and the BRO repaid so far (${formatBro(project.repaidBro, decimals)}) `
        + "become the investors' pool, and the funding wallet tops it up as far as its balance allows. This can't be undone.",
      steps: [{ contract: PROJECTS_ADDRESS, entrypoint: "mark_default", params: String(project.id) }],
      onDone: () => {
        ops.showToast(`#${project.id} marked as defaulted.`);
        void ledger.reload();
      },
    });
  }

  const roleText = !wallet.address
    ? "Connect the admin wallet or a wallet holding the approver NFT."
    : role === "admin" ? "Connected as the projects admin."
      : role === "nft" ? "Connected as an approver NFT holder."
        : role === "none" ? "This wallet is not the projects admin and doesn't hold the approver NFT, so it can't approve or default projects."
          : "Checking approver status...";

  return <PoolShell wallet={wallet} active="approver" title="Approver" subtitle="Approve milestones and end dates, and handle overdue projects.">
    <ConfigError message={ledger.error} />
    <div className="card">
      <div className="poolrow"><span>Your Role</span><strong>{roleText}</strong></div>
      <div className="poolrow"><span>Approver NFT</span><strong>{storage?.nft ? `${storage.nft.address} #${storage.nft.tokenId}` : "Not set (admin only)"}</strong></div>
      <div className="poolrow"><span>Grace Period</span><strong>{storage ? `${storage.graceDays} days` : "—"}</strong></div>
    </div>

    <div className="grid">
      <div className="card">
        <h2>Pending Milestones</h2>
        <div className="desc">The current milestone of each project in progress. Approving pays the contractor the milestone's full amount, even when it is late.</div>
        {ledger.projects === null && !ledger.error && <div className="empty">Loading projects...</div>}
        {ledger.projects !== null && pending.length === 0 && <div className="empty">No milestones are waiting for approval.</div>}
        {pending.map((project) => {
          const ms = project.milestones[project.currentMilestone];
          return (
            <div className="loan" key={project.id}>
              <div className="loan-head">
                <div>
                  <h3>{project.title}</h3>
                  <div className="loc">#{project.id} · {project.site.street}, {project.site.city}, {project.site.state}</div>
                </div>
                <div className="loan-tags"><span className="loan-tag gold">M{ms.index + 1} of {project.milestones.length}</span></div>
              </div>
              <div className="detail"><span>Milestone</span><span>{ms.description}</span></div>
              <div className="detail"><span>Amount</span><span>{formatCents(ms.usd)} ({bpsToPct(ms.pctBps)})</span></div>
              <div className="detail"><span>Due</span><span>{formatDateTime(ms.dueAt)}{ms.dueAt && now > ms.dueAt ? " (late)" : ""}</span></div>
              <div className="detail total"><span>Contractor Receives</span><span>{formatCents(ms.usd)}</span></div>
              <details className="more">
                <summary>Scope &amp; contractor</summary>
                <dl>
                  <dt>Contractor</dt><dd>{project.contractor}</dd>
                  {project.scope && <><dt>Scope</dt><dd>{project.scope}</dd></>}
                  <dt>Owner</dt><dd>{project.owner.name}{project.owner.phone ? ` · ${project.owner.phone}` : ""}{project.owner.email ? ` · ${project.owner.email}` : ""}</dd>
                </dl>
              </details>
              <div className="actions-row">
                <button className="connect" type="button" disabled={!canAct} onClick={() => approve(project)}>Approve M{ms.index + 1}</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>End Date Proposals</h2>
        <div className="desc">
          Contractors propose their project's end date (at launch, the estimated completion from the listing). Only the projects admin can approve or reject.
          The approved date stays in force until a new one is approved. After it plus the grace period, the contractor owes a late fee for every day since the end date, and the project can be defaulted.
        </div>
        {ledger.projects !== null && proposals.length === 0 && <div className="empty">No end dates are waiting for approval.</div>}
        {proposals.map((project) => (
          <div className="loan" key={project.id}>
            <div className="loan-head">
              <div>
                <h3>{project.title}</h3>
                <div className="loc">#{project.id} · {STATUS_LABELS[project.status]}</div>
              </div>
              <div className="loan-tags">{project.proposedEndDate && project.proposedEndDate < now && <span className="loan-tag gold">In the past</span>}</div>
            </div>
            <div className="detail"><span>Proposed</span><span>{formatDateTime(project.proposedEndDate)}</span></div>
            <div className="detail"><span>Approved Now</span><span>{project.endDate ? formatDateTime(project.endDate) : "None"}</span></div>
            <div className="detail"><span>Estimated Completion</span><span>{formatDate(project.estCompletion)}</span></div>
            <div className="actions-row">
              <button className="connect" type="button" disabled={role !== "admin"} onClick={() => approveEndDate(project)}>Approve</button>
              <button className="secondary" type="button" disabled={role !== "admin"} onClick={() => rejectEndDate(project)}>Reject</button>
              {role === "nft" && <span className="muted">Projects admin only.</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Default Watch</h2>
        <div className="desc">
          A project can be defaulted once it is past its approved end date plus the grace period, or past its current milestone's due date plus the grace period.
          Without an approved end date, only the milestone rule applies.
        </div>
        {ledger.projects !== null && watch.length === 0 && <div className="empty">No projects in progress or repaying.</div>}
        {watch.map(({ project, at }) => {
          const overdue = now > at;
          const feeStart = storage ? lateFeeStart(project, storage.graceDays) : null;
          const fee = storage ? lateFee(project, storage.graceDays, now) : null;
          return (
            <div className="loan" key={project.id}>
              <div className="loan-head">
                <div>
                  <h3>{project.title}</h3>
                  <div className="loc">#{project.id} · {STATUS_LABELS[project.status]}</div>
                </div>
                <div className="loan-tags">{overdue && <span className="loan-tag gold">Overdue</span>}</div>
              </div>
              <div className="detail"><span>End Date</span><span>{project.endDate ? formatDateTime(project.endDate) : "Not approved"}</span></div>
              {feeStart && <div className="detail"><span>Grace Ends</span><span>{formatDateTime(feeStart)}</span></div>}
              {fee && fee.feeUsd > 0n && (
                <div className="detail"><span>Late Fee Now</span><span>{fee.lateDays} day{fee.lateDays === 1 ? "" : "s"} × {bpsToPct(project.lateFeeBpsPerDay)} = {formatCents(fee.feeUsd)}</span></div>
              )}
              <div className="detail"><span>Default Possible After</span><span>{formatDateTime(at)}</span></div>
              {project.status === "Repaying" && (
                <div className="detail"><span>Repaid</span><span>{formatCents(project.repaidUsd)}</span></div>
              )}
              <div className="actions-row">
                <button className="secondary" type="button" disabled={!canAct || !overdue} onClick={() => markDefault(project)}>Mark Default</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>

    {ops.elements}
  </PoolShell>;
}
