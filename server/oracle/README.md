# BRO price oracle (PHP)

Pushes the BRO/USD price to `BROMarketAssistant.update_price`. BROFunding and
BROProjects read that price to value deposits, milestone claims and repayments.

**Price:** BRODex `get_price_token_to_xtz(1 BRO)` × Coinbase XTZ/USD. The Build Pool
pages use the same formula. It is sent in the contracts' unit: BRO base units per USD
cent × 10^6.

**When it pushes:** a call sends `update_price` only if one of these holds:
- there is no on-chain price yet,
- the price moved by at least `PRICE_DEVIATION_BPS`,
- the on-chain price is older than `PRICE_HEARTBEAT_SECONDS`.

Otherwise it returns `"status": "skipped"`.

## Requirements

- PHP 8.1+ with `curl`, `sodium` and `json` (all bundled with standard builds).
- A **tz1 (ed25519)** oracle wallet. It must hold a little XTZ for fees and be
  **revealed**: send any transaction from it once with a normal wallet. Encrypted
  keys and tz2/tz3 keys are not supported.
- The market assistant's `oracle` must be set to this wallet's address (BRO Builder Web3 Portal →
  `/deployment-projects-setup` → Oracle and DEX).

## Layout

```
public/update-price.php   the only file that belongs in the web root
src/                      classes; keep them outside the web root
```

The operation is forged locally (`src/Forge.php`) and signed with sodium, so the RPC
node never builds the bytes the key signs. Before injecting, the script checks that
the node returns the expected operation hash.

## Environment variables

| Name | Required | Example / default |
|---|---|---|
| `ORACLE_SECRET_KEY` | yes | `edsk...` (unencrypted ed25519, 54 or 98 characters) |
| `ORACLE_HTTP_TOKEN` | yes | random string, at least 32 characters (`openssl rand -hex 32`) |
| `TEZOS_NETWORK` | no | `mainnet` (default) or `shadownet` |
| `TEZOS_RPC_URL` | no | defaults to the network's: `https://rpc.tzkt.io/mainnet` or `https://rpc.tzkt.io/shadownet` |
| `TZKT_API_URL` | no | defaults to the network's: `https://api.tzkt.io` or `https://api.shadownet.tzkt.io` |
| `MARKET_ADDRESS` | yes | the BROMarketAssistant `KT1...` |
| `DEX_ADDRESS` | yes | the BRODex `KT1...` |
| `PRICE_DEVIATION_BPS` | no | `100` (1%) |
| `PRICE_HEARTBEAT_SECONDS` | no | `2700` (45 minutes); keep it below the market's `max_price_age` |
| `MIN_PUSH_INTERVAL_SECONDS` | no | `120`; skips a new push while the last one may not be indexed yet |
| `ORACLE_STATE_DIR` | no | system temp dir; must be writable (lock and last-push state files) |
| `COINBASE_URL` | no | `https://api.coinbase.com/v2/prices/XTZ-USD/spot` |

Apache: `SetEnv NAME value` in the vhost (not in a web-readable `.htaccess`).
Nginx + PHP-FPM: `fastcgi_param NAME value;` or `env[NAME] = value` in the pool config.

`MARKET_ADDRESS`, `DEX_ADDRESS` and the oracle key must belong to the same network as
`TEZOS_NETWORK`; set the page's `VITE_NETWORK` to match. On Shadownet the XTZ/USD rate
still comes from Coinbase (the real mainnet rate), multiplied by the Shadownet DEX's
BRO/XTZ quote.

## Calling it

Use any scheduler, for example every 5 minutes. Keep the interval well under the
heartbeat.

```sh
curl -fsS -X POST -H "Authorization: Bearer $ORACLE_HTTP_TOKEN" https://your-host/update-price.php
```

The token can also be sent as an `X-Oracle-Token` header, or as `?token=` if your
scheduler can't set headers (query strings may end up in access logs). Add
`?dry_run=1` to see the computed price and the decision without sending anything.

The response is JSON. `status` is `pushed` (with `op_hash`), `skipped`, `dry_run` or
`error`, and the response also carries the computed and on-chain prices. Errors are
also written to the PHP error log.

## Before the first live run

1. Call with `?dry_run=1`. Until the oracle is set, the error names this key's address. Set the market assistant's `oracle` to that address.
2. Run once with `?dry_run=1` and check that `bro_usd` matches the Build Pool page.
3. Run without `dry_run`. Check the `op_hash` on TzKT.
