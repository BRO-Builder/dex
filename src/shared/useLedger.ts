import { useEffect, useState } from "react";
import { configError, fetchLedgerStorage, fetchProjects, type LedgerStorage, type Project } from "./ledger";
import type { useWallet } from "./tezos";

/** BROFunding + BROProjects storage and every project (merged), with a manual reload. */
export function useLedger(wallet: ReturnType<typeof useWallet>) {
  const [storage, setStorage] = useState<LedgerStorage | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(configError("funding", "projects"));

  async function reload() {
    if (configError("funding", "projects")) return;
    try {
      const [nextStorage, nextProjects] = await Promise.all([
        fetchLedgerStorage(wallet.selected.api),
        fetchProjects(wallet.selected.api),
      ]);
      setStorage(nextStorage);
      setProjects(nextProjects);
      setError(null);
    } catch (error) {
      console.error("Ledger:", error);
      setError(`Couldn't load the ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  useEffect(() => {
    void reload();
  }, [wallet.selected.api]);

  return { storage, projects, error, reload };
}
