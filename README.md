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
│   Keystore Manager  |  AgenticWallet  |  Tx Engine   │
│   Priority Queue  |  Retry Logic  |  Fee Estimation  │
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
- **Core Wallet Layer** -- Manages encrypted keystores, constructs and signs transactions, handles priority queuing and retry logic.
- **Solana Network** -- The underlying blockchain where all transactions are submitted and confirmed.

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

# Run the full multi-agent demo on devnet
npm run demo
```

### Verify Installation

```bash
# Run the test suite to confirm everything works
npm test

# Check CLI availability
npx ts-node src/cli/index.ts --help
```

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
- **Act** -- Execute the chosen action through the transaction engine.

### 8-Layer Security Policy Engine

Transactions must pass through all eight validation layers before execution:
1. Transaction amount limits (per-transaction and daily aggregate)
2. Rate limiting (transactions per time window)
3. Recipient whitelist validation
4. Time window restrictions (allowed operating hours)
5. Token/asset type restrictions
6. Minimum balance preservation
7. Velocity checks (sudden spending pattern detection)
8. Circuit breaker (automatic halt on anomalous activity)

### Transaction Engine with Priority Queue

Transactions are queued with configurable priority levels, include automatic retry logic with exponential backoff, and support dynamic fee estimation based on current network conditions.

### Real-Time Dashboard

A web-based dashboard provides live visibility into:
- Agent status and activity logs
- Wallet balances and transaction history
- Security events and policy violations
- System health and performance metrics

### CLI Interface

A full-featured command-line interface for managing wallets, agents, policies, and system configuration without writing code.

---

## Usage Guide

### Creating a Wallet

```typescript
import { KeystoreManager } from './src/core/keystore-manager';
import { AgenticWallet } from './src/core/agentic-wallet';

// Initialize the keystore manager
const keystoreManager = new KeystoreManager('./keystores');

// Create a new encrypted keystore
const keystoreId = await keystoreManager.createKeystore('my-agent-wallet', {
  password: 'strong-passphrase-here',
});

// Load the wallet from the encrypted keystore
const wallet = new AgenticWallet({
  keystoreManager,
  keystoreId,
  password: 'strong-passphrase-here',
  network: 'devnet',
});

await wallet.initialize();
console.log('Wallet address:', wallet.getPublicKey().toBase58());
console.log('Balance:', await wallet.getBalance(), 'SOL');
```

### Creating and Running Agents

```typescript
import { TradingAgent } from './src/agents/trading-agent';
import { LiquidityAgent } from './src/agents/liquidity-agent';
import { AgentOrchestrator } from './src/agents/orchestrator';

// Create a trading agent
const trader = new TradingAgent({
  name: 'momentum-trader',
  wallet,
  strategy: {
    type: 'momentum',
    lookbackPeriod: 60,      // seconds
    entryThreshold: 0.02,    // 2% price movement
    exitThreshold: 0.01,     // 1% trailing stop
    maxPositionSize: 1.0,    // SOL
  },
  decisionInterval: 5000,    // OODA cycle every 5 seconds
});

// Create a liquidity agent
const liquidityProvider = new LiquidityAgent({
  name: 'lp-manager',
  wallet,
  pool: 'SOL/USDC',
  rangeWidth: 0.05,          // 5% range around current price
  rebalanceThreshold: 0.03,  // rebalance at 3% drift
});

// Orchestrate multiple agents
const orchestrator = new AgentOrchestrator();
orchestrator.registerAgent(trader);
orchestrator.registerAgent(liquidityProvider);

// Start all agents
await orchestrator.startAll();

// Monitor agent activity
orchestrator.on('agentAction', (event) => {
  console.log(`[${event.agentName}] ${event.action}: ${event.details}`);
});
```

### Using the Policy Engine

```typescript
import { PolicyEngine } from './src/security/policy-engine';

// Configure security policies
const policyEngine = new PolicyEngine({
  maxTransactionAmount: 5.0,          // SOL per transaction
  dailySpendingLimit: 20.0,           // SOL per day
  maxTransactionsPerMinute: 10,
  allowedRecipients: [
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // Raydium
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Another DEX
  ],
  operatingHours: {
    start: '00:00',
    end: '23:59',
    timezone: 'UTC',
  },
  allowedTokens: ['SOL', 'USDC', 'USDT'],
  minimumBalance: 0.5,                // Always keep 0.5 SOL in reserve
  velocityWindow: 300,                // 5-minute velocity check window
  velocityThreshold: 10.0,            // SOL per velocity window
  circuitBreakerThreshold: 3,         // consecutive failures before halt
});

// Attach the policy engine to a wallet
wallet.setPolicyEngine(policyEngine);

// Transactions are now automatically validated
// A transaction that violates any policy will be rejected
// before it reaches the network
```

### Using the Orchestrator

```typescript
import { AgentOrchestrator } from './src/agents/orchestrator';

const orchestrator = new AgentOrchestrator();

// Register agents with priority levels
orchestrator.registerAgent(trader, { priority: 'high' });
orchestrator.registerAgent(liquidityProvider, { priority: 'medium' });

// Start all agents
await orchestrator.startAll();

// Get agent status
const status = orchestrator.getStatus();
console.log('Active agents:', status.activeAgents);
console.log('Total transactions:', status.totalTransactions);

// Pause a specific agent
await orchestrator.pauseAgent('momentum-trader');

// Resume the agent
await orchestrator.resumeAgent('momentum-trader');

// Stop all agents gracefully
await orchestrator.stopAll();
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
| `GET` | `/wallets` | List all wallets |
| `GET` | `/wallets/:id` | Get wallet details and balance |
| `POST` | `/wallets` | Create a new wallet |
| `GET` | `/agents` | List all agents with status |
| `GET` | `/agents/:name` | Get agent details |
| `POST` | `/agents/:name/start` | Start a specific agent |
| `POST` | `/agents/:name/stop` | Stop a specific agent |
| `POST` | `/agents/:name/pause` | Pause a specific agent |
| `POST` | `/agents/:name/resume` | Resume a paused agent |
| `GET` | `/transactions` | List recent transactions |
| `GET` | `/transactions/:id` | Get transaction details |
| `GET` | `/policies` | Get current policy configuration |
| `PUT` | `/policies` | Update policy configuration |
| `GET` | `/audit` | Query audit log entries |
| `GET` | `/audit/export` | Export audit log |
| `GET` | `/status` | System health and status |
| `GET` | `/metrics` | Performance metrics |

**WebSocket:** Connect to `ws://localhost:3000/ws` for real-time event streaming (agent actions, transactions, security alerts).

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
[1] Amount Limit Check -----> Does this transaction exceed the per-tx limit?
        |
        v
[2] Daily Spending Check ----> Would this exceed the daily aggregate limit?
        |
        v
[3] Rate Limit Check -------> Too many transactions in the current window?
        |
        v
[4] Recipient Validation ---> Is the recipient on the whitelist?
        |
        v
[5] Time Window Check ------> Are we within allowed operating hours?
        |
        v
[6] Token Restriction ------> Is this token/asset type permitted?
        |
        v
[7] Balance Preservation ---> Will the wallet retain the minimum balance?
        |
        v
[8] Velocity Check ---------> Does spending velocity exceed thresholds?
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
│   ├── core/                # Wallet, keystore, and transaction engine
│   │   ├── keystore-manager.ts
│   │   ├── agentic-wallet.ts
│   │   └── transaction-engine.ts
│   ├── security/            # Policy engine and audit logging
│   │   ├── policy-engine.ts
│   │   └── audit-logger.ts
│   ├── agents/              # Agent implementations and orchestrator
│   │   ├── base-agent.ts
│   │   ├── trading-agent.ts
│   │   ├── liquidity-agent.ts
│   │   └── orchestrator.ts
│   ├── cli/                 # Command-line interface
│   │   └── index.ts
│   ├── dashboard/           # REST API and WebSocket server
│   │   ├── server.ts
│   │   └── routes.ts
│   └── types/               # TypeScript type definitions
│       └── index.ts
├── tests/                   # Unit and integration tests
│   ├── core/
│   ├── security/
│   └── agents/
├── scripts/                 # Demo and setup scripts
│   ├── demo.ts
│   └── setup-devnet.sh
├── keystores/               # Encrypted keystore files (gitignored)
├── .env.example             # Environment variable template
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

### Test Coverage Targets

| Module | Target |
|---|---|
| Core (keystore, wallet, tx engine) | >= 90% |
| Security (policy engine, audit) | >= 95% |
| Agents (base, trading, liquidity) | >= 85% |
| CLI | >= 80% |

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
