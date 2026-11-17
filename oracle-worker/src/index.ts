import { InMemorySigner } from "@taquito/signer";
import cors from "cors";
import express from "express";
import { loadConfig } from "./config.js";
import { Oracle } from "./oracle.js";

const config = loadConfig();
const signer = await InMemorySigner.fromSecretKey(config.secretKey);
const oracle = new Oracle(config, signer);

const app = express();
app.disable("x-powered-by");
// Any origin may call it: CORS can't stop direct calls anyway, the age threshold limits spending.
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok", network: config.network, dry_run: config.dryRun });
});

// Public by design: the frontend calls it, so it takes no input and no token.
// The age threshold is what limits spending, not who may call it.
app.post("/update-price", async (_request, response) => {
  response.set("Cache-Control", "no-store");
  try {
    const result = await oracle.run();
    if (result.status === "pushed") console.log(`pushed ${result.op_hash}: ${result.reason} price=${result.price}`);
    response.json(result);
  } catch (error) {
    // Upstream and contract details go to the log only.
    console.error("update-price failed:", error);
    response.status(502).json({ status: "error", error: "The price update failed." });
  }
});

const address = await signer.publicKeyHash();
app.listen(config.port, () => {
  console.log(`BRO oracle on :${config.port} (${config.network}, ${address}, threshold ${config.minPriceAgeSeconds} s${config.dryRun ? ", dry run" : ""})`);
});
