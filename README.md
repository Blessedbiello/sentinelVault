# SentinelVault

**Autonomous AI Agent Wallet Framework for Solana**

> Secure, multi-agent orchestration with encrypted keystores, policy-driven security, and real-time monitoring -- built for the autonomous economy.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)
![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)
![Solana](https://img.shields.io/badge/Solana-devnet%20%7C%20mainnet-blueviolet.svg)

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Demo Walkthrough](#demo-walkthrough)
- [Features](#features)
- [Usage Guide](#usage-guide)
- [CLI Reference](#cli-reference)
- [REST API Reference](#rest-api-reference)
- [Security Deep Dive](#security-deep-dive)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Configuration](#configuration)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

SentinelVault is a framework for deploying autonomous AI agents that manage their own Solana wallets. It provides the infrastructure needed to build, secure, and orchestrate intelligent agents that can independently execute on-chain transactions, manage liquidity positions, and respond to market conditions -- all within a robust security boundary that you define.

> **For judges:** Run `npm run demo:showcase` to see all bounty requirements exercised on devnet in one script. See [SKILLS.md](SKILLS.md) for detailed agent capability mapping and [DEEP_DIVE.md](DEEP_DIVE.md) for architecture analysis and benchmarks.

### What It Does

At its core, SentinelVault bridges the gap between autonomous AI decision-making and secure blockchain operations. Agents observe on-chain and off-chain data, orient themselves using configurable strategies, decide on actions through an OODA decision loop, and act by submitting transactions to the Solana network. The framework handles the hard parts: key management, transaction signing, policy enforcement, rate limiting, and audit logging.

### Key Differentiators

- **AES-256-GCM Encrypted Keystores** -- Private keys are never stored in plaintext. Keystores use AES-256-GCM encryption with PBKDF2 key derivation (100,000 iterations) and are securely wiped from memory after use.
- **OODA Decision Loop** -- Each agent follows an Observe-Orient-Decide-Act cycle, providing a structured and auditable decision-making process.
- **8-Layer Security Policy Engine** -- Every transaction passes through eight independent validation layers before reaching the network, covering spending limits, rate controls, time windows, recipient whitelists, and more.
- **Multi-Agent Orchestration** -- Run multiple specialized agents in parallel with coordinated resource sharing, priority scheduling, and inter-agent communication.
- **Real-Time Dashboard** -- Monitor agent activity, wallet balances, transaction history, and security events through a live web dashboard with WebSocket updates.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  CLI / Dashboard                      │
│          Command Line  |  REST API  |  WebSocket      │
├──────────────────────────────────────────────────────┤
│               Agent Orchestrator                      │
│    ┌───────────┐  ┌───────────┐  ┌───────────┐      │
│    │  Trading  │  │ Liquidity │  │  Custom   │      │
│    │   Agent   │  │   Agent   │  │   Agent   │      │
│    └─────┬─────┘  └─────┬─────┘  └─────┬─────┘      │
│          │              │              │              │
│    ┌─────┴──────────────┴──────────────┴─────┐       │
│    │           OODA Decision Loop             │       │
│    │   Observe -> Orient -> Decide -> Act     │       │
│    └─────────────────┬───────────────────┘       │
├──────────────────────┴───────────────────────────┤
│                 Security Layer                        │
│   Policy Engine  |  Audit Logger  |  Rate Limiter    │
│   Circuit Breaker  |  Recipient Whitelist            │
├──────────────────────────────────────────────────────┤
│                Core Wallet Layer                      │
│   Keystore Manager  |  AgenticWallet  |  Retry Logic  │
│   Price Feed  |  Jupiter Quotes  |  AI Advisor       │
├──────────────────────────────────────────────────────┤
│                  Solana Network                       │
│            devnet  |  testnet  |  mainnet-beta        │
└──────────────────────────────────────────────────────┘
```

**Layer Responsibilities:**

- **CLI / Dashboard** -- User-facing interfaces for managing agents, wallets, and monitoring activity.
- **Agent Orchestrator** -- Coordinates multiple agents, manages lifecycle events, handles resource allocation, and provides inter-agent messaging.
- **OODA Decision Loop** -- The cognitive core of each agent: observe market data, orient against strategy parameters, decide on actions, and act through the transaction engine.
- **Security Layer** -- Enforces policies on every transaction, logs all activity for audit purposes, and applies rate limits and circuit breakers.
- **Core Wallet Layer** -- Manages encrypted keystores, constructs and signs transactions, handles retry logic, and integrates real price feeds (Jupiter/CoinGecko), Jupiter DEX quotes, and optional AI advisor.
- **Solana Network** -- The underlying blockchain where all transactions are submitted and confirmed.

---

## Judge Quick Start

Three commands to see everything working:

```bash
npm install           # Install dependencies
npm test              # Run full test suite (237 tests)
npm run demo:showcase # Live demo on Solana devnet (all features)
```

---

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- Solana CLI (optional, for devnet setup)

### Installation

```bash
# Clone the repository
git clone https://github.com/Blessedbiello/sentinelVault.git
cd sentinelVault

# Install dependencies
npm install

# Run initial setup (configures devnet, creates demo wallets)
npm run setup    # or: bash scripts/setup-devnet.sh

# Run the showcase demo (recommended — exercises all bounty requirements)
npm run demo:showcase

# Or run the full multi-agent demo on devnet
npm run demo
```

### Verify Installation

```bash
# Run the test suite to confirm everything works
npm test

# Type check
npx tsc --noEmit

# Check CLI availability
npx ts-node src/cli/index.ts --help
```

---

## Demo Walkthrough

Running `npm run demo:showcase` exercises all five bounty requirements against Solana devnet in a single script:

### What Happens

1. **Wallet Creation** — Two agents (Alpha-Trader, Beta-Trader) each get their own AES-256-GCM encrypted wallet with unique Solana addresses
2. **Funding** — Each wallet receives 1 SOL via devnet airdrop (with automatic retry)
3. **SOL Transfer** — Alpha transfers 0.1 SOL to Beta, verifiable on Solana Explorer
4. **SPL Token Operations** — Alpha creates a SENTINEL token mint, mints 1M tokens, transfers 500K to Beta
5. **Protocol Interaction** — Both agents write on-chain memos via Memo Program v2
6. **Agent-to-Agent Trading** — Agents target each other's wallets, run OODA loops with multi-factor quantitative decisions
7. **Live Dashboard** — REST API (port 3000) + WebSocket (port 3001) serve real-time agent state
8. **Final Report** — Balances, transaction count, volume, security summary, and Explorer URLs

### Sample Output

```
── Step 1 — Wallet Creation ──────────────────────
✓ Alpha-Trader  3Kj8nPq2...
✓ Beta-Trader   7mRx4wL1...
✓ Wallet addresses are unique

── Step 2 — Airdrop Funding ──────────────────────
✓ Alpha funded: 1.000 SOL
✓ Beta funded:  1.000 SOL

── Step 3 — SOL Transfer (Alpha → Beta) ─────────
✓ SOL transfer — sig: 5xPm3kR2...
✓ Agent-to-agent SOL transfer verified

── Step 4 — SPL Token Operations ─────────────────
✓ Token mint created: 9pVx2kM3...
✓ Minted 1,000,000 SENTINEL tokens
✓ Transferred 500,000 tokens to Beta
✓ SPL token hold + transfer verified

── Step 5 — Memo Program (dApp Interaction) ──────
✓ Alpha memo — sig: 4rTx8nQ2...
✓ Beta memo  — sig: 2mKp6wR1...
✓ On-chain memos written and confirmed

── Step 6 — Agent OODA Trading ───────────────────
✓ Alpha decision: BUY  (confidence: 0.72, factors: trend↑ momentum↑ vol↓)
✓ Beta decision:  HOLD (confidence: 0.45, factors: trend→ momentum↓ vol→)

── Final Report ──────────────────────────────────
  Transactions: 8 submitted, 8 confirmed
  Volume: 1.6 SOL + 500K SPL tokens
  Security: 0 policy violations, 0 circuit breaker trips
```

All transaction signatures are verifiable on [Solana Explorer](https://explorer.solana.com/?cluster=devnet).

---

## Features

### Encrypted Keystores (AES-256-GCM + PBKDF2)

Private keys are encrypted at rest using AES-256-GCM with a key derived from a user-supplied password through PBKDF2 (100,000 iterations, SHA-512). Each keystore file includes a unique salt and initialization vector. Keys are securely wiped from memory after signing operations complete.

### Multi-Agent Orchestration

Deploy and coordinate multiple specialized agents from a single orchestrator. Agents can share wallet resources, communicate through an internal message bus, and be started, stopped, or reconfigured at runtime without affecting other agents.

### OODA Decision Loop

Every agent operates on a structured Observe-Orient-Decide-Act cycle:
- **Observe** -- Gather on-chain data, price feeds, and wallet state.
- **Orient** -- Analyze observations against the agent's strategy and risk parameters.
- **Decide** -- Select the optimal action from the available action space.
- **Act** -- Execute the chosen action through the wallet's secure signing pipeline.

### 8-Layer Security Policy Engine

Transactions must pass through all eight validation layers before execution:
1. Circuit breaker (automatic halt after consecutive failures; auto-recovers after 60s)
2. Program allowlist (reject transactions targeting unapproved programs)
3. Address blocklist (reject transactions to explicitly blocked destinations)
4. Per-transaction spending limit (reject any single tx exceeding the SOL cap)
5. Hourly spending limit (reject if cumulative hourly spend exceeds threshold)
6. Daily spending limit (reject if cumulative daily spend exceeds threshold)
7. Weekly spending limit (reject if cumulative weekly spend exceeds threshold)
8. Rate limits (per-minute, per-hour, and per-day transaction count caps)

### SPL Token Support

Full SPL token operations including creating token mints, minting tokens, transferring tokens between agent wallets, and querying token balances. Agents can hold and manage both SOL and SPL tokens independently.

### Protocol Interaction (Memo Program)

Agents can write on-chain memos via the Solana Memo Program v2, demonstrating the ability to interact with deployed Solana programs beyond simple SOL transfers.

### Multi-Factor AI Decision Engine

The TradingAgent uses a multi-factor scoring system with four independent factors — trend (SMA crossover), momentum (rate of change), volatility (inverse stddev), and balance safety — combined into a weighted composite confidence score with an explainable reasoning chain.

### Agent-to-Agent Transfers

Agents can target each other's wallets for inter-agent SOL and token transfers, enabling cooperative multi-agent strategies where agents trade with each other independently.

### Real Price Feeds (Jupiter + CoinGecko)

The TradingAgent fetches real SOL/USD prices from Jupiter Price API V2, with CoinGecko as a fallback. Prices are cached for 30 seconds to avoid rate limits. When both APIs are unreachable, the agent gracefully falls back to its simulated price feed — ensuring the demo always works regardless of network conditions.

### Jupiter DEX Swap Quotes

On each OODA cycle, the agent fetches a real Jupiter V6 swap quote (SOL → USDC) to demonstrate awareness of DEX routing, price impact, and available liquidity. The quote is included in the agent's reasoning chain for full transparency. On devnet, actual execution remains as SOL transfers since Jupiter AMM pools are mainnet-only.

### Optional AI/LLM Advisor

When `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, the TradingAgent blends LLM recommendations with its quantitative signal (60% quantitative, 40% AI). The AI advisor receives market context (price, history, strategy, quantitative signal) and returns a structured recommendation. When no API key is configured, the agent operates on pure quantitative scoring with zero degradation.

### Real-Time Dashboard

A web-based dashboard (http://localhost:3000) provides live visibility into all agent operations. Start it with `npm run dashboard` or as part of `npm run demo:showcase`.

```
┌──────────────────────────────────────────────────────────────────┐
│  SENTINELVAULT DASHBOARD                          ● Connected   │
├────────────┬────────────┬──────────────┬──────────┬─────────────┤
│  Agents: 2 │  Txns: 14  │  Vol: 1.2 SOL│ TPS: 0.3 │  Mem: 48 MB │
├────────────┴────────────┴──────────────┴──────────┴─────────────┤
│                                                                  │
│  ┌─ Alpha-Trader ──────────┐  ┌─ Beta-Trader ───────────────┐  │
│  │  Status: IDLE           │  │  Status: ANALYZING          │  │
│  │  Balance: 0.8912 SOL    │  │  Balance: 1.1034 SOL        │  │
│  │  Strategy: Momentum     │  │  Strategy: MeanReversion     │  │
│  │  Txns: 8  Win: 75%      │  │  Txns: 6  Win: 66%          │  │
│  └─────────────────────────┘  └──────────────────────────────┘  │
│                                                                  │
│  Activity Feed (live via WebSocket)                              │
│  ├─ 14:32:01  Alpha  BUY  0.005 SOL  confidence: 0.72          │
│  ├─ 14:31:45  Beta   HOLD           confidence: 0.38           │
│  └─ 14:31:30  Alpha  BUY  0.005 SOL  confidence: 0.68          │
└──────────────────────────────────────────────────────────────────┘
```

### CLI Interface

A full-featured command-line interface for managing wallets, agents, policies, and system configuration without writing code.

---

## Usage Guide

### Creating a Wallet

```typescript
import { AgenticWallet } from './src/core/wallet';

const wallet = new AgenticWallet({
  id: 'wallet-001',
  label: 'My Trading Wallet',
  password: 'strong-passphrase-here',
  cluster: 'devnet',
});

await wallet.initialize();
console.log('Wallet address:', wallet.getPublicKey());
console.log('Balance:', await wallet.getBalance(), 'SOL');

// Request devnet SOL
await wallet.requestAirdrop(1);

// Transfer SOL to another agent
const sig = await wallet.transferSOL(recipientAddress, 0.1);
console.log('Transfer tx:', wallet.getExplorerUrl(sig));
```

### SPL Token Operations

```typescript
// Create a token mint (wallet owner = mint authority)
const mintAddress = await wallet.createTokenMint(9); // 9 decimals

// Mint tokens to your own wallet
await wallet.mintTokens(mintAddress, 1_000_000 * 10 ** 9); // 1M tokens

// Transfer tokens to another wallet
await wallet.transferToken(mintAddress, otherWalletPublicKey, 500_000 * 10 ** 9);

// Check token balances
const tokens = await wallet.getTokenBalances();
console.log(tokens); // [{ mint, symbol, balance, decimals, uiBalance }]
```

### On-Chain Memo (Protocol Interaction)

```typescript
// Write a memo on-chain via the Memo Program v2
const sig = await wallet.sendMemo('Agent Alpha initialized — strategy: momentum');
console.log('Memo tx:', wallet.getExplorerUrl(sig));
```

### Creating and Running Agents

```typescript
import { AgentOrchestrator } from './src/agents/orchestrator';

const orchestrator = new AgentOrchestrator();

// Create a trading agent
const alphaId = await orchestrator.createAgent({
  name: 'Alpha-Trader',
  type: 'trader',
  password: 'agent-password',
  cluster: 'devnet',
  strategy: {
    name: 'Momentum',
    type: 'momentum',
    params: { targetAddress: otherAgentPublicKey },
    riskLevel: 'moderate',
    maxPositionSize: 0.01,
    cooldownMs: 15_000,
  },
});

// Fund and start
await orchestrator.fundAllAgents(1);
orchestrator.startAll();

// Monitor
orchestrator.on('agent:created', (agentId, name, type) => {
  console.log(`Agent ${name} (${type}) created: ${agentId}`);
});

// Access agent wallets for inter-agent operations
const wallet = orchestrator.getAgentWallet(alphaId);
const addresses = orchestrator.getAgentWalletAddresses(); // Map<agentId, publicKey>
```

### Using the Policy Engine

```typescript
import { PolicyEngine } from './src/security/policy-engine';

const policy = PolicyEngine.createDefaultPolicy();
// Default allowlist includes: System Program, SPL Token, AToken, Memo v2

// Override specific limits
policy.spendingLimits.perTransaction = 0.5;
policy.spendingLimits.daily = 10;
policy.maxTransactionsPerMinute = 5;

const engine = new PolicyEngine('agent-001', policy);
const result = engine.validateTransaction({ amountSol: 0.3 });
// result.allowed === true
```

---

## CLI Reference

| Command | Description |
|---|---|
| `wallet create <name>` | Create a new encrypted wallet keystore |
| `wallet list` | List all available wallets |
| `wallet balance <name>` | Show wallet balance and address |
| `wallet export <name>` | Export wallet public key |
| `agent start <type> <name>` | Start an agent (trading, liquidity, custom) |
| `agent stop <name>` | Stop a running agent |
| `agent status [name]` | Show status of one or all agents |
| `agent list` | List all registered agents |
| `policy set <key> <value>` | Set a security policy parameter |
| `policy show` | Display current policy configuration |
| `policy validate <tx-json>` | Validate a transaction against policies |
| `orchestrator start` | Start the agent orchestrator |
| `orchestrator stop` | Stop the orchestrator and all agents |
| `orchestrator status` | Show orchestrator and agent status |
| `dashboard start [--port]` | Start the web dashboard (default: 3000) |
| `dashboard stop` | Stop the web dashboard |
| `audit log [--from] [--to]` | View audit log entries |
| `audit export <format>` | Export audit log (json, csv) |
| `config show` | Display current configuration |
| `config set <key> <value>` | Update a configuration value |

### Example CLI Usage

```bash
# Create a wallet
npx ts-node src/cli/index.ts wallet create my-trading-wallet

# Check balance
npx ts-node src/cli/index.ts wallet balance my-trading-wallet

# Start a trading agent
npx ts-node src/cli/index.ts agent start trading momentum-bot

# View all agent statuses
npx ts-node src/cli/index.ts agent status

# Start the dashboard on port 8080
npx ts-node src/cli/index.ts dashboard start --port 8080
```

---

## REST API Reference

The dashboard exposes a REST API for programmatic access.

**Base URL:** `http://localhost:3000/api`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | System health and uptime |
| `GET` | `/metrics` | System-wide performance metrics |
| `GET` | `/dashboard` | Full dashboard state snapshot |
| `GET` | `/agents` | List all agents with status |
| `GET` | `/agents/:id/decisions` | Last 20 decisions with adaptive weights, regime, calibration |
| `POST` | `/agents` | Create a new agent |
| `POST` | `/agents/:id/start` | Start a specific agent |
| `POST` | `/agents/:id/stop` | Stop a specific agent |
| `POST` | `/agents/:id/pause` | Pause a specific agent |
| `POST` | `/agents/:id/resume` | Resume a paused agent |
| `DELETE` | `/agents/:id` | Remove an agent |
| `GET` | `/audit` | Query audit log entries |
| `GET` | `/risk` | Risk summary from audit log |
| `GET` | `/alerts` | List all alerts |

**WebSocket:** Connect to `ws://localhost:3001` for real-time event streaming (agent actions, transactions, security alerts).

---

## Security Deep Dive

### Keystore Encryption

All private keys are encrypted before being written to disk. The encryption pipeline works as follows:

1. A user-supplied password is fed into PBKDF2 with a cryptographically random 32-byte salt.
2. PBKDF2 derives a 256-bit encryption key using 100,000 iterations of SHA-512.
3. A random 12-byte initialization vector (IV) is generated for each encryption operation.
4. The private key is encrypted using AES-256-GCM, which provides both confidentiality and integrity.
5. The resulting keystore file stores the encrypted key, salt, IV, and authentication tag -- never the plaintext key.

### Policy Engine Validation Chain

Every transaction passes through eight sequential validation layers. A failure at any layer rejects the transaction immediately.

```
Transaction Submitted
        |
        v
[1] Circuit Breaker --------> Has the agent exceeded consecutive failure threshold?
        |
        v
[2] Program Allowlist ------> Is the target program in the approved set?
        |
        v
[3] Address Blocklist ------> Is the destination on the blocked list?
        |
        v
[4] Per-Tx Limit -----------> Does this single transaction exceed the SOL cap?
        |
        v
[5] Hourly Spending --------> Would this push hourly cumulative spend over limit?
        |
        v
[6] Daily Spending ---------> Would this push daily cumulative spend over limit?
        |
        v
[7] Weekly Spending --------> Would this push weekly cumulative spend over limit?
        |
        v
[8] Rate Limits ------------> Too many transactions per minute/hour/day?
        |
        v
  Transaction Approved --> Submit to Solana
```

### Circuit Breaker

The circuit breaker monitors for consecutive transaction failures. When the failure count reaches the configured threshold, the circuit breaker trips and halts all outgoing transactions for the affected agent. This prevents runaway losses from bugs, network issues, or adversarial conditions. The circuit breaker can be manually reset through the CLI or API after investigation.

### Secure Key Wiping

After any signing operation, key material is overwritten in memory with zeros before being dereferenced. This minimizes the window during which plaintext keys exist in process memory, reducing exposure to memory dump attacks.

### Audit Trail

Every significant event is recorded in an append-only audit log with a timestamp, event type, agent identifier, and relevant metadata. The audit log captures:

- Wallet creation and access events
- Transaction submissions and outcomes
- Policy violations and rejections
- Agent lifecycle events (start, stop, pause, resume)
- Configuration changes
- Security alerts (circuit breaker trips, velocity warnings)

Audit logs can be exported in JSON or CSV format for external analysis.

---

## Project Structure

```
sentinelVault/
├── src/
│   ├── index.ts             # Public barrel exports
│   ├── types/index.ts       # All TypeScript interfaces and types
│   ├── core/                # Wallet and keystore
│   │   ├── keystore.ts      #   AES-256-GCM encrypted keystore manager
│   │   └── wallet.ts        #   AgenticWallet (SOL + SPL + Memo)
│   ├── security/            # Policy engine and audit logging
│   │   ├── policy-engine.ts #   8-layer security validation chain
│   │   └── audit-logger.ts  #   Structured audit log with risk scoring
│   ├── integrations/        # External protocol integrations
│   │   ├── price-feed.ts    #   Real SOL/USD from Jupiter + CoinGecko
│   │   ├── jupiter.ts       #   Jupiter V6 DEX quote/swap client
│   │   └── ai-advisor.ts    #   Optional LLM trade advisor (Claude/OpenAI)
│   ├── agents/              # Agent implementations and orchestrator
│   │   ├── base-agent.ts    #   Abstract OODA loop base class
│   │   ├── trading-agent.ts #   Multi-factor trading + real prices + AI
│   │   ├── liquidity-agent.ts # Simulated LP pool management
│   │   └── orchestrator.ts  #   Multi-agent lifecycle coordinator
│   ├── cli/index.ts         # Commander-based CLI
│   └── dashboard/           # REST API + WebSocket + HTML dashboard
│       ├── server.ts
│       └── public/index.html # Live dashboard UI
├── tests/                   # Jest test files (*.test.ts)
├── scripts/                 # Demo scripts
│   ├── demo.ts              #   Full multi-agent demo
│   ├── demo-multi-agent.ts  #   Wallet independence demo
│   ├── demo-trading.ts      #   Single trading agent demo
│   ├── demo-showcase.ts     #   Judge-facing showcase (all bounty requirements)
│   └── live-dashboard-demo.ts # Live dashboard demo with agents
├── .sentinelvault/          # Runtime data (keystores, audit logs)
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Testing

```bash
# Run all tests
npm test

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run a specific test file
npx jest tests/core/keystore-manager.test.ts

# Run tests matching a pattern
npx jest --testPathPattern="security"
```

### Test Coverage

Run `npm run test:coverage` to see current coverage. The test suite includes 237 tests across 14 suites covering core wallet operations, security policy engine, audit logging, all four agent types (trader, liquidity provider, arbitrageur, portfolio manager), adaptive learning with EMA weight updates and deferred evaluation, and the integration layer (price feeds, Jupiter, AI advisor).

---

## Configuration

SentinelVault is configured through environment variables. Copy `.env.example` to `.env` and adjust the values for your environment.

| Variable | Description | Default |
|---|---|---|
| `SOLANA_NETWORK` | Solana cluster to connect to | `devnet` |
| `SOLANA_RPC_URL` | Custom RPC endpoint URL | (cluster default) |
| `KEYSTORE_DIR` | Directory for encrypted keystore files | `./keystores` |
| `PBKDF2_ITERATIONS` | Key derivation iterations | `100000` |
| `DASHBOARD_PORT` | Port for the web dashboard | `3000` |
| `LOG_LEVEL` | Logging verbosity (debug, info, warn, error) | `info` |
| `MAX_TX_AMOUNT` | Default max transaction amount (SOL) | `10.0` |
| `DAILY_SPENDING_LIMIT` | Default daily spending limit (SOL) | `50.0` |
| `RATE_LIMIT_PER_MINUTE` | Default max transactions per minute | `30` |
| `CIRCUIT_BREAKER_THRESHOLD` | Consecutive failures before halt | `5` |
| `AUDIT_LOG_PATH` | Path for audit log output | `./logs/audit.log` |
| `AGENT_DECISION_INTERVAL` | Default OODA cycle interval (ms) | `5000` |

---

## Contributing

Contributions are welcome. Please follow these steps:

1. Fork the repository.
2. Create a feature branch from `main`.
3. Write tests for any new functionality.
4. Ensure all tests pass with `npm test`.
5. Submit a pull request with a clear description of the changes.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

Built for the Solana AI Agent Hackathon -- advancing autonomous agents on Solana.
