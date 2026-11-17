# BRO Builder Decentralized Exchange DApp

The official decentralized exchange (DEX) for BRO Builder, built on Tezos. Trade BRO
Token, provide liquidity, vote on the pool's baker, and fund construction projects
through the BRO Build Pool.

**Live app:** https://dex.brobuilder.eidoriantan.com

## Features

### DEX
- **Swap** between XTZ and BRO, with adjustable slippage.
- **Add liquidity** to the XTZ/BRO pool and receive pool shares. When you add
  liquidity you can also vote for a baker in the same step.

### Voting
Liquidity providers vote, weighted by their pool shares, for the baker that the pool's
XTZ is delegated to. The page shows the current baker, the votes for each baker and your
own vote, which you can change or withdraw.

### Build Pool
- **Fund projects:** browse construction projects (residential or commercial), filter
  by status and type, and invest BRO in projects that are open for funding.
- **Request funding:** contractors submit a project with its scope, site, budget,
  term, funding deadline and milestones. The monthly interest rate (3–9%) is quoted by
  the BRO rate API for the contractor's wallet, budget and term.

Interest is charged by the day, only on money the contractor has drawn. An interest
hold (budget × monthly rate × term) is withheld from the first draws and pays
investors every 30 days. BRO Builder takes a share of investors' interest.

Project, site and owner details are stored on-chain in plain text and are public.

### Portfolio
- **My investments:** see a statement for each project you funded (interest so far,
  fees, undrawn money returned, what you can claim), get refunds from projects that
  failed to fund, and claim payouts as interest, undrawn money and principal come in.
- **My projects:** for contractors, draw approved milestones, repay at any time
  (including early) and propose an end date.

### Approver
For the projects admin and approver NFT holders: approve milestones and mark overdue
projects as defaulted. The projects admin also approves or rejects end dates. Anyone can
pay the interest due from a project's hold every 30 days and, after the end date,
return undrawn money to investors (also available on the Portfolio page).

## Networks

The app runs on **Tezos Mainnet** and **Shadownet** (testnet). Use a Tezos wallet that
supports Beacon, such as Temple or Kukai.

Build Pool prices are in USD. The app converts them to BRO using the BRO/USD price that
the BRO price oracle publishes on-chain. When that price is out of date, investing,
draws, interest payouts, repayments and defaults are paused until it updates.

## Smart contracts

The Tezos smart contracts that this app uses (BRODex, the delegation contract,
BROFunding, BROProjects and BROMarketAssistant) are in
[BRO-Builder/web3](https://github.com/BRO-Builder/web3).

## Run locally

Requires Node.js and npm.

```sh
npm install
npm run dev
```

Create a `.env` file in the project root with the network and the contract addresses
to use:

```sh
VITE_NETWORK=shadownet            # mainnet or shadownet
VITE_DEX_ADDRESS=KT1...           # BRODex
VITE_DELEGATION_ADDRESS=KT1...    # pool baker voting
VITE_FUNDING_ADDRESS=KT1...       # BROFunding (Build Pool)
VITE_PROJECTS_ADDRESS=KT1...      # BROProjects (Build Pool)
```

`npm run build` type-checks the code and builds the site into `dist/`.

The BRO price oracle is a separate PHP service. See
[server/oracle/README.md](server/oracle/README.md).
