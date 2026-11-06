/** Base URL of the on-demand price oracle (oracle-worker/). Unset means no on-demand updates. */
export const ORACLE_URL = (import.meta.env.VITE_ORACLE_URL as string | undefined)?.replace(/\/+$/, "") || undefined;

const POLL_MS = 3000;
const POLL_TIMEOUT_MS = 120000;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** The server returns as soon as it injects, so wait here until the update is in a block.
 * TzKT returns an empty list until it has indexed the operation. */
async function waitForOperation(api: string, hash: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`${api}/v1/operations/${hash}`);
    const operations = response.ok ? await response.json() : [];
    if (operations.length > 0) {
      if (operations.every((operation: { status: string }) => operation.status === "applied")) return;
      throw new Error("The BRO price update failed on-chain.");
    }
    await wait(POLL_MS);
  }
  throw new Error("The BRO price update is taking too long. Try again shortly.");
}

/** Asks the oracle to update the on-chain price if it's old enough. The oracle decides
 * that from the price's age, so this is cheap to call before every price-based action. */
export async function requestPriceUpdate(api: string) {
  if (!ORACLE_URL) return;
  const response = await fetch(`${ORACLE_URL}/update-price`, { method: "POST" });
  if (!response.ok) throw new Error("Couldn't update the BRO price.");
  const result: { status: string; op_hash?: string } = await response.json();
  if (result.op_hash) await waitForOperation(api, result.op_hash);
}
