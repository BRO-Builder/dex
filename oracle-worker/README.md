# BRO price oracle (Node)

An Express server that pushes the BRO/USD price to `BROMarketAssistant.update_price`
on demand. There is no schedule: the Build Pool pages call it before invest, milestone
claim and repay, so a transaction is only paid for when someone is about to need the
price.

**Price:** BRODex `get_price_token_to_xtz(1 BRO)` × Coinbase XTZ/USD, in the contracts'
unit (BRO base units per USD cent × 10^6). This matches `server/oracle/`.

**When it sends:** age is the only rule. A request sends `update_price` only if there is
no on-chain price yet, or the on-chain price is at least `PRICE_MIN_AGE_SECONDS` old.
How far the price moved is not considered.

Only one oracle may run live at a time. This server and `server/oracle/` sign with the
same wallet, so running both wastes fees and collides on its counter. Run a single
instance of this server too: its in-flight and pending state is in memory.

## Requirements

- Node 22+.
- An oracle wallet holding a little XTZ for fees. An unrevealed wallet is revealed
  automatically by the first update.
- The market assistant's `oracle` set to this wallet's address (BRO Builder Web3 Portal →
  `/deployment-projects-setup` → Oracle and DEX). The address is printed on startup.

## Environment variables

Copy `.env.example` to `.env`. `MARKET_ADDRESS`, `DEX_ADDRESS` and the key must belong to
`TEZOS_NETWORK`.

| Name | Required | Example / default |
|---|---|---|
| `ORACLE_SECRET_KEY` | yes | unencrypted `edsk...` key |
| `MARKET_ADDRESS` | yes | the BROMarketAssistant `KT1...` |
| `DEX_ADDRESS` | yes | the BRODex `KT1...` |
| `TEZOS_NETWORK` | no | `shadownet` (default) or `mainnet` |
| `TEZOS_RPC_URL` | no | defaults to the network's |
| `TZKT_API_URL` | no | defaults to the network's |
| `PRICE_MIN_AGE_SECONDS` | no | `900` (15 minutes); must be below the market's `max_price_age` |
| `PENDING_PUSH_SECONDS` | no | `120`; after a send, requests get `pending` for this long instead of sending again |
| `PORT` | no | `3001` |
| `DRY_RUN` | no | `1` computes the price and decision without sending |
| `COINBASE_URL` | no | `https://api.coinbase.com/v2/prices/XTZ-USD/spot` |

Set the frontend's `VITE_ORACLE_URL` to this server's public URL. While it's unset, the
pages keep disabling price-based actions when the price is stale.

## Running

```sh
npm ci
npm run dev                # or: npm run build && npm start
```

## API

`POST /update-price` takes no input and no token. `GET /health` reports the network and
whether this is a dry run.

| `status` | Meaning |
|---|---|
| `skipped` | The on-chain price is younger than the threshold. |
| `pushed` | Injected, with `op_hash`. It isn't in a block yet. |
| `pending` | An update was just sent, with its `op_hash`. |
| `dry_run` | `DRY_RUN=1`: includes the price that would be sent. |
| `error` | HTTP 502. Details are in the server log only. |

The response doesn't wait for a block. After `pushed` or `pending`, the caller has to wait
for `op_hash` to be applied before relying on the new price; `src/shared/oracle.ts` does
this by polling TzKT.

## Security

The endpoint is public because a browser can't keep a token. CORS allows every origin
(`Access-Control-Allow-Origin: *`): it only limits which sites can read the response and
never stopped direct calls, so restricting it protected nothing. What limits spending is the age
threshold: at most 24h / `PRICE_MIN_AGE_SECONDS` updates a day, about 96 at the default,
however often the endpoint is called. Fresh-price requests are answered from memory.

## Before the first live run

1. Start with `DRY_RUN=1` on Shadownet and `POST /update-price`. Until the market's oracle
   is set, the log names the mismatch.
2. Check that `bro_usd` in the response matches the Build Pool page.
3. Remove `DRY_RUN` and call it once. Check the `op_hash` on TzKT.
