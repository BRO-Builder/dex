# CLAUDE.md

BRO Builder DEX: a Tezos DApp (React 19 + TypeScript + Vite) with a DEX, baker voting
and the BRO Build Pool, plus a PHP price oracle under `server/oracle/`. Smart contracts
live in a separate repo: https://github.com/BRO-Builder/web3.

## Rules

- **Verify with `npm run build`.** There is no test suite (`npm test` is a placeholder).
  `npm run build` runs `tsc --noEmit && vite build`. Run it after every change and fix
  any errors before reporting the work done.
- **Default to testnet.** For anything that sends a Tezos transaction (wallet operations,
  oracle runs, contract calls), use Shadownet. Ask before doing anything on Mainnet.
  For the oracle, use `?dry_run=1` first.

## Commands

```sh
npm run dev       # Vite dev server
npm run build     # type-check + production build into dist/
npm run preview   # serve dist/
```

## Architecture

Vite multi-page app. `vite.config.ts` defines four HTML entry points:

| HTML entry | Script | Pages |
|---|---|---|
| `index.html` | `src/main.tsx` | React Router SPA: `/` → `DexPage`, `/voting` → `VotingPage` (`/bro-builder-voting.php` is a legacy alias; unknown paths fall back to `DexPage`) |
| `build-pool.html` | `src/build-pool.tsx` | `BuildPoolPage` |
| `portfolio.html` | `src/portfolio.tsx` | `PortfolioPage` |
| `approver.html` | `src/approver.tsx` | `ApproverPage` |

The Build Pool pages share `src/components/PoolShell.tsx` (layout, nav between the three
`.html` pages, `useOperations` sign-and-send review modal, `ConfigError`) and
`src/build-pool.css`. The DEX and Voting pages use `src/styles.css`.

`src/shared/`:
- `tezos.ts`: `NETWORKS` (RPC, TzKT API, explorer URLs) and `useWallet()` (Taquito +
  Beacon wallet). The network comes from `VITE_NETWORK`, defaulting to Mainnet.
- `dex.ts`: reads BRODex storage from TzKT and the XTZ/USD price from Coinbase.
- `ledger.ts`: BROFunding / BROProjects types, storage parsing, and USD/BRO math.
  Ledger prices are BRO base units per USD cent × 10^6 (`PRICE_SCALE`).
- `useLedger.ts`, `useMarket.ts`: hooks that load funding/projects storage and the
  BROMarketAssistant (its address is read from the projects storage, not from env).
- `bakers.ts`: preset baker lists per network (currently empty).
- `tokenMetadata.ts`, `units.ts`: token metadata/balances and bigint helpers.

Chain reads go through the TzKT API (`/v1/contracts/{address}/storage`); writes go
through Taquito `toolkit.wallet.at(address).methodsObject.<entrypoint>(...)`. Token
amounts are `bigint`.

## Environment

`.env` (gitignored) holds frontend `VITE_*` variables and the oracle's secrets. Don't
print or commit its values.

Read by the frontend: `VITE_NETWORK` (`mainnet` | `shadownet`), `VITE_DEX_ADDRESS`,
`VITE_DELEGATION_ADDRESS`, `VITE_FUNDING_ADDRESS`, `VITE_PROJECTS_ADDRESS`.
`VITE_TOKEN_ADDRESS` and `VITE_MARKET_ADDRESS` appear in `.env` but no code reads them.

Supported networks are Mainnet and Shadownet. `NETWORKS` still lists Ghostnet, but the
oracle doesn't support it and it isn't advertised.

## Oracle (`server/oracle/`)

PHP 8.1+ service that pushes the BRO/USD price to `BROMarketAssistant.update_price`.
Only `public/update-price.php` belongs in the web root. It forges and signs operations
locally (`src/Forge.php`, sodium). Its env variables, deployment and first-run steps are
in `server/oracle/README.md`; keep that file up to date when changing the oracle.

The oracle and the Build Pool pages compute BRO/USD the same way (BRODex token→XTZ quote
× Coinbase XTZ/USD). Keep the two in sync.

## Deployment

Cloudflare Workers static assets (`wrangler.toml` serves `./dist` with SPA fallback),
deployed by Cloudflare's Git integration on push, with preview builds for branches. The
live site is https://dex.brobuilder.eidoriantan.com. The oracle is deployed separately
on a PHP host.
