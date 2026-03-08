# SentinelVault -- Agent-Readable Capabilities Document

This document is intended for AI agents and LLMs that need to understand,
integrate with, or operate the SentinelVault framework programmatically.

---

## Capabilities Overview

SentinelVault is an autonomous AI agent wallet framework for Solana. It provides:

- **Encrypted wallet management** -- Create, fund, lock/unlock Solana wallets with AES-256-GCM encrypted keystores. Private keys are decrypted on demand and wiped from memory immediately after use.
- **Autonomous agent orchestration** -- Spin up multiple independent AI agents, each with its own wallet, security policy, and trading strategy. An orchestrator manages lifecycle, health checks, and metrics aggregation.
- **OODA decision loop** -- Every agent runs a continuous Observe-Orient-Decide-Act cycle. Concrete strategies (DCA, momentum, mean reversion, liquidity provision) are pluggable via abstract method overrides.
- **8-layer security policy engine** -- All outbound transactions pass through a configurable chain of validation checks before reaching the network.
- **Real-time dashboard** -- REST API + WebSocket push server for monitoring agent states, system metrics, audit logs, and alerts.
- **Full audit trail** -- Every wallet operation, agent decision, security event, and transaction is logged with risk scores and queryable filters.
- **CLI interface** -- Command-line tool for status checks, agent management, and wallet operations.

---

## API Examples (TypeScript)

### Create and initialize a wallet

```typescript
import { AgenticWallet } from 'sentinel-vault';

const wallet = new AgenticWallet({
  id: 'wallet-001',
  label: 'Trading Wallet',
  password: 'strong-passphrase',
  cluster: 'devnet',
});

await wallet.initialize();
await wallet.requestAirdrop(1); // 1 SOL on devnet
const balance = await wallet.getBalance();
```

### Create an agent via the orchestrator

```typescript
import { AgentOrchestrator } from 'sentinel-vault';

const orchestrator = new AgentOrchestrator({ maxAgents: 10 });

const agentId = await orchestrator.createAgent({
  name: 'DCA-Bot',
  type: 'trader',
  password: 'agent-password',
  cluster: 'devnet',
  strategy: {
    name: 'Dollar Cost Average',
    type: 'dca',
    params: { targetAddress: '11111111111111111111111111111111' },
    riskLevel: 'conservative',
    maxPositionSize: 0.01,
    cooldownMs: 30_000,
  },
});

orchestrator.startAgent(agentId);
```

### Configure a security policy

```typescript
import { PolicyEngine } from 'sentinel-vault';

const policy = PolicyEngine.createDefaultPolicy();
// Override specific limits:
policy.spendingLimits.perTransaction = 0.5;
policy.spendingLimits.daily = 10;
policy.maxTransactionsPerMinute = 5;

const engine = new PolicyEngine('agent-001', policy);
const result = engine.validateTransaction({ amountSol: 0.3 });
// result.allowed === true
```

### Listen to events

```typescript
wallet.on('transaction:confirmed', (signature) => {
  console.log('Confirmed:', signature);
});

orchestrator.on('agent:created', (agentId, name, type) => {
  console.log(`Agent ${name} (${type}) created: ${agentId}`);
});
```

---

## REST API Endpoints

The dashboard server runs on port 3000 (HTTP) by default.

| Method   | Path                      | Description                          | Response Shape                                                         |
|----------|---------------------------|--------------------------------------|------------------------------------------------------------------------|
| `GET`    | `/api/health`             | Server health check                  | `{ status, uptime, timestamp, version }`                               |
| `GET`    | `/api/metrics`            | System-wide performance metrics      | `SystemMetrics { totalAgents, activeAgents, totalTransactions, ... }`   |
| `GET`    | `/api/dashboard`          | Full dashboard state snapshot        | `DashboardState { agents[], systemMetrics, recentAuditEntries[], ... }` |
| `GET`    | `/api/agents`             | List all registered agents           | `AgentState[]`                                                         |
| `POST`   | `/api/agents`             | Create a new agent                   | `{ id, message }`                                                      |
| `POST`   | `/api/agents/:id/start`   | Start an agent's OODA loop           | `{ message }`                                                          |
| `POST`   | `/api/agents/:id/stop`    | Stop an agent permanently            | `{ message }`                                                          |
| `POST`   | `/api/agents/:id/pause`   | Pause an agent temporarily           | `{ message }`                                                          |
| `POST`   | `/api/agents/:id/resume`  | Resume a paused agent                | `{ message }`                                                          |
| `DELETE` | `/api/agents/:id`         | Remove an agent and its wallet       | `{ message }`                                                          |
| `GET`    | `/api/audit`              | Query audit log (filters: agentId, category, limit) | `AuditEntry[]`                                          |
| `GET`    | `/api/risk`               | Aggregated risk summary              | `RiskSummary { averageRiskScore, highRiskCount, topRisksByAction[] }`  |
| `GET`    | `/api/alerts`             | List all alerts                      | `AlertEntry[]`                                                         |

---

## WebSocket Events

The WebSocket server runs on port 3001 by default. All messages are JSON with the shape `{ event, data, timestamp }`.

| Event              | Direction      | Description                                      | Data Shape                         |
|--------------------|----------------|--------------------------------------------------|------------------------------------|
| `snapshot`         | server->client | Full dashboard state sent on initial connection  | `DashboardState`                   |
| `agent:created`    | server->client | A new agent was registered                       | `{ agentId, name, type }`          |
| `agent:started`    | server->client | An agent's OODA loop began                       | `{ agentId }`                      |
| `agent:stopped`    | server->client | An agent's OODA loop was halted                  | `{ agentId }`                      |
| `alert`            | server->client | A new alert was raised                           | `AlertEntry`                       |
| `metrics:updated`  | server->client | Periodic system metrics broadcast                | `SystemMetrics`                    |

---

## Security Model (8 Layers)

The PolicyEngine validates every outbound transaction through an ordered chain that short-circuits on the first failure:

1. **Circuit breaker** -- Blocks all transactions after 5 consecutive failures; auto-recovers after 60 seconds.
2. **Program allowlist** -- Rejects transactions targeting programs not in the allowed set (default: System Program only).
3. **Address blocklist** -- Rejects transactions to explicitly blocked destination addresses.
4. **Per-transaction limit** -- Rejects any single transaction exceeding the configured SOL cap (default: 1 SOL).
5. **Hourly spending limit** -- Rejects transactions that would push cumulative hourly spend over the threshold (default: 5 SOL).
6. **Daily spending limit** -- Rejects transactions that would push cumulative daily spend over the threshold (default: 20 SOL).
7. **Weekly spending limit** -- Rejects transactions that would push cumulative weekly spend over the threshold (default: 100 SOL).
8. **Rate limits** -- Rejects transactions exceeding per-minute (10), per-hour (60), or per-day (500) transaction count caps.

---

## OODA Decision Loop

Every agent extends `BaseAgent` and implements four abstract methods that form the OODA cycle:

```
  Observe --> Analyze --> [confidence gate] --> Execute --> Evaluate
     ^                                                        |
     |________________________________________________________|
                      (cooldownMs interval)
```

1. **Observe** -- Gather market data, on-chain state, wallet balance. The TradingAgent uses a simulated price feed; the LiquidityAgent simulates pool state.
2. **Analyze** -- Apply strategy logic to observations. Produces an `AgentDecision` with an action (`buy`, `sell`, `hold`, `rebalance`, `add_liquidity`, `remove_liquidity`), a confidence score (0-1), and reasoning text.
3. **Confidence gate** -- If `confidence < 0.5` or action is `hold`, the decision is recorded but not executed.
4. **Execute** -- Translate the decision into an on-chain transaction via the agent's `AgenticWallet`. Returns an `AgentAction` or null.
5. **Evaluate** -- Update performance metrics (volume, win rate, PnL) and log the outcome.

On error, the agent enters `error` status and auto-recovers after 5 seconds (unless explicitly stopped). The orchestrator's health monitor can also trigger recovery when `autoRestart` is enabled.

---

## Configuration Parameters

Environment variables (see `.env.example`):

| Variable                         | Default                       | Description                                          |
|----------------------------------|-------------------------------|------------------------------------------------------|
| `SOLANA_CLUSTER`                 | `devnet`                      | Solana cluster to connect to (`devnet`, `testnet`, `mainnet-beta`) |
| `SOLANA_RPC_URL`                 | (cluster default endpoint)    | Custom Solana RPC endpoint URL                       |
| `DASHBOARD_PORT`                 | `3000`                        | HTTP REST API port                                   |
| `WEBSOCKET_PORT`                 | `3001`                        | WebSocket push server port                           |
| `MAX_AGENTS`                     | `10`                          | Maximum number of concurrent agents                  |
| `DEFAULT_SPENDING_LIMIT_PER_TX`  | `1.0`                         | Per-transaction spending cap in SOL                   |
| `DEFAULT_SPENDING_LIMIT_DAILY`   | `20.0`                        | Daily spending cap in SOL                             |
| `LOG_LEVEL`                      | `info`                        | Logging verbosity                                    |
| `AUDIT_LOG_DIR`                  | `.sentinelvault/audit`        | Directory for audit log files                        |
| `KEYSTORE_DIR`                   | `.sentinelvault/keystores`    | Directory for encrypted keystore files               |

Orchestrator defaults (constructor config):

| Parameter               | Default   | Description                                     |
|-------------------------|-----------|-------------------------------------------------|
| `maxAgents`             | `10`      | Maximum registered agents                       |
| `healthCheckIntervalMs` | `30000`   | Health check polling interval in ms              |
| `metricsIntervalMs`     | `10000`   | Metrics broadcast interval in ms                 |
| `autoRestart`           | `true`    | Auto-resume agents that enter error state        |
| `dashboardPort`         | `3000`    | REST API listen port                             |
| `websocketPort`         | `3001`    | WebSocket listen port                            |

---

## Agent Types and Strategies

### Agent Types

| Type                  | Class             | Status         | Description                                      |
|-----------------------|-------------------|----------------|--------------------------------------------------|
| `trader`              | `TradingAgent`    | Implemented    | Autonomous trading with simulated price feeds     |
| `liquidity_provider`  | `LiquidityAgent`  | Implemented    | Simulated LP pool management and rebalancing      |
| `arbitrageur`         | (TradingAgent)    | Stub           | Falls back to TradingAgent; dedicated impl pending|
| `portfolio_manager`   | (TradingAgent)    | Stub           | Falls back to TradingAgent; dedicated impl pending|

### Trading Strategies

| Strategy          | Type               | Behavior                                                                  |
|-------------------|--------------------|---------------------------------------------------------------------------|
| DCA               | `dca`              | Buy unconditionally every cycle; fixed confidence of 0.6                  |
| Momentum          | `momentum`         | Follow trend using SMA-20 vs SMA-50 crossover; confidence 0.7            |
| Mean Reversion    | `mean_reversion`   | Buy below 95% of base price, sell above 105%; confidence scales with deviation |
| Grid Trading      | `grid_trading`     | Type defined but not yet implemented                                      |
| Liquidity Provision | `liquidity_provision` | Monitor pool imbalance, APY, utilization; rebalance/add/remove accordingly |

### Risk Levels

Each strategy accepts a `riskLevel` parameter: `conservative`, `moderate`, or `aggressive`.

---

## Limitations and Constraints

- **Devnet only** -- The framework is designed and tested for Solana devnet. Mainnet usage requires significant policy hardening and has not been validated.
- **Simulated prices** -- The TradingAgent uses a local random-walk price simulation, not real market data. The LiquidityAgent simulates pool state internally.
- **0.01 SOL trade cap** -- Each TradingAgent trade is hard-capped at 0.01 SOL (and never more than 10% of wallet balance) to protect devnet funds.
- **No real DEX integration** -- Trades are SOL transfers to a target address, not actual swaps on a DEX.
- **SPL token support is placeholder** -- `transferToken()` and `getTokenBalances()` are declared but throw or return empty arrays.
- **Arbitrageur and portfolio manager** -- These agent types fall back to TradingAgent; dedicated implementations are not yet available.
- **Single-process** -- All agents run in a single Node.js process. No distributed coordination or persistence across restarts.
- **No mainnet safeguards** -- There is no multi-sig, hardware wallet integration, or human-in-the-loop approval workflow.
- **Airdrop rate limits** -- Devnet airdrops are rate-limited by Solana. Sequential funding with 2-second delays is used, but failures are possible under load.
