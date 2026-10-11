import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { AnimatedLogo } from "./AnimatedLogo";
import { WalletBar } from "./Controls";
import type { useWallet } from "../shared/tezos";

type Wallet = ReturnType<typeof useWallet>;

export type OperationStep = { contract: string; entrypoint: string; params?: unknown; mutez?: string };

export type Review = { title: string; text: string; steps: OperationStep[]; onDone: () => void };

const PAGES = [
  { key: "build-pool", href: "build-pool.html", label: "Build Pool" },
  { key: "portfolio", href: "portfolio.html", label: "Portfolio" },
  { key: "approver", href: "approver.html", label: "Approver" },
] as const;

export function PoolShell({ wallet, active, title, subtitle, children }: {
  wallet: Wallet; active: (typeof PAGES)[number]["key"]; title: string; subtitle: string; children: ReactNode;
}) {
  return <main className="wrap">
    <div className="brand">
      <AnimatedLogo />
      <h1 style={{ paddingTop: "10px" }}>BRO <span>{title}</span></h1>
      <p style={{ marginTop: "0px" }}>{subtitle}</p>
    </div>
    <nav className="page-links">
      {PAGES.map((page) => <a href={page.href} className={page.key === active ? "active" : ""} key={page.key}>{page.label}</a>)}
    </nav>
    <WalletBar wallet={wallet} />
    {children}
  </main>;
}

export function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "errors" in error) {
    // Taquito TezosOperationError: surface the contract's FAILWITH string
    const errors = (error as { errors: { with?: { string?: string } }[] }).errors;
    const failwith = errors.map((item) => item.with?.string).find(Boolean);
    if (failwith) return failwith;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Wraps steps so `operator` may move `owner`'s BRO only for this batch. */
export function withOperator(token: { address: string; tokenId: string }, owner: string, operator: string, steps: OperationStep[]): OperationStep[] {
  const permission = { owner, operator, token_id: token.tokenId };
  return [
    { contract: token.address, entrypoint: "update_operators", params: [{ add_operator: permission }] },
    ...steps,
    { contract: token.address, entrypoint: "update_operators", params: [{ remove_operator: permission }] },
  ];
}

/** Review-then-sign flow for batched contract calls, plus a toast. */
export function useOperations(wallet: Wallet) {
  const [review, setReview] = useState<Review | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  function showToast(message: string) {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4500);
  }

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useEffect(() => {
    if (!review) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReview(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [review]);

  /** The connected address, prompting for a wallet if needed. Null means stop. */
  async function requireAddress() {
    if (wallet.address) return wallet.address;
    try {
      return await wallet.connect();
    } catch (error) {
      showToast(`Wallet connection failed: ${errorMessage(error)}`);
      return null;
    }
  }

  async function send(steps: OperationStep[]) {
    try {
      const { toolkit } = await wallet.ensureWallet();
      const batch = toolkit.wallet.batch();
      for (const step of steps) {
        if (step.entrypoint === "default") {
          batch.withTransfer({ to: step.contract, amount: Number(step.mutez ?? 0), mutez: true });
          continue;
        }
        const contract: any = await toolkit.wallet.at(step.contract);
        const method = contract.methodsObject[step.entrypoint](step.params);
        batch.withContractCall(method, step.mutez ? { amount: Number(step.mutez), mutez: true } : undefined);
      }
      const operation = await batch.send();
      showToast(`Operation submitted: ${operation.opHash}`);
      await operation.confirmation();
      return true;
    } catch (error) {
      showToast(`Operation failed: ${errorMessage(error)}`);
      return false;
    }
  }

  function confirm() {
    if (!review) return;
    const { steps, onDone } = review;
    setReview(null);
    void send(steps).then((sent) => sent && onDone());
  }

  const elements = <>
    {review && (
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setReview(null);
      }}>
        <div className="modal review-modal" role="dialog" aria-modal="true" aria-labelledby="review-modal-title">
          <h2 id="review-modal-title">{review.title}</h2>
          <div className="desc">{review.text}</div>
          <pre>{JSON.stringify(review.steps, null, 2)}</pre>
          <div className="modal-actions review-actions">
            <button type="button" className="secondary" onClick={() => setReview(null)}>Cancel</button>
            <button type="button" className="primary" autoFocus onClick={confirm}>Sign &amp; Send</button>
          </div>
        </div>
      </div>
    )}
    {toast && <div className="toast" role="status">{toast}</div>}
  </>;

  return { setReview, showToast, requireAddress, elements };
}

export function ConfigError({ message }: { message: string | null }) {
  return message ? <div className="card"><div className="err" style={{ marginTop: 0 }}>{message}</div></div> : null;
}
