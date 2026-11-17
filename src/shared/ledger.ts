import { isValidAddress } from "./tezos";
import { formatUnits, toBigInt } from "./units";

// BROFunding: listings, deposits, refunds. BROProjects: milestones, repayment, settlement.
export const FUNDING_ADDRESS = import.meta.env.VITE_FUNDING_ADDRESS as string | undefined;
export const PROJECTS_ADDRESS = import.meta.env.VITE_PROJECTS_ADDRESS as string | undefined;
export const DEX_ADDRESS = import.meta.env.VITE_DEX_ADDRESS as string | undefined;

// Ledger price unit (BROFunding / BROProjects): BRO base units per USD cent, times 10^6
const PRICE_SCALE = 1_000_000n;

export type ProjectType = "residential" | "commercial";

export type ProjectStatus = "Funding" | "Failed" | "Active" | "Repaying" | "Repaid" | "Defaulted" | "Cancelled";

export type Milestone = {
  index: number;
  description: string;
  pctBps: number;
  durationDays: number;
  usd: bigint;
  escrowBro: bigint;
  dueAt: Date | null;
  approvedAt: Date | null;
  /** Set when the contractor draws it; interest runs from here on `outstandingUsd`. */
  drawnAt: Date | null;
  /** Drawn cents not repaid yet (repayments reduce the oldest draws first). */
  outstandingUsd: bigint;
};

/** What went to (`builderFeeBro`, `lateFeeBro`, `surplusBro`) and came from (`coveredBro`) the funding wallet. */
export type Flows = { builderFeeBro: bigint; lateFeeBro: bigint; surplusBro: bigint; coveredBro: bigint };

export type Project = {
  id: number;
  contractor: string;
  projectType: ProjectType;
  title: string;
  scope: string;
  site: { street: string; city: string; state: string; zip: string };
  owner: { name: string; phone: string; email: string };
  estCompletion: Date;
  createdAt: Date;
  fundingDeadline: Date;
  budgetUsd: bigint;
  /** Interest per 30 days on drawn money, 300–900 bps; per day it is this / 30. */
  monthlyRateBps: number;
  /** Sizes the interest hold only (budget × monthly rate × term). */
  termMonths: number;
  lateFeeBpsPerDay: number;
  /** BRO Builder's share of investors' interest, saved at submission. */
  builderShareBps: number;
  fundedUsd: bigint;
  fundedBro: bigint;
  /** Launch; hold payouts fall due every 30 days from here. */
  fundedAt: Date | null;
  /** Approved by the projects admin: the end of the contract period. */
  endDate: Date | null;
  /** Proposed by the contractor (at launch: the listing's estimated completion), waiting for the admin. */
  proposedEndDate: Date | null;
  milestones: Milestone[];
  currentMilestone: number;
  /** Interest hold withheld from draws so far, in cents, and the BRO left of it. */
  holdUsd: bigint;
  holdBro: bigint;
  /** Interest paid out of the hold so far, in cents. */
  holdUsedUsd: bigint;
  /** Interest has been paid out of the hold up to this time. */
  paidUntil: Date | null;
  /** Cent-days of principal already repaid (interest stopped on it). */
  closedUsdDays: bigint;
  /** Interest above the hold paid by the contractor, in cents. */
  interestPaidUsd: bigint;
  /** Everything repaid, in cents (interest, principal and late fee). */
  repaidUsd: bigint;
  /** Repaid principal BRO, held until settlement. */
  repaidBro: bigint;
  /** Late fee paid so far, in cents. */
  lateFeeUsd: bigint;
  /** Undrawn escrow handed back to investors. */
  released: boolean;
  /** BRO allotted to investors so far (interest, undrawn money, principal). */
  investorBro: bigint;
  uncoveredBro: bigint;
  /** Cents (with the late fee) still owed when the project defaulted. */
  defaultDueUsd: bigint;
  flows: Flows | null;
  launched: boolean;
  status: ProjectStatus;
};

/** A deposit on BROFunding, and the BRO claimed so far from BROProjects. */
export type Investment = { projectId: number; usd: bigint; bro: bigint; claimedBro: bigint };

export type FundingStorage = {
  admin: string;
  paused: boolean;
  market: string;
  projectsContract: string | null;
  tokenAddress: string;
  tokenId: string;
  lateFeeBpsPerDay: number;
  /** BRO Builder's share of investors' interest for projects submitted from now on. */
  builderShareBps: number;
  maxMilestones: number;
  nextProjectId: number;
};

export type ProjectsStorage = {
  admin: string;
  paused: boolean;
  funding: string;
  market: string;
  tokenAddress: string;
  tokenId: string;
  nft: { address: string; tokenId: string } | null;
  graceDays: number;
};

export type LedgerStorage = { funding: FundingStorage; projects: ProjectsStorage };

export type MarketStorage = {
  admin: string;
  oracle: string;
  ledger: string | null;
  fundingWallet: string;
  tokenAddress: string;
  tokenId: string;
  price: bigint;
  priceUpdatedAt: Date;
  maxPriceAge: number;
};

/** A message describing missing or invalid contract addresses, or null. */
export function configError(...names: ("funding" | "projects" | "dex")[]) {
  const values = {
    funding: ["VITE_FUNDING_ADDRESS", FUNDING_ADDRESS],
    projects: ["VITE_PROJECTS_ADDRESS", PROJECTS_ADDRESS],
    dex: ["VITE_DEX_ADDRESS", DEX_ADDRESS],
  };
  const missing = names.filter((name) => !values[name][1] || !isValidAddress(values[name][1]!)).map((name) => values[name][0]);
  return missing.length ? `Set ${missing.join(", ")} to a valid KT1 address.` : null;
}

async function getJson(url: string, what: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what} request failed (HTTP ${response.status}).`);
  return response.json();
}

function date(value: string | null | undefined) {
  return value ? new Date(value) : null;
}

/** A BROFunding listing merged with its BROProjects record (absent until launched). */
function parseProject(id: number, listing: any, launched: any | undefined): Project {
  const milestones = Object.entries(listing.milestones ?? {})
    .map(([index, terms]: [string, any]) => {
      const ms = launched?.milestones?.[index];
      return {
        index: Number(index),
        description: terms.description,
        pctBps: Number(terms.pct_bps),
        durationDays: Number(terms.duration_days),
        usd: toBigInt(terms.usd),
        escrowBro: toBigInt(ms?.escrow_bro ?? 0),
        dueAt: date(ms?.due_at),
        approvedAt: date(ms?.approved_at),
        drawnAt: date(ms?.drawn_at),
        outstandingUsd: toBigInt(ms?.outstanding_usd ?? 0),
      };
    })
    .sort((a, b) => a.index - b.index);
  // TzKT renders a unit variant as {"Funding": {}}
  const listed = Object.keys(listing.status)[0];
  const status = (listed === "Launched" ? (launched ? Object.keys(launched.status)[0] : "Active") : listed) as ProjectStatus;
  const big = (field: string) => toBigInt(launched?.[field] ?? 0);
  return {
    id,
    contractor: listing.contractor,
    projectType: listing.project_type,
    title: listing.title,
    scope: listing.scope,
    site: listing.site,
    owner: listing.owner,
    estCompletion: new Date(listing.est_completion),
    createdAt: new Date(listing.created_at),
    fundingDeadline: new Date(listing.funding_deadline),
    budgetUsd: toBigInt(listing.budget_usd),
    monthlyRateBps: Number(listing.monthly_rate_bps),
    termMonths: Number(listing.term_months),
    lateFeeBpsPerDay: Number(listing.late_fee_bps_per_day),
    builderShareBps: Number(listing.builder_share_bps),
    fundedUsd: toBigInt(listing.funded_usd),
    fundedBro: toBigInt(launched?.funded_bro ?? listing.funded_bro),
    fundedAt: date(launched?.funded_at ?? listing.funded_at),
    endDate: date(launched?.end_date),
    proposedEndDate: date(launched?.proposed_end_date),
    milestones,
    currentMilestone: Number(launched?.current_milestone ?? 0),
    holdUsd: big("hold_usd"),
    holdBro: big("hold_bro"),
    holdUsedUsd: big("hold_used_usd"),
    paidUntil: date(launched?.paid_until),
    closedUsdDays: big("closed_usd_days"),
    interestPaidUsd: big("interest_paid_usd"),
    repaidUsd: big("repaid_usd"),
    repaidBro: big("repaid_bro"),
    lateFeeUsd: big("late_fee_usd"),
    released: Boolean(launched?.released),
    investorBro: big("investor_bro"),
    uncoveredBro: big("uncovered_bro"),
    defaultDueUsd: big("default_due_usd"),
    flows: launched?.flows
      ? {
        builderFeeBro: toBigInt(launched.flows.builder_fee_bro),
        lateFeeBro: toBigInt(launched.flows.late_fee_bro),
        surplusBro: toBigInt(launched.flows.surplus_bro),
        coveredBro: toBigInt(launched.flows.covered_bro),
      }
      : null,
    launched: Boolean(launched),
    status,
  };
}

export async function fetchLedgerStorage(api: string): Promise<LedgerStorage> {
  const [funding, projects] = await Promise.all([
    getJson(`${api}/v1/contracts/${FUNDING_ADDRESS}/storage`, "Funding storage"),
    getJson(`${api}/v1/contracts/${PROJECTS_ADDRESS}/storage`, "Projects storage"),
  ]);
  return {
    funding: {
      admin: funding.admin,
      paused: Boolean(funding.paused),
      market: funding.market,
      projectsContract: funding.projects_contract ?? null,
      tokenAddress: funding.token_address,
      tokenId: String(funding.token_id),
      lateFeeBpsPerDay: Number(funding.late_fee_bps_per_day),
      builderShareBps: Number(funding.builder_share_bps),
      maxMilestones: Number(funding.max_milestones),
      nextProjectId: Number(funding.next_project_id),
    },
    projects: {
      admin: projects.admin,
      paused: Boolean(projects.paused),
      funding: projects.funding,
      market: projects.market,
      tokenAddress: projects.token_address,
      tokenId: String(projects.token_id),
      nft: projects.nft ? { address: projects.nft.address, tokenId: String(projects.nft.token_id) } : null,
      graceDays: Number(projects.grace_days),
    },
  };
}

export async function fetchMarketStorage(api: string, address: string): Promise<MarketStorage> {
  const storage = await getJson(`${api}/v1/contracts/${address}/storage`, "Market storage");
  return {
    admin: storage.admin,
    oracle: storage.oracle,
    ledger: storage.ledger ?? null,
    fundingWallet: storage.funding_wallet,
    tokenAddress: storage.token_address,
    tokenId: String(storage.token_id),
    price: toBigInt(storage.price),
    priceUpdatedAt: new Date(storage.price_updated_at),
    maxPriceAge: Number(storage.max_price_age),
  };
}

export async function fetchProjects(api: string): Promise<Project[]> {
  const query = new URLSearchParams({ active: "true", limit: "10000", "sort.desc": "id" });
  const [listings, launched] = await Promise.all([
    getJson(`${api}/v1/contracts/${FUNDING_ADDRESS}/bigmaps/projects/keys?${query}`, "Listings"),
    getJson(`${api}/v1/contracts/${PROJECTS_ADDRESS}/bigmaps/projects/keys?${query}`, "Projects"),
  ]);
  const byId = new Map<string, any>(launched.map((key: any) => [String(key.key), key.value]));
  return listings.map((key: any) => parseProject(Number(key.key), key.value, byId.get(String(key.key))));
}

export async function fetchInvestments(api: string, investor: string): Promise<Investment[]> {
  const query = new URLSearchParams({ active: "true", limit: "10000", "key.address": investor });
  const [deposits, claimed] = await Promise.all([
    getJson(`${api}/v1/contracts/${FUNDING_ADDRESS}/bigmaps/investments/keys?${query}`, "Investments"),
    getJson(`${api}/v1/contracts/${PROJECTS_ADDRESS}/bigmaps/payouts_claimed/keys?${query}`, "Payouts"),
  ]);
  // payouts_claimed holds each investor's running total of BRO claimed
  const claimedById = new Map<string, bigint>(claimed.map((key: any) => [String(key.key.nat), toBigInt(key.value)]));
  return deposits.map((key: any) => ({
    projectId: Number(key.key.nat),
    usd: toBigInt(key.value.usd),
    bro: toBigInt(key.value.bro),
    claimedBro: claimedById.get(String(key.key.nat)) ?? 0n,
  }));
}

// ---------------------------------------------------------------------------
// Units: USD is bigint cents; `price` is the ledger price unit (see PRICE_SCALE)
// ---------------------------------------------------------------------------

/** USD per BRO for a ledger price unit. */
export function fromPriceUnit(price: bigint, decimals: number) {
  return price > 0n ? 10 ** decimals * 10_000 / Number(price) : null;
}

/** The market assistant's `get_price` view fails when the price is unset or older than `max_price_age`,
 * which blocks `invest`, `claim_milestone` and `repay`. */
export function isPriceStale(market: MarketStorage, now = new Date()) {
  return market.price === 0n || (now.getTime() - market.priceUpdatedAt.getTime()) / 1000 > market.maxPriceAge;
}

export function usdToBro(cents: bigint, price: bigint) {
  return cents * price / PRICE_SCALE;
}

export function usdToBroUp(cents: bigint, price: bigint) {
  return (cents * price + PRICE_SCALE - 1n) / PRICE_SCALE;
}

export function broToUsd(bro: bigint, price: bigint) {
  return price > 0n ? bro * PRICE_SCALE / price : 0n;
}

export function parseCents(value: string) {
  if (!/^\d+(\.\d{0,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function formatCents(cents: bigint) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toLocaleString("en-US");
  return `${negative ? "-" : ""}$${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Project rules, mirrored from BROFunding / BROProjects (the portal's
// src/shared/projectRules.ts mirrors the same ones). Keep them in sync with the
// contracts: daily interest on drawn money only, the interest hold, the 30-day
// hold payouts, the amount owed and the late fee.
// ---------------------------------------------------------------------------

/** `submit_project` accepts a monthly rate of 3–9%. */
export const MIN_RATE_BPS = 300;
export const MAX_RATE_BPS = 900;

const DAY = 86400n;
/** Hold payouts fall due every 30 days from launch. */
const PERIOD = 30n * DAY;

function seconds(value: Date) {
  return BigInt(Math.floor(value.getTime() / 1000));
}

function fromSeconds(value: bigint) {
  return new Date(Number(value) * 1000);
}

/** A partial day counts in full. */
function ceilDays(secs: bigint) {
  return (secs + DAY - 1n) / DAY;
}

export function isOpen(project: Project) {
  return project.status === "Active" || project.status === "Repaying";
}

export function isRefundable(project: Project, now = new Date()) {
  return project.status === "Failed" || project.status === "Cancelled" || (project.status === "Funding" && now > project.fundingDeadline);
}

/** True once the approved end date has passed: no more draws, and undrawn money can go back to investors. */
export function periodEnded(project: Project, now = new Date()) {
  return project.endDate !== null && now > project.endDate;
}

/** Undrawn milestones whose escrow hasn't been handed back to investors yet. */
export function hasUndrawn(project: Project) {
  return !project.released && project.milestones.some((ms) => ms.drawnAt === null);
}

/** Approved milestones not drawn yet: what `claim_milestone` draws. */
export function drawable(project: Project) {
  return project.milestones.filter((ms) => ms.index < project.currentMilestone && ms.drawnAt === null);
}

export function drawnUsd(project: Project) {
  return project.milestones.reduce((sum, ms) => sum + (ms.drawnAt !== null ? ms.usd : 0n), 0n);
}

/** Budget × monthly rate × term, rounded down. */
export function holdTarget(project: Pick<Project, "budgetUsd" | "monthlyRateBps" | "termMonths">) {
  return project.budgetUsd * BigInt(project.monthlyRateBps) * BigInt(project.termMonths) / 10000n;
}

/** Interest in cents up to `to`: cent-days closed by repayments, plus each draw's outstanding
 * cents times the days (rounded up) since it was drawn, at monthly rate / 30 a day, rounded down. */
export function interestAt(project: Project, to: Date) {
  const end = seconds(to);
  let usdDays = project.closedUsdDays;
  for (const ms of project.milestones) {
    if (ms.drawnAt && end > seconds(ms.drawnAt)) usdDays += ms.outstandingUsd * ceilDays(end - seconds(ms.drawnAt));
  }
  return usdDays * BigInt(project.monthlyRateBps) / 300000n;
}

/** When the late fee starts (approved end date + grace), or null without an approved end date. */
export function lateFeeStart(project: Project, graceDays: number) {
  return project.endDate ? new Date(project.endDate.getTime() + graceDays * 86400 * 1000) : null;
}

/** Late fee rate in bps of what is paid: nothing until the approved end date + grace has passed;
 * then every day since the end date itself (rounded up, grace days included), capped at 100%. */
export function lateBps(project: Project, graceDays: number, now = new Date()) {
  const start = lateFeeStart(project, graceDays);
  if (!project.endDate || !start || now <= start) return 0n;
  const bps = ceilDays(seconds(now) - seconds(project.endDate)) * BigInt(project.lateFeeBpsPerDay);
  return bps < 10000n ? bps : 10000n;
}

/** Mirrors BROProjects `owed`: outstanding principal + interest − hold − interest already paid
 * above the hold (never below 0), plus the late fee on it. */
export function owed(project: Project, graceDays: number, now = new Date()) {
  const interest = interestAt(project, now);
  const extra = interest - project.holdUsd - project.interestPaidUsd;
  const principal = project.milestones.reduce((sum, ms) => sum + ms.outstandingUsd, 0n);
  const base = principal + extra > 0n ? principal + extra : 0n;
  const feeBps = lateBps(project, graceDays, now);
  const fee = base * feeBps / 10000n;
  return {
    interest,
    principal,
    base,
    /** Interest above the hold, paid by the contractor's installments. */
    aboveHold: extra > 0n ? extra : 0n,
    feeBps,
    fee,
    due: base + fee,
  };
}

/** Mirrors the `get_amount_due` view: live while open, 0 once repaid, recorded at default. */
export function amountDue(project: Project, graceDays: number, now = new Date()) {
  if (isOpen(project)) return owed(project, graceDays, now).due;
  return project.status === "Defaulted" ? project.defaultDueUsd : 0n;
}

/** The latest 30-day mark since launch, at or before `now`. */
export function latestMark(project: Project, now = new Date()) {
  if (!project.fundedAt || now < project.fundedAt) return null;
  const start = seconds(project.fundedAt);
  return fromSeconds(start + (seconds(now) - start) / PERIOD * PERIOD);
}

export function nextMark(project: Project, now = new Date()) {
  const latest = latestMark(project, now);
  return latest ? new Date(latest.getTime() + Number(PERIOD) * 1000) : null;
}

/** Mirrors `pay_interest`: cents payable from the hold now (0 when nothing is due). */
export function pendingHoldPayout(project: Project, now = new Date()) {
  const mark = latestMark(project, now);
  if (!mark || !project.paidUntil || mark <= project.paidUntil) return 0n;
  const earned = interestAt(project, mark);
  const target = earned < project.holdUsd ? earned : project.holdUsd;
  return target > project.holdUsedUsd ? target - project.holdUsedUsd : 0n;
}

/** What a draw of `cents` withholds for the interest hold, and what the contractor receives. */
export function drawSplit(project: Project, cents: bigint) {
  const left = holdTarget(project) - project.holdUsd;
  const withheld = cents < left ? cents : (left > 0n ? left : 0n);
  return { withheld, paid: cents - withheld };
}

/** BRO Builder's share of an interest amount (rounded down, like the contract). */
export function builderShare(amount: bigint, shareBps: number) {
  return amount * BigInt(shareBps) / 10000n;
}

/** The most a deposit worth `usd` cents can earn: all of the budget drawn at launch and kept for the whole term. */
export function maxInterest(project: Project, usd: bigint) {
  return usd * BigInt(project.monthlyRateBps) * BigInt(project.termMonths) / 10000n;
}

/** An investor's part of a project amount, in proportion to their BRO deposit (as the contract splits payouts). */
export function investorShare(project: Project, amount: bigint, investment: Investment) {
  return project.fundedBro > 0n ? amount * investment.bro / project.fundedBro : 0n;
}

/** BRO `claim_payout` would pay now: the investor's share of everything allotted so far, less what they claimed. */
export function claimable(project: Project, investment: Investment) {
  const total = investorShare(project, project.investorBro, investment);
  return total > investment.claimedBro ? total - investment.claimedBro : 0n;
}

/** When `mark_default` becomes possible, or null if it doesn't apply yet: after the approved end
 * date + grace, or (while Active) after the current milestone's due date + grace. Strictly after. */
export function defaultableAt(project: Project, graceDays: number) {
  if (!isOpen(project)) return null;
  const dates = [lateFeeStart(project, graceDays)];
  const ms = project.milestones[project.currentMilestone];
  if (project.status === "Active" && ms?.dueAt) dates.push(new Date(ms.dueAt.getTime() + graceDays * 86400 * 1000));
  const valid = dates.filter((d): d is Date => d !== null);
  return valid.length ? new Date(Math.min(...valid.map((d) => d.getTime()))) : null;
}

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  Funding: "Funding",
  Failed: "Failed",
  Active: "In progress",
  Repaying: "Repaying",
  Repaid: "Repaid",
  Defaulted: "Defaulted",
  Cancelled: "Cancelled",
};

export function formatBro(units: bigint, decimals: number | undefined, maximumFractionDigits = 2) {
  if (decimals === undefined) return "—";
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toLocaleString("en-US");
  const fraction = (abs % base).toString().padStart(decimals, "0").slice(0, maximumFractionDigits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""} BRO`;
}

/** RFC 3339 without milliseconds, as Michelson timestamps expect. */
export function toTimestamp(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatDate(value: Date | null) {
  return value ? value.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";
}

export function formatDateTime(value: Date | null) {
  return value ? value.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
}

export function bpsToPct(bps: number | bigint) {
  return `${(Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/** A monthly rate in bps as a daily percentage (rate / 30), e.g. 400 -> 0.1333%. */
export function dailyRatePct(monthlyBps: number) {
  return `${formatUnits(BigInt(monthlyBps) * 100n / 30n, 4)}%`;
}
