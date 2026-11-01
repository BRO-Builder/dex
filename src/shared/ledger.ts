import { isValidAddress } from "./tezos";
import { toBigInt } from "./units";

// BROFunding: listings, deposits, refunds. BROProjects: milestones, repayment, settlement.
export const FUNDING_ADDRESS = import.meta.env.VITE_FUNDING_ADDRESS as string | undefined;
export const PROJECTS_ADDRESS = import.meta.env.VITE_PROJECTS_ADDRESS as string | undefined;
export const DEX_ADDRESS = import.meta.env.VITE_DEX_ADDRESS as string | undefined;

const DAY_MS = 86400 * 1000;
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
  netUsd: bigint;
  lateFeeUsd: bigint;
  claimed: boolean;
};

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
  interestBps: number;
  termMonths: number;
  lateFeeBpsPerDay: number;
  fundedUsd: bigint;
  fundedBro: bigint;
  fundedAt: Date | null;
  milestones: Milestone[];
  currentMilestone: number;
  repaidUsd: bigint;
  repaidBro: bigint;
  settledPoolBro: bigint;
  uncoveredBro: bigint;
  status: ProjectStatus;
};

export type Investment = { projectId: number; usd: bigint; bro: bigint; settledClaimed: boolean };

export type FundingStorage = {
  admin: string;
  paused: boolean;
  market: string;
  projectsContract: string | null;
  tokenAddress: string;
  tokenId: string;
  lateFeeBpsPerDay: number;
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
        netUsd: toBigInt(ms?.net_usd ?? 0),
        lateFeeUsd: toBigInt(ms?.late_fee_usd ?? 0),
        claimed: Boolean(ms?.claimed),
      };
    })
    .sort((a, b) => a.index - b.index);
  // TzKT renders a unit variant as {"Funding": {}}
  const listed = Object.keys(listing.status)[0];
  const status = (listed === "Launched" ? (launched ? Object.keys(launched.status)[0] : "Active") : listed) as ProjectStatus;
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
    interestBps: Number(listing.interest_bps),
    termMonths: Number(listing.term_months),
    lateFeeBpsPerDay: Number(listing.late_fee_bps_per_day),
    fundedUsd: toBigInt(listing.funded_usd),
    fundedBro: toBigInt(listing.funded_bro),
    fundedAt: date(launched?.funded_at ?? listing.funded_at),
    milestones,
    currentMilestone: Number(launched?.current_milestone ?? 0),
    repaidUsd: toBigInt(launched?.repaid_usd ?? 0),
    repaidBro: toBigInt(launched?.repaid_bro ?? 0),
    settledPoolBro: toBigInt(launched?.settled_pool_bro ?? 0),
    uncoveredBro: toBigInt(launched?.uncovered_bro ?? 0),
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
  const claimedIds = new Set(claimed.map((key: any) => String(key.key.nat)));
  return deposits.map((key: any) => ({
    projectId: Number(key.key.nat),
    usd: toBigInt(key.value.usd),
    bro: toBigInt(key.value.bro),
    settledClaimed: claimedIds.has(String(key.key.nat)),
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
// Project rules, mirrored from BROFunding / BROProjects
// ---------------------------------------------------------------------------

/** Budget plus interest, in cents. */
export function amountDue(project: Project) {
  return project.budgetUsd * BigInt(10000 + project.interestBps) / 10000n;
}

export function entitlement(project: Project, bro: bigint) {
  return bro * BigInt(10000 + project.interestBps) / 10000n;
}

export function payoutFor(project: Project, investment: Investment) {
  return project.fundedBro > 0n ? project.settledPoolBro * investment.bro / project.fundedBro : 0n;
}

export function isRefundable(project: Project, now = new Date()) {
  return project.status === "Failed" || project.status === "Cancelled" || (project.status === "Funding" && now > project.fundingDeadline);
}

export function unclaimedApproved(project: Project) {
  return project.milestones.filter((ms) => ms.index < project.currentMilestone && !ms.claimed);
}

/** Late days (rounded up) and fee for approving the current milestone at `now`. */
export function lateFeePreview(project: Project, now = new Date()) {
  const ms = project.milestones[project.currentMilestone];
  if (!ms || !ms.dueAt) return null;
  const lateMs = now.getTime() - ms.dueAt.getTime();
  const lateDays = lateMs > 0 ? Math.ceil(lateMs / DAY_MS) : 0;
  const feeBps = Math.min(10000, lateDays * project.lateFeeBpsPerDay);
  const netUsd = ms.usd * BigInt(10000 - feeBps) / 10000n;
  return { milestone: ms, lateDays, feeBps, netUsd, feeUsd: ms.usd - netUsd };
}

export function termEnd(project: Project, graceDays: number) {
  return project.fundedAt ? new Date(project.fundedAt.getTime() + (project.termMonths * 30 + graceDays) * DAY_MS) : null;
}

/** When `mark_default` becomes possible, or null if it never applies. */
export function defaultableAt(project: Project, graceDays: number) {
  if (project.status !== "Active" && project.status !== "Repaying") return null;
  const dates = [termEnd(project, graceDays)];
  const ms = project.milestones[project.currentMilestone];
  if (project.status === "Active" && ms?.dueAt) dates.push(new Date(ms.dueAt.getTime() + graceDays * DAY_MS));
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

export function bpsToPct(bps: number) {
  return `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}
