# SentinelVault -- Agent-Readable Capabilities Document

This document is intended for AI agents and LLMs that need to understand,
integrate with, or operate the SentinelVault agentic wallet programmatically.

---

## What Is SentinelVault?

SentinelVault is an **agentic wallet for Solana** -- a wallet designed specifically for AI agents to control. It can create wallets programmatically, sign transactions automatically, hold SOL and SPL tokens, and interact with on-chain protocols -- all without human intervention.

**The wallet is the product. The agents are demonstrations.**

Any AI agent, trading bot, or automation script can use the wallet directly. No orchestrator, OODA loop, or SentinelVault agent is required. Import the wallet, initialize it, and start transacting.

---

## Quick Start: Use the Wallet in Your Own Agent

### Minimum Integration (6 lines)

```typescript
import { AgenticWallet } from 'sentinel-vault';

const wallet = new AgenticWallet({
  id: 'your-agent-id',
  label: 'Your Agent Name',
  password: 'your-secure-password',
  cluster: 'devnet',
});
await wallet.initialize();                            // creates keypair, encrypts it
await wallet.requestAirdrop(1);                       // fund on devnet
await wallet.transferSOL(destination, 0.1);           // auto-signs, no human needed
```

That's it. Your agent now has a fully functional Solana wallet with encrypted key storage and automatic transaction signing.

### Add Security (Optional)

```typescript
import { AgenticWallet, PolicyEngine } from 'sentinel-vault';

const wallet = new AgenticWallet({ id: 'bot', label: 'Bot', password: 'pw', cluster: 'devnet' });
await wallet.initialize();

// Attach spending limits, rate limits, program allowlists
const policy = PolicyEngine.createDefaultPolicy();
policy.spendingLimits.perTransaction = 0.5; // max 0.5 SOL per tx
policy.spendingLimits.daily = 5;            // max 5 SOL per day
policy.maxTransactionsPerMinute = 5;
wallet.setPolicyEngine(new PolicyEngine('bot', policy));

// All subsequent wallet calls are now policy-enforced
await wallet.transferSOL(dest, 0.3); // allowed
await wallet.transferSOL(dest, 1.0); // BLOCKED: exceeds per-tx limit
```

### Listen to Events

```typescript
wallet.on('transaction:confirmed', (sig) => console.log('Confirmed:', sig));
wallet.on('transaction:failed', (err) => console.error('Failed:', err.message));
wallet.on('wallet:funded', (sig, sol) => console.log(`Funded: ${sol} SOL`));
```

---

## Complete Wallet API

These are all public methods on `AgenticWallet`. Each one auto-decrypts the private key, signs the transaction, submits to Solana, and wipes the key from memory -- all in one call.

### Core Operations

| Method | Description |
|---|---|
| `initialize()` | Generate keypair, encrypt with AES-256-GCM, store in keystore |
| `getBalance()` | Current SOL balance (number) |
| `getPublicKey()` | Wallet public key (base58 string) |
| `getState()` | Full wallet state snapshot (id, label, publicKey, balance, cluster) |
| `getConnection()` | Underlying Solana RPC connection |
| `getExplorerUrl(signature)` | Solana Explorer link for any transaction |

### SOL Operations

| Method | Description |
|---|---|
| `requestAirdrop(amountSol)` | Request devnet SOL airdrop |
| `transferSOL(destination, amountSol)` | Sign and send SOL transfer |
| `stakeSOL(validatorVote, amountSol)` | Delegate SOL to a validator via Stake Program |

### SPL Token Operations

| Method | Description |
|---|---|
| `createTokenMint(decimals)` | Create a new SPL token mint (wallet = authority) |
| `mintTokens(mint, amount)` | Mint tokens to own associated token account |
| `transferToken(mint, destination, amount)` | Transfer SPL tokens (auto-creates destination ATA) |
| `getTokenBalances()` | All SPL token balances: `{ mint, balance, decimals, uiBalance }[]` |

### AMM / DeFi Operations

| Method | Description |
|---|---|
| `createAmmPool(tokenMint, feeBps?)` | Create a constant-product AMM pool on-chain |
| `addLiquidity(tokenMint, solAmount, tokenAmount)` | Add liquidity to AMM pool |
| `swapSolForToken(mint, lamports, minOut, authority?)` | Swap SOL for tokens on AMM |
| `swapTokenForSol(mint, tokenAmount, minOut, authority?)` | Swap tokens for SOL on AMM |
| `getPoolState(mint, authority?)` | Query pool reserves, fee rate, price |
| `depositToVault(agentId, amountSol)` | Deposit SOL into on-chain PDA vault |

### Protocol Interaction

| Method | Description |
|---|---|
| `sendMemo(text)` | Write on-chain memo via Solana Memo Program v2 |
| `submitSerializedTransaction(base64Tx)` | Submit a pre-built transaction (e.g. from Jupiter) |
| `simulateTransaction(tx)` | Preflight simulation before sending |

### Security & Configuration

| Method | Description |
|---|---|
| `setPolicyEngine(engine)` | Attach 8-layer security policy (spending limits, rate limits, allowlists) |
| `setKoraClient(client)` | Enable gasless transactions via Kora fee abstraction |
| `enrichTransactionResult(signature)` | Fetch on-chain slot, fee, blockTime for a confirmed tx |

---

## Wallet Architecture

```
Your AI Agent (any language/framework)
        |
        v
  AgenticWallet  <-- the product
    |-- KeystoreManager (AES-256-GCM encryption, PBKDF2 key derivation)
    |-- PolicyEngine (optional: 8-layer security validation)
    |-- KoraClient (optional: gasless transactions)
    |-- AmmClient (on-chain AMM instruction builder)
    |-- EventEmitter (transaction:confirmed, transaction:failed, wallet:funded)
        |
        v
  Solana Network (devnet / testnet / mainnet-beta)
```

**Key design principle:** The wallet has ZERO dependencies on any agent code. Agents depend on the wallet, never the reverse. This means any external agent, bot, or script can use the wallet without importing or understanding the agent layer.

---

## Security Model

### Key Management

- Private keys encrypted at rest with AES-256-GCM
- PBKDF2 key derivation: 100,000 iterations, SHA-512, random 32-byte salt
- Keys decrypted only for signing, wiped from memory immediately after (`buffer.fill(0)` in `finally` blocks)
- Each wallet has a unique salt and IV -- no key reuse

### 8-Layer Policy Engine (Optional)

When attached via `wallet.setPolicyEngine()`, every outbound transaction passes through:

1. **Circuit breaker** -- Halts after consecutive failures (auto-recovers after 60s)
2. **Program allowlist** -- Only approved programs (System, SPL Token, Memo, Jupiter, Stake, AMM)
3. **Address blocklist** -- Reject transactions to blocked destinations
4. **Per-transaction limit** -- Cap on single transaction amount
5. **Hourly spending limit** -- Rolling hourly cap
6. **Daily spending limit** -- Rolling daily cap
7. **Weekly spending limit** -- Rolling weekly cap
8. **Rate limits** -- Per-minute, per-hour, per-day transaction count caps

### Transaction Simulation

When `policy.requireSimulation = true`, the wallet runs `connection.simulateTransaction()` before signing and submitting. Failed simulations are rejected before any SOL is spent.

---

## Using the Wallet with the Built-In Agents (Optional)

SentinelVault includes 4 demonstration agents that showcase the wallet in autonomous operation. These are optional -- you don't need them to use the wallet.

### Agent Types

| Type | Class | What It Does |
|---|---|---|
| `trader` | `TradingAgent` | DCA / momentum / mean-reversion trading via AMM swaps |
| `liquidity_provider` | `LiquidityAgent` | Pool monitoring, rebalancing, liquidity management |
| `arbitrageur` | `ArbitrageAgent` | Cross-DEX price arbitrage (DexScreener + AMM + oracle) |
| `portfolio_manager` | `PortfolioAgent` | Target allocation rebalancing with drift detection |

### Orchestrator Quick Start

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

// Wire AMM pool to all agents for real swap execution
orchestrator.setPoolMintForAgents(tokenMintAddress);
orchestrator.startAll();

// Access any agent's wallet
const wallet = orchestrator.getAgentWallet(agentId);
const addresses = orchestrator.getAgentWalletAddresses(); // Map<agentId, publicKey>
```

### Inter-Agent Communication

The orchestrator provides:
- `getAgentWallet(agentId)` -- direct access to any agent's wallet
- `getAgentWalletAddresses()` -- map of all agent public keys
- `wireAgentTargetAddresses()` -- round-robin target wiring (Agent A sends to B sends to C sends to A)
- `broadcastMarketIntelligence()` -- shared market consensus across all agents
- `getMarketConsensus()` -- majority regime voting, average confidence

---

## Integration Modules

These are standalone clients that your agent can use independently of the wallet:

### Real Price Feeds

```typescript
import { PriceFeed } from 'sentinel-vault';

const priceFeed = new PriceFeed();
const price = await priceFeed.getSOLPrice();
// Returns: { price: 172.45, source: 'pyth', timestamp: ..., confidence: 0.12 } or null
// Note: confidence is only present for Pyth source; Jupiter/CoinGecko return confidence: undefined
// Priority: Pyth oracle -> Jupiter Price API -> CoinGecko -> null
```

### DexScreener (Raydium/Orca Prices)

```typescript
import { DexScreenerClient } from 'sentinel-vault';

const dex = new DexScreenerClient();
const price = await dex.getSOLPrice();
// Returns: { price, source, pairAddress, dexId, liquidity } or null
```

### Jupiter DEX Quotes

```typescript
import { JupiterClient } from 'sentinel-vault';

const jupiter = new JupiterClient();
const quote = await jupiter.getQuote({ amount: 10_000_000 }); // 0.01 SOL in lamports
// Returns: { inAmount, outAmount, priceImpactPct, routePlan }
```

### AI/LLM Advisor

```typescript
import { AIAdvisor } from 'sentinel-vault';

const advisor = new AIAdvisor(); // reads ANTHROPIC_API_KEY or OPENAI_API_KEY from env
console.log(advisor.isAvailable()); // true if API key configured
console.log(advisor.getProvider());  // 'anthropic' | 'openai' | null
```

### Kora Gasless Transactions

```typescript
import { KoraClient } from 'sentinel-vault';

const kora = new KoraClient(); // reads KORA_RPC_URL from env
if (kora.isAvailable()) {
  const config = await kora.getConfig();
  // Use with wallet.setKoraClient(kora) for gasless transfers
}
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
2. **Program allowlist** -- Rejects transactions targeting programs not in the allowed set (default: System, SPL Token, AToken, Memo v2, Jupiter V6, Stake).
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
4. **Execute** -- Translate the decision into an on-chain transaction via the agent's `AgenticWallet`. TradingAgent executes buy/sell swaps through the on-chain AMM when a pool is configured; ArbitrageAgent exploits oracle-vs-pool price discrepancies via AMM swaps; PortfolioAgent rebalances allocations via AMM swaps. All agents fall back to SOL transfers if no pool is available or a swap fails.
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
| `trader`              | `TradingAgent`    | Implemented    | Autonomous trading with real/simulated prices, executes buy/sell swaps through the on-chain AMM |
| `liquidity_provider`  | `LiquidityAgent`  | Implemented    | Simulated LP pool management and rebalancing      |
| `arbitrageur`         | `ArbitrageAgent`  | Implemented    | Oracle-vs-pool price arbitrage with real AMM swap execution |
| `portfolio_manager`   | `PortfolioAgent`  | Implemented    | Multi-asset portfolio rebalancing via AMM swaps with drift detection |

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
- **Simulated prices (fallback)** -- The TradingAgent uses real Pyth/Jupiter/CoinGecko prices by default, but falls back to a local random-walk simulation when all APIs are unreachable. The LiquidityAgent simulates pool state internally.
- **0.01 SOL trade cap** -- Each TradingAgent trade is hard-capped at 0.01 SOL (and never more than 10% of wallet balance) to protect devnet funds.
- **AMM swap fallback** -- Agents execute real swaps through the on-chain constant-product AMM when a pool is configured via `orchestrator.setPoolMintForAgents()`. If no pool is configured or a swap transaction fails, agents fall back to SOL transfers to a target address. SPL token operations use real on-chain mint/transfer via `@solana/spl-token`.
- **Single-process** -- All agents run in a single Node.js process. No distributed coordination or persistence across restarts.
- **No mainnet safeguards** -- There is no multi-sig, hardware wallet integration, or human-in-the-loop approval workflow.
- **Airdrop rate limits** -- Devnet airdrops are rate-limited by Solana. Sequential funding with 5-second delays is used, but failures are possible under load.
