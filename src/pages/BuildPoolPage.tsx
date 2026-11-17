import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useState } from "react";
import { Lines } from "../components/PoolParts";
import { ConfigError, PoolShell, useOperations, withOperator } from "../components/PoolShell";
import {
  FUNDING_ADDRESS, MAX_RATE_BPS, MIN_RATE_BPS, PROJECTS_ADDRESS, STATUS_LABELS, bpsToPct, broToUsd, builderShare, dailyRatePct, formatBro,
  formatCents, formatDate, formatDateTime, fromPriceUnit, holdTarget, maxInterest, parseCents, toTimestamp, usdToBro, usdToBroUp,
  type Project, type ProjectType,
} from "../shared/ledger";
import { fetchRate, type RateQuote } from "../shared/rate";
import { parseUnits } from "../shared/units";
import { useLedger } from "../shared/useLedger";
import { useLivePrice } from "../shared/useLivePrice";
import { useMarket } from "../shared/useMarket";
import { useWallet } from "../shared/tezos";

type MilestoneForm = { description: string; pct: string; days: string };

type RequestForm = {
  title: string;
  scope: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  ownerName: string;
  ownerPhone: string;
  ownerEmail: string;
  budget: string;
  term: string;
  completion: string;
  deadline: string;
};

const DAY_MS = 86400 * 1000;

const INITIAL_FORM: RequestForm = {
  title: "",
  scope: "",
  street: "",
  city: "",
  state: "DE",
  zip: "",
  ownerName: "",
  ownerPhone: "",
  ownerEmail: "",
  budget: "",
  term: "6",
  completion: "",
  deadline: "",
};

const INITIAL_MILESTONES: MilestoneForm[] = [
  { description: "", pct: "50", days: "30" },
  { description: "", pct: "50", days: "30" },
];

function shortAddress(address: string | undefined) {
  return address && address.length > 16 ? `${address.substring(0, 8)}...${address.substring(address.length - 6)}` : (address || "Not set");
}

function usdNumber(value: number, digits = 2) {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function pctOf(part: bigint, whole: bigint) {
  return whole > 0n ? Math.min(100, Number(part * 10000n / whole) / 100) : 0;
}

function readForm(form: RequestForm, milestones: MilestoneForm[], quote: RateQuote | null) {
  return {
    title: form.title.trim(),
    scope: form.scope.trim(),
    street: form.street.trim(),
    city: form.city.trim(),
    state: form.state.trim().toUpperCase(),
    zip: form.zip.trim(),
    owner: form.ownerName.trim(),
    phone: form.ownerPhone.trim(),
    email: form.ownerEmail.trim(),
    budget: parseCents(form.budget),
    // the monthly rate is quoted by the BRO rate API, not entered
    rateBps: quote && Number.isFinite(quote.monthlyRatePct) ? Number(parseUnits(quote.monthlyRatePct.toFixed(2), 2) ?? NaN) : null,
    term: Number(form.term),
    // dates are local: completion at the start of the day, the deadline at its end
    completion: form.completion ? new Date(`${form.completion}T00:00:00`) : null,
    deadline: form.deadline ? new Date(`${form.deadline}T23:59:59`) : null,
    milestones: milestones.map((ms) => ({
      description: ms.description.trim(),
      pctBps: Math.round(parseFloat(ms.pct) * 100),
      days: Number(ms.days),
    })),
  };
}

/** Each milestone's share of the budget, split as BROLedger does. */
function milestoneUsd(budget: bigint, pcts: number[]) {
  let left = budget;
  return pcts.map((bps, index) => {
    const share = index === pcts.length - 1 ? left : budget * BigInt(Math.max(0, bps)) / 10000n;
    left -= share;
    return share;
  });
}

function validate(request: ReturnType<typeof readForm>, maxMilestones: number, quoteLoading: boolean) {
  if (!request.title) return "Add a project title.";
  if (!request.street || !request.city || !request.state || !request.zip) return "Complete the site address.";
  if (!/^\d{5}(-\d{4})?$/.test(request.zip)) return "ZIP should be 5 digits (or ZIP+4).";
  if (!request.owner) return "Add the homeowner or property owner name.";
  if (request.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(request.email)) return "Owner email doesn't look valid.";
  if (!request.budget || request.budget <= 0n) return "Enter the amount needed in dollars (up to 2 decimals).";
  if (!(Number.isInteger(request.term) && request.term >= 1 && request.term <= 60)) return "Term must be 1–60 whole months.";
  if (quoteLoading) return "Wait for the interest rate quote to finish.";
  if (request.rateBps === null || Number.isNaN(request.rateBps)) return "No interest rate quote yet. Connect a wallet and enter the amount needed and term.";
  if (request.rateBps < MIN_RATE_BPS || request.rateBps > MAX_RATE_BPS) {
    return `The quoted monthly rate of ${bpsToPct(request.rateBps)} is outside the 3%–9% the contract accepts, so this project can't be listed.`;
  }
  if (!request.completion) return "Pick an estimated completion date.";
  if (!request.deadline) return "Pick a funding deadline.";
  if (request.deadline.getTime() <= Date.now()) return "The funding deadline must be in the future.";
  if (request.milestones.length < 1 || request.milestones.length > maxMilestones) return `Add between 1 and ${maxMilestones} milestones.`;
  for (const [index, ms] of request.milestones.entries()) {
    if (!ms.description) return `Describe milestone ${index + 1}.`;
    if (!(ms.pctBps > 0)) return `Milestone ${index + 1} needs a share above 0%.`;
    if (!(Number.isInteger(ms.days) && ms.days > 0)) return `Milestone ${index + 1} needs a duration of at least 1 whole day.`;
  }
  const total = request.milestones.reduce((sum, ms) => sum + (ms.pctBps || 0), 0);
  if (total !== 10000) return `Milestone shares add up to ${bpsToPct(total)}; they must add up to 100%.`;
  return null;
}

export default function BuildPoolPage() {
  const wallet = useWallet();
  const ledger = useLedger(wallet);
  const market = useMarket(wallet, ledger.storage?.funding.market);
  const live = useLivePrice(wallet);
  const ops = useOperations(wallet);
  const [tab, setTab] = useState<"request" | "fund">("request");
  const [projectType, setProjectType] = useState<ProjectType>("residential");
  const [typeFilter, setTypeFilter] = useState<"all" | ProjectType>("all");
  const [openOnly, setOpenOnly] = useState(true);
  const [form, setForm] = useState(INITIAL_FORM);
  const [milestones, setMilestones] = useState(INITIAL_MILESTONES);
  const [formError, setFormError] = useState<string | null>(null);
  const [fundAmounts, setFundAmounts] = useState<Record<number, string>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [quote, setQuote] = useState<RateQuote | null>(null);
  const [quoteStatus, setQuoteStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  // The monthly rate comes from the BRO rate API for the wallet, budget and term (as on the portal)
  useEffect(() => {
    const budget = Number(form.budget);
    const termDays = Number(form.term) * 30;
    setQuote(null);
    if (!wallet.address || !(budget > 0) || !(termDays > 0)) {
      setQuoteStatus({ loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setQuoteStatus({ loading: true, error: null });
    const timer = window.setTimeout(async () => {
      try {
        const result = await fetchRate({ address: wallet.address!, loanAmount: budget, termDays, primo: true }, controller.signal);
        if (!Number.isFinite(result.monthlyRatePct)) throw new Error("Rate API response is missing monthly_rate_pct");
        setQuote(result);
        setQuoteStatus({ loading: false, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Rate quote:", error);
        setQuoteStatus({ loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    }, 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [wallet.address, form.budget, form.term]);

  useEffect(() => {
    if (!detailsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [detailsOpen]);

  const decimals = market.decimals;
  const linked = Boolean(ledger.storage?.funding.projectsContract);
  const maxMilestones = ledger.storage?.funding.maxMilestones ?? 20;
  const projects = ledger.projects ?? [];

  function field(key: keyof RequestForm) {
    return {
      id: key,
      value: form[key],
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setForm((current) => ({ ...current, [key]: event.target.value })),
    };
  }

  function milestoneField(index: number, key: keyof MilestoneForm) {
    return {
      value: milestones[index][key],
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        setMilestones((current) => current.map((ms, i) => i === index ? { ...ms, [key]: event.target.value } : ms)),
    };
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = readForm(form, milestones, quote);
    const message = validate(request, maxMilestones, quoteStatus.loading);
    setFormError(message);
    if (message || !FUNDING_ADDRESS || !request.budget || !request.completion || !request.deadline || request.rateBps === null) return;
    if (!await ops.requireAddress()) return;

    ops.setReview({
      title: "Submit Project",
      text: `Lists a ${formatCents(request.budget)} project at ${bpsToPct(request.rateBps)} a month on drawn money, for funding until ${formatDate(request.deadline)}. `
        + `An interest hold of ${formatCents(holdTarget({ budgetUsd: request.budget, monthlyRateBps: request.rateBps, termMonths: request.term }))} will be withheld from your first draws. `
        + "Project, site and owner details are stored on the funding contract in plain text and are public.",
      steps: [{
        contract: FUNDING_ADDRESS,
        entrypoint: "submit_project",
        params: {
          project_type: projectType,
          title: request.title,
          scope: request.scope,
          site: { street: request.street, city: request.city, state: request.state, zip: request.zip },
          owner: { name: request.owner, phone: request.phone, email: request.email },
          est_completion: toTimestamp(request.completion),
          funding_deadline: toTimestamp(request.deadline),
          budget_usd: request.budget.toString(),
          monthly_rate_bps: String(request.rateBps),
          term_months: String(request.term),
          milestones: request.milestones.map((ms) => ({
            description: ms.description,
            pct_bps: String(ms.pctBps),
            duration_days: String(ms.days),
          })),
        },
      }],
      onDone: () => {
        setForm(INITIAL_FORM);
        setMilestones(INITIAL_MILESTONES);
        setTab("fund");
        ops.showToast("Project submitted.");
        void ledger.reload();
      },
    });
  }

  async function invest(project: Project) {
    const storage = ledger.storage?.funding;
    if (!FUNDING_ADDRESS || !storage || decimals === undefined || !market.market) {
      ops.showToast("Funding, market or BRO token details aren't loaded yet. Try again shortly.");
      return;
    }
    if (!storage.projectsContract) {
      ops.showToast("Funding isn't linked to the projects contract yet, so investing is disabled.");
      return;
    }
    if (market.blocked) {
      ops.showToast("The BRO price on the market assistant is out of date, so the contract would reject this deposit. Try again after the oracle updates it.");
      return;
    }
    const amount = parseUnits(fundAmounts[project.id]?.trim() ?? "", decimals);
    if (!amount || amount <= 0n) {
      ops.showToast(`Enter how much BRO to invest (up to ${decimals} decimals).`);
      return;
    }
    const owner = await ops.requireAddress();
    if (!owner) return;
    const price = await market.freshPrice(ops.showToast);
    if (!price) return;

    ops.setReview({
      title: `Invest in #${project.id}`,
      text: `Lets the funding contract move up to ${formatBro(amount, decimals)} from your wallet, invests, then removes that permission. `
        + `It values your BRO at the market assistant's on-chain price (1 BRO = ${usdNumber(fromPriceUnit(price, decimals) ?? 0, 5)}) and takes only what is still needed to reach the budget. `
        + `You earn ${bpsToPct(project.monthlyRateBps)} a month on your share of the money the contractor draws, for the days it is drawn, less BRO Builder's ${bpsToPct(project.builderShareBps)} share; `
        + "interest is paid every 30 days, undrawn money comes back to you, and your principal comes back as BRO at full repayment. "
        + "The deposit that completes the budget also moves the project's BRO to the projects contract.",
      steps: withOperator({ address: storage.tokenAddress, tokenId: storage.tokenId }, owner, FUNDING_ADDRESS, [
        { contract: FUNDING_ADDRESS, entrypoint: "invest", params: { project_id: String(project.id), max_bro: amount.toString() } },
      ]),
      onDone: () => {
        setFundAmounts((current) => ({ ...current, [project.id]: "" }));
        ops.showToast(`Invested in #${project.id}.`);
        void ledger.reload();
      },
    });
  }

  /** Before investing: the most a deposit worth `usd` can earn (all drawn at launch and kept for the whole term), less BRO Builder's share. */
  function renderEstimate(project: Project, usd: bigint) {
    const most = maxInterest(project, usd);
    const fee = builderShare(most, project.builderShareBps);
    const net = most - fee;
    return <>
      <Lines head={`Your ${bpsToPct(project.budgetUsd > 0n ? usd * 10000n / project.budgetUsd : 0n)}`} rows={[
        ["Your deposit", formatCents(usd)],
        [`Most you can earn (all ${formatCents(project.budgetUsd)} drawn at launch, kept ${project.termMonths} month${project.termMonths === 1 ? "" : "s"})`, `${formatCents(most)} interest`],
        [`BRO Builder service fee (${bpsToPct(project.builderShareBps)} of your interest)`, `-${formatCents(fee)}`],
        ["Your interest at most", `${formatCents(net)}${usd > 0n ? ` (${bpsToPct(net * 10000n / usd)})` : ""}`],
      ]} />
      <div className="muted">
        If less is drawn or the contractor repays early, you earn interest only on the money used, for the days it was used,
        and your share of any undrawn money comes back to you. Interest is paid every 30 days from launch, in BRO at that day's price;
        your principal comes back as the BRO you deposited. Swapping BRO to XTZ on the exchange has its own fee.
      </div>
    </>;
  }

  const request = readForm(form, milestones, quote);
  // estimate at the live price: the on-chain one can be hours old, and investors fund at the price of the day
  const requestBro = request.budget && live.price ? usdToBro(request.budget, live.price) : null;
  const msUsd = request.budget ? milestoneUsd(request.budget, request.milestones.map((ms) => ms.pctBps)) : null;
  const pctTotal = request.milestones.reduce((sum, ms) => sum + (ms.pctBps || 0), 0);
  const rateValid = request.rateBps !== null && request.rateBps >= MIN_RATE_BPS && request.rateBps <= MAX_RATE_BPS;
  const termValid = Number.isInteger(request.term) && request.term >= 1 && request.term <= 60;
  const hold = request.budget && request.rateBps !== null && termValid
    ? holdTarget({ budgetUsd: request.budget, monthlyRateBps: request.rateBps, termMonths: request.term })
    : null;

  const now = new Date();
  const isOpen = (project: Project) => project.status === "Funding" && now <= project.fundingDeadline;
  const stats = projects.reduce((totals, project) => ({
    budget: totals.budget + project.budgetUsd,
    funded: totals.funded + project.fundedUsd,
    open: totals.open + (isOpen(project) ? 1 : 0),
    toFund: totals.toFund + (isOpen(project) ? project.budgetUsd - project.fundedUsd : 0n),
    rate: totals.rate + project.monthlyRateBps,
    residential: totals.residential + (project.projectType === "commercial" ? 0 : 1),
    commercial: totals.commercial + (project.projectType === "commercial" ? 1 : 0),
  }), { budget: 0n, funded: 0n, open: 0, toFund: 0n, rate: 0, residential: 0, commercial: 0 });
  const visible = projects.filter((project) => (typeFilter === "all" || project.projectType === typeFilter) && (!openOnly || isOpen(project)));

  return <PoolShell wallet={wallet} active="build-pool" title="Build Pool" subtitle="Fund construction projects with BRO Token or request project funding.">
    <ConfigError message={ledger.error} />
    <ConfigError message={market.error} />
    {ledger.storage?.funding.paused && <ConfigError message="Funding is paused by its admin. Submitting and investing are disabled for now." />}
    {ledger.storage && !linked && <ConfigError message="Funding isn't linked to the projects contract yet, so investing is disabled. The funding admin can link it on the BRO Builder Web3 Portal's projects setup page." />}
    {market.blocked && <ConfigError message="The BRO price on the market assistant is out of date, so investing is disabled until the oracle updates it." />}
    <div className="stats">
      <div className="stat">
        <div className="label">Total Budgets</div>
        <div className="value">{formatCents(stats.budget)}</div>
        <div className="sub">{stats.open} open project{stats.open === 1 ? "" : "s"}</div>
      </div>
      <div className="stat">
        <div className="label">Total Funded</div>
        <div className="value">{formatCents(stats.funded)}</div>
        <div className="sub">{pctOf(stats.funded, stats.budget).toFixed(1)}% of budgets</div>
      </div>
      <div className="stat">
        <div className="label">Avg. Monthly Rate</div>
        <div className="value">{projects.length ? bpsToPct(Math.round(stats.rate / projects.length)) : "—"}</div>
        <div className="sub">On drawn money, paid every 30 days</div>
      </div>
    </div>
    <div className="pool-bar">
      <span>
        {market.broUsd ? <>1 BRO = <strong>{usdNumber(market.broUsd, 5)}</strong></> : "BRO price unavailable"}
        {market.stale && <span className="warn"> (out of date)</span>}
        <span className="pool-bar-sep">·</span>{wallet.network}
      </span>
      <button type="button" className="secondary" onClick={() => setDetailsOpen(true)}>Pool details</button>
    </div>
    <div className="card">
      <div className="tabs" role="tablist">
        <button className={tab === "request" ? "tab active" : "tab"} type="button" role="tab" aria-selected={tab === "request"} onClick={() => setTab("request")}>REQUEST FUNDING</button>
        <button className={tab === "fund" ? "tab active" : "tab"} type="button" role="tab" aria-selected={tab === "fund"} onClick={() => setTab("fund")}>FUND PROJECTS</button>
      </div>

      { tab === "request" && (
        <form noValidate onSubmit={(event) => void submitRequest(event)}>
          <h2>Request Funding</h2>
          <div className="desc">Contractors list a residential or commercial project for BRO holders to fund. The budget is in dollars; investors fund it in BRO.</div>

          <div className="segment" role="group" aria-label="Project type">
            {(["residential", "commercial"] as const).map((type) => (
              <button type="button" className={projectType === type ? "active" : ""} onClick={() => setProjectType(type)} key={type}>
                {type === "residential" ? "Residential" : "Commercial"}
              </button>
            ))}
          </div>

          <div className="form-section">Project</div>
          <div className="box">
            <div className="top"><label htmlFor="title">Project Title</label></div>
            <input className="field" maxLength={80} placeholder="Kitchen remodel and rear deck" {...field("title")} />
          </div>
          <div className="box">
            <div className="top"><label htmlFor="scope">Scope of Work</label></div>
            <textarea className="field" maxLength={600} placeholder="Demo existing kitchen, new cabinets and counters, 12×16 composite deck" {...field("scope")} />
          </div>

          <div className="form-section">Site Address</div>
          <div className="box">
            <div className="top"><label htmlFor="street">Street</label></div>
            <input className="field" autoComplete="off" maxLength={120} placeholder="Street address" {...field("street")} />
          </div>
          <div className="trio">
            <div className="box">
              <div className="top"><label htmlFor="city">City</label></div>
              <input className="field" maxLength={60} placeholder="City" {...field("city")} />
            </div>
            <div className="box">
              <div className="top"><label htmlFor="state">State</label></div>
              <input className="field" maxLength={2} {...field("state")} />
            </div>
            <div className="box">
              <div className="top"><label htmlFor="zip">ZIP</label></div>
              <input className="field" inputMode="numeric" maxLength={10} placeholder="00000" {...field("zip")} />
            </div>
          </div>

          <div className="form-section">Homeowner / Property Owner</div>
          <div className="box">
            <div className="top"><label htmlFor="ownerName">Full Name or Company</label></div>
            <input className="field" maxLength={80} placeholder="Owner name" {...field("ownerName")} />
          </div>
          <div className="pair">
            <div className="box">
              <div className="top"><label htmlFor="ownerPhone">Phone</label></div>
              <input className="field" type="tel" maxLength={30} placeholder="(302) 000-0000" {...field("ownerPhone")} />
            </div>
            <div className="box">
              <div className="top"><label htmlFor="ownerEmail">Email</label></div>
              <input className="field" type="email" maxLength={120} placeholder="owner@email.com" {...field("ownerEmail")} />
            </div>
          </div>

          <div className="form-section">Funding Terms</div>
          <div className="box">
            <div className="top">
              <label htmlFor="budget">Amount Needed</label>
              <span>Project cost in dollars</span>
            </div>
            <div className="row">
              <input className="field big" type="number" min="1" step="0.01" placeholder="0.00" {...field("budget")} />
              <div className="token">USD</div>
            </div>
            <div className="conv">
              <span>{requestBro !== null ? `≈ ${formatBro(requestBro, decimals)} today` : "≈ — BRO"}</span>
              <span>{live.broUsd ? `1 BRO = ${usdNumber(live.broUsd, 5)} (live)` : live.error ? "Live BRO price unavailable" : "Loading BRO price…"}</span>
            </div>
          </div>
          <div className="trio">
            <div className="box">
              <div className="top"><label htmlFor="rate">Monthly Rate</label><span>%</span></div>
              <input
                className="field"
                id="rate"
                type="text"
                readOnly
                value={request.rateBps !== null ? (request.rateBps / 100).toFixed(2) : ""}
                placeholder={!wallet.address ? "Connect a wallet" : quoteStatus.loading ? "Quoting…" : "Enter amount & term"}
              />
            </div>
            <div className="box">
              <div className="top"><label htmlFor="term">Term</label><span>mo</span></div>
              <input className="field" type="number" min="1" max="60" step="1" {...field("term")} />
            </div>
            <div className="box">
              <div className="top"><label htmlFor="completion">Completion</label><span>proposed end date</span></div>
              <input className="field" type="date" {...field("completion")} />
            </div>
          </div>
          {quoteStatus.error && <div className="err">Couldn't get an interest rate quote: {quoteStatus.error}</div>}
          {quote && (
            <div className="desc">
              Rate quoted by the BRO rate API for your wallet, amount and term: {quote.monthlyRatePct}% a month
              {request.rateBps !== null ? ` (${dailyRatePct(request.rateBps)} a day on drawn money)` : ""}.
              Risk: {quote.riskCategory} (score {quote.totalScore}/100, {quote.selfReportedPoints} self-reported).
              {quote.limitations.map((item) => <span key={item}><br />• {item}</span>)}
            </div>
          )}
          {request.rateBps !== null && !rateValid && (
            <div className="err">The quoted rate is outside the 3%–9% a month the contract accepts, so this project can't be listed.</div>
          )}
          <div className="box">
            <div className="top">
              <label htmlFor="deadline">Funding Deadline</label>
              <span>Investors can refund if the budget isn't reached by the end of this day</span>
            </div>
            <input className="field" type="date" {...field("deadline")} />
          </div>

          <div className="form-section">Milestones</div>
          <div className="desc">
            Each milestone releases its share of the budget once approved. Milestone 1 is due its duration after funding closes;
            each later one is due its duration after the previous approval. A late approval doesn't reduce the payout, but a
            project more than the grace period past its current milestone's due date can be defaulted.
          </div>
          {milestones.map((ms, index) => (
            <div className="milestone-row" key={index}>
              <div className="box">
                <div className="top">
                  <label htmlFor={`ms-desc-${index}`}>Milestone {index + 1}</label>
                  {milestones.length > 1 && (
                    <button type="button" className="link-button" onClick={() => setMilestones((current) => current.filter((_, i) => i !== index))}>Remove</button>
                  )}
                </div>
                <input className="field" id={`ms-desc-${index}`} maxLength={200} placeholder="Demolition and rough-in" {...milestoneField(index, "description")} />
              </div>
              <div className="pair">
                <div className="box">
                  <div className="top"><label htmlFor={`ms-pct-${index}`}>Share</label><span>{msUsd ? formatCents(msUsd[index]) : "%"}</span></div>
                  <input className="field" id={`ms-pct-${index}`} type="number" min="0.01" max="100" step="0.01" {...milestoneField(index, "pct")} />
                </div>
                <div className="box">
                  <div className="top"><label htmlFor={`ms-days-${index}`}>Duration</label><span>days</span></div>
                  <input className="field" id={`ms-days-${index}`} type="number" min="1" step="1" {...milestoneField(index, "days")} />
                </div>
              </div>
            </div>
          ))}
          <div className="milestone-actions">
            <span className={pctTotal === 10000 ? "" : "warn"}>Total {bpsToPct(pctTotal)} of 100%</span>
            <button
              type="button"
              className="secondary"
              disabled={milestones.length >= maxMilestones}
              onClick={() => setMilestones((current) => [...current, { description: "", pct: "", days: "30" }])}
            >Add milestone</button>
          </div>

          <div className="details">
            <div className="detail"><span>Project Cost</span><span>{request.budget ? formatCents(request.budget) : "—"}</span></div>
            <div className="detail"><span>Funded in BRO (est.)</span><span>{requestBro !== null ? formatBro(requestBro, decimals) : "—"}</span></div>
            <div className="detail"><span>Monthly Rate</span><span>{request.rateBps !== null ? `${bpsToPct(request.rateBps)} (${dailyRatePct(request.rateBps)} a day)` : "—"}</span></div>
            <div className="detail"><span>Term</span><span>{termValid ? `${request.term} months (sizes the interest hold)` : "—"}</span></div>
            <div className="detail"><span>Proposed End Date</span><span>{formatDate(request.completion)}</span></div>
            <div className="detail"><span>Funding Deadline</span><span>{formatDate(request.deadline)}</span></div>
            <div className="detail"><span>Milestones</span><span>{milestones.length} · {request.milestones.reduce((sum, ms) => sum + (ms.days || 0), 0)} days on time</span></div>
            <div className="detail total"><span>Interest Hold</span><span>{hold !== null ? formatCents(hold) : "—"}</span></div>
          </div>
          <div className="desc">
            <strong>Interest hold.</strong> Budget × monthly rate × term is withheld from your first draw(s): your first draw arrives minus this hold
            (all of it, if the draw is smaller, with the rest taken from the next draws). It pays investors' interest every 30 days, and whatever
            is unused comes off what you repay. You repay what you drew plus the real interest (charged by the day only on money drawn) minus the hold.
          </div>
          <div className="desc">
            Your completion date is proposed as the project's end date once it's funded, and the projects admin approves it (you can propose
            a new one later). The approved end date ends the contract period: no draws after it, and undrawn money goes back to investors.
            Repay in full within the grace period after it. After that, a late fee of
            {" "}{ledger.storage ? bpsToPct(ledger.storage.funding.lateFeeBpsPerDay) : "—"} of what each installment pays is added for every day since
            the end date, up to 100%. BRO Builder takes {ledger.storage ? bpsToPct(ledger.storage.funding.builderShareBps) : "—"} of investors' interest.
          </div>

          {formError && <div className="err">{formError}</div>}
          <button className="primary mt-18" type="submit" disabled={Boolean(ledger.error) || ledger.storage?.funding.paused}>Review &amp; Submit Project</button>
          <div className="notice">
            You can repay at any time, in dollar installments; each one is converted to BRO at that day's price. Repaying early stops the interest.
            Project, site and owner details are written to the funding contract and are public.
          </div>
        </form>
      ) }

      { tab === "fund" && (
        <section>
          <h2>Fund Projects</h2>
          <div className="desc">
            Invest BRO in a project and earn its monthly rate on the money the contractor draws, for the days it is drawn. Interest is paid every
            30 days; undrawn money comes back to you, and your principal comes back as BRO at full repayment.
          </div>
          <div className="segment" role="group" aria-label="Filter by type">
            {(["all", "residential", "commercial"] as const).map((value) => (
              <button type="button" className={typeFilter === value ? "active" : ""} onClick={() => setTypeFilter(value)} key={value}>
                {value === "all" ? "All" : value === "residential" ? "Residential" : "Commercial"}
              </button>
            ))}
          </div>
          <div className="segment" role="group" aria-label="Filter by status">
            <button type="button" className={openOnly ? "active" : ""} onClick={() => setOpenOnly(true)}>Open for funding</button>
            <button type="button" className={openOnly ? "" : "active"} onClick={() => setOpenOnly(false)}>All projects</button>
          </div>
          <div>
            {ledger.projects === null && !ledger.error && <div className="empty">Loading projects...</div>}
            {ledger.projects !== null && visible.length === 0 && <div className="empty">No projects here yet. Submit one from the Request Funding tab.</div>}
            {visible.map((project) => {
              const pct = pctOf(project.fundedUsd, project.budgetUsd);
              const open = isOpen(project);
              const remainingUsd = project.budgetUsd - project.fundedUsd;
              const neededBro = live.price ? usdToBroUp(remainingUsd, live.price) : null;
              const amount = decimals === undefined ? null : parseUnits(fundAmounts[project.id]?.trim() ?? "", decimals);
              const taken = amount && neededBro !== null && amount > neededBro ? neededBro : amount;
              // the deposit that closes funding is credited exactly the remaining budget
              const depositUsd = taken && taken > 0n && live.price ? (taken === neededBro ? remainingUsd : broToUsd(taken, live.price)) : null;
              const daysLeft = Math.ceil((project.fundingDeadline.getTime() - now.getTime()) / DAY_MS);
              return (
                <div className="loan" key={project.id}>
                  <div className="loan-head">
                    <div>
                      <h3>{project.title}</h3>
                      <div className="loc">{project.site.city}, {project.site.state} {project.site.zip} · #{project.id}</div>
                    </div>
                    <div className="loan-tags">
                      <span className="loan-tag gold">{project.projectType}</span>
                      <span className={project.status === "Funding" ? "loan-tag" : "loan-tag ok"}>{STATUS_LABELS[project.status]}</span>
                    </div>
                  </div>
                  <div className="bar" role="img" aria-label={`${pct.toFixed(0)}% funded`}><i style={{ width: `${pct}%` }} /></div>
                  <div className="detail"><span>Funded</span><span>{formatCents(project.fundedUsd)} / {formatCents(project.budgetUsd)} ({pct.toFixed(0)}%)</span></div>
                  <div className="detail"><span>Monthly Rate</span><span>{bpsToPct(project.monthlyRateBps)} on drawn money</span></div>
                  <div className="detail"><span>Term</span><span>{project.termMonths} months</span></div>
                  <div className="detail"><span>BRO Builder Share</span><span>{bpsToPct(project.builderShareBps)} of investors' interest</span></div>
                  <div className="detail">
                    <span>Funding Deadline</span>
                    <span>{formatDate(project.fundingDeadline)}{open ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : ""}</span>
                  </div>
                  <details className="more">
                    <summary>Site, owner &amp; milestones</summary>
                    <dl>
                      <dt>Site</dt><dd>{project.site.street}, {project.site.city}, {project.site.state} {project.site.zip}</dd>
                      <dt>Owner</dt><dd>{project.owner.name}</dd>
                      {project.owner.phone && <><dt>Phone</dt><dd>{project.owner.phone}</dd></>}
                      {project.owner.email && <><dt>Email</dt><dd>{project.owner.email}</dd></>}
                      <dt>Completion</dt><dd>{formatDate(project.estCompletion)}</dd>
                      {project.endDate && <><dt>End Date</dt><dd>{formatDate(project.endDate)} (approved)</dd></>}
                      <dt>Contractor</dt><dd>{project.contractor}</dd>
                      {project.scope && <><dt>Scope</dt><dd>{project.scope}</dd></>}
                      {project.milestones.map((ms) => (
                        <span style={{ display: "contents" }} key={ms.index}>
                          <dt>M{ms.index + 1}</dt>
                          <dd>{ms.description} · {bpsToPct(ms.pctBps)} ({formatCents(ms.usd)}) · {ms.durationDays} days</dd>
                        </span>
                      ))}
                      <dt>Interest Hold</dt><dd>{formatCents(holdTarget(project))} (budget × rate × term)</dd>
                      <dt>Late Fee</dt><dd>{bpsToPct(project.lateFeeBpsPerDay)} / day since the end date, after grace</dd>
                    </dl>
                  </details>
                  {open && (
                    <>
                      <div className="fundrow">
                        <input
                          className="field"
                          type="number"
                          min="0"
                          step="any"
                          placeholder={neededBro !== null ? `About ${formatBro(neededBro, decimals, 0)} needed` : "Amount"}
                          aria-label="Amount to invest in BRO"
                          value={fundAmounts[project.id] ?? ""}
                          onChange={(event) => setFundAmounts((current) => ({ ...current, [project.id]: event.target.value }))}
                        />
                        <div className="token">BRO</div>
                        <button className="connect" type="button" disabled={ledger.storage?.funding.paused || !linked || market.blocked} onClick={() => void invest(project)}>Invest</button>
                      </div>
                      <div className="est">
                        {taken && taken > 0n && taken !== amount ? `Only about ${formatBro(taken, decimals)} is still needed.` : ""}
                      </div>
                      {depositUsd !== null ? renderEstimate(project, depositUsd) : (
                        <div className="muted">
                          Enter a BRO amount to see what it can earn. Rate {bpsToPct(project.monthlyRateBps)} a month for {project.termMonths} month{project.termMonths === 1 ? "" : "s"};
                          BRO Builder takes {bpsToPct(project.builderShareBps)} of your interest.
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <div className="notice">
            Investing lets the funding contract move your BRO for this one operation, then removes that permission.
            Estimates use the live BRO price (BRO Dex quote × XTZ/USD). The contract uses the market assistant's on-chain price, which is updated before you invest, so the amount taken can differ slightly.
          </div>
        </section>
      ) }
    </div>

    {detailsOpen && (
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setDetailsOpen(false);
      }}>
        <div className="modal pool-modal" role="dialog" aria-modal="true" aria-labelledby="pool-modal-title">
          <div className="modal-header">
            <div>
              <h2 id="pool-modal-title">BRO Build Pool</h2>
              <div className="desc">Live data from the BRO funding and projects contracts.</div>
            </div>
            <button type="button" className="modal-close" aria-label="Close pool details" autoFocus onClick={() => setDetailsOpen(false)}>×</button>
          </div>
          <div className="poolrow"><span>Asset</span><strong>BRO Token (FA2)</strong></div>
          <div className="poolrow"><span>BRO Price</span><strong>{market.broUsd ? usdNumber(market.broUsd, 5) : market.market ? "Not set" : market.error ? "Unavailable" : "—"}</strong></div>
          <div className="poolrow">
            <span>Price Updated</span>
            <strong className={market.stale ? "warn" : ""}>{market.market ? `${formatDateTime(market.market.storage.priceUpdatedAt)}${market.stale ? " (out of date)" : ""}` : "—"}</strong>
          </div>
          <div className="poolrow"><span>Network</span><strong>{wallet.network}</strong></div>
          <div className="poolrow"><span>Funding Contract</span><strong>{shortAddress(FUNDING_ADDRESS)}</strong></div>
          <div className="poolrow"><span>Projects Contract</span><strong>{shortAddress(PROJECTS_ADDRESS)}</strong></div>
          <div className="poolrow"><span>Market Assistant</span><strong>{shortAddress(ledger.storage?.funding.market)}</strong></div>
          <div className="poolrow"><span>Token Contract</span><strong>{shortAddress(ledger.storage?.funding.tokenAddress)}</strong></div>
          <div className="poolrow"><span>Token ID</span><strong>{ledger.storage?.funding.tokenId ?? "—"}</strong></div>

          <div className="liquidity">
            <div className="label">Total Funded</div>
            <div className="liqbig">{formatCents(stats.funded)}</div>
            <div className="liqsub">Across all listed projects</div>
          </div>

          <div className="poolrow"><span>Projects Listed</span><strong>{projects.length}</strong></div>
          <div className="poolrow"><span>Residential / Commercial</span><strong>{stats.residential} / {stats.commercial}</strong></div>
          <div className="poolrow"><span>Still to Fund</span><strong>{formatCents(stats.toFund)}</strong></div>
          <div className="poolrow"><span>Funding Wallet Balance</span><strong>{market.market ? formatBro(market.market.reserve, decimals, 0) : "—"}</strong></div>
          <div className="poolrow"><span>Late Repayment Fee</span><strong>{ledger.storage ? `${bpsToPct(ledger.storage.funding.lateFeeBpsPerDay)} / day` : "—"}</strong></div>
          <div className="poolrow"><span>BRO Builder Share</span><strong>{ledger.storage ? `${bpsToPct(ledger.storage.funding.builderShareBps)} of investors' interest` : "—"}</strong></div>
        </div>
      </div>
    )}

    {ops.elements}
  </PoolShell>;
}
