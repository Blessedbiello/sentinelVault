# SentinelVault -- Agent-Readable Capabilities Document

This document is intended for AI agents and LLMs that need to understand,
integrate with, or operate the SentinelVault framework programmatically.

---

## Capabilities Overview

SentinelVault is an autonomous AI agent wallet framework for Solana. It provides:

- **Encrypted wallet management** -- Create, fund, lock/unlock Solana wallets with AES-256-GCM encrypted keystores. Private keys are decrypted on demand and wiped from memory immediately after use.
- **SPL token operations** -- Create token mints, mint tokens, transfer tokens between agent wallets, and query token balances using `@solana/spl-token`.
- **Protocol interaction (Memo Program)** -- Write on-chain memos via the Solana Memo Program v2, demonstrating dApp/protocol interaction beyond simple SOL transfers.
- **Agent-to-agent interaction** -- Agents can target each other's wallets for inter-agent SOL and token transfers, enabling cooperative multi-agent strategies.
- **Real price feeds** -- SOL/USD from Jupiter Price API V2 with CoinGecko fallback. Cached for 30s. Graceful fallback to simulated prices when APIs are unreachable.
- **Jupiter DEX quotes** -- Real Jupiter V6 swap quotes (SOL → USDC) showing route plan, price impact, and output amount. Demonstrates DEX awareness for mainnet readiness.
- **Optional AI/LLM advisor** -- When `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, blends LLM recommendations with quantitative signal (60/40 split). Graceful no-op when unavailable.
- **Multi-factor AI decisions** -- TradingAgent uses a four-factor scoring system (trend, momentum, volatility, balance) with explainable reasoning chains.
- **Autonomous agent orchestration** -- Spin up multiple independent AI agents, each with its own wallet, security policy, and trading strategy. An orchestrator manages lifecycle, health checks, and metrics aggregation.
- **OODA decision loop** -- Every agent runs a continuous Observe-Orient-Decide-Act cycle. Concrete strategies (DCA, momentum, mean reversion, liquidity provision) are pluggable via abstract method overrides.
- **8-layer security policy engine** -- All outbound transactions pass through a configurable chain of validation checks before reaching the network. Default allowlist includes System Program, SPL Token, AToken, and Memo v2.
- **Real-time dashboard** -- HTML dashboard + REST API + WebSocket push server for monitoring agent states, system metrics, audit logs, and alerts. Open http://localhost:3000 in a browser.
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

### SPL token operations

```typescript
// Create a new SPL token mint (wallet owner = mint authority + freeze authority)
const mintAddress = await wallet.createTokenMint(9); // 9 decimals

// Mint tokens to your own associated token account
await wallet.mintTokens(mintAddress, 1_000_000 * 10 ** 9); // 1M tokens

// Transfer tokens to another wallet (creates destination ATA if needed)
await wallet.transferToken(mintAddress, destinationPublicKey, 500_000 * 10 ** 9);

// Query all SPL token balances
const tokens = await wallet.getTokenBalances();
// Returns: TokenBalance[] with { mint, symbol, balance, decimals, uiBalance }
```

### On-chain memo (protocol interaction)

```typescript
// Write a memo on-chain via Memo Program v2
const sig = await wallet.sendMemo('Agent Alpha initialized — strategy: momentum');
console.log('Explorer:', wallet.getExplorerUrl(sig));
```

### Agent-to-agent interaction

```typescript
// Access agent wallets through the orchestrator
const alphaWallet = orchestrator.getAgentWallet(alphaId);
const addresses = orchestrator.getAgentWalletAddresses(); // Map<agentId, publicKey>

// Wire agents to target each other
const betaPublicKey = orchestrator.getAgentWallet(betaId).getPublicKey();
// Pass as strategy.params.targetAddress when creating the agent
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

### Real price feeds and Jupiter quotes

```typescript
import { PriceFeed, JupiterClient, AIAdvisor } from 'sentinel-vault';

// Fetch real SOL/USD price
const priceFeed = new PriceFeed();
const price = await priceFeed.getSOLPrice();
// Returns: { price: 172.45, source: 'jupiter', timestamp: ... } or null

// Fetch Jupiter DEX swap quote
const jupiter = new JupiterClient();
const quote = await jupiter.getQuote({ amount: 10_000_000 }); // 0.01 SOL in lamports
// Returns: { inputMint, outputMint, inAmount, outAmount, priceImpactPct, routePlan }

// Check AI advisor availability
const advisor = new AIAdvisor(); // reads ANTHROPIC_API_KEY / OPENAI_API_KEY from env
console.log(advisor.isAvailable()); // true if API key is configured
console.log(advisor.getProvider());  // 'anthropic' | 'openai' | null
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
| `trader`              | `TradingAgent`    | Implemented    | Autonomous trading with real/simulated prices + AI |
| `liquidity_provider`  | `LiquidityAgent`  | Implemented    | Simulated LP pool management and rebalancing      |
| `arbitrageur`         | `ArbitrageAgent`  | Implemented    | Cross-DEX price monitoring with arbitrage intent recording |
| `portfolio_manager`   | `PortfolioAgent`  | Implemented    | Multi-asset portfolio rebalancing with drift detection     |

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
- **Simulated prices (fallback)** -- The TradingAgent uses real Jupiter/CoinGecko prices by default, but falls back to a local random-walk simulation when APIs are unreachable. The LiquidityAgent simulates pool state internally.
- **0.01 SOL trade cap** -- Each TradingAgent trade is hard-capped at 0.01 SOL (and never more than 10% of wallet balance) to protect devnet funds.
- **No real DEX execution** -- Trades are SOL transfers to a target address, not actual swaps on a DEX (Jupiter quotes are fetched for transparency but execution is devnet SOL transfers). SPL token operations use real on-chain mint/transfer via `@solana/spl-token`.
- **Arbitrageur and portfolio manager** -- ArbitrageAgent uses a simulated alternative DEX price (not a real second DEX). PortfolioAgent tracks target allocation but rebalancing is signaled via micro-transfers, not actual DEX swaps.
- **Single-process** -- All agents run in a single Node.js process. No distributed coordination or persistence across restarts.
- **No mainnet safeguards** -- There is no multi-sig, hardware wallet integration, or human-in-the-loop approval workflow.
- **Airdrop rate limits** -- Devnet airdrops are rate-limited by Solana. Sequential funding with 5-second delays is used, but failures are possible under load.
