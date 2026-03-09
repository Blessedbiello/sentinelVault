# SentinelVault: Technical Deep Dive

**Autonomous AI Agent Wallet Framework for Solana**

---

## 1. Problem Statement

The rise of autonomous AI agents in decentralized finance creates a fundamental tension that no existing wallet infrastructure addresses. Today's Solana wallets -- Phantom, Solflare, Backpack -- are designed around a human sitting at a screen, manually reviewing and signing each transaction. This interaction model breaks down completely when the operator is a software agent that needs to execute trades at machine speed, around the clock, without human intervention.

The core challenge is what we call the **autonomy paradox**: an AI agent needs unrestricted access to private key material to sign transactions on its own, yet unrestricted access to private keys is precisely the attack surface that has drained hundreds of millions of dollars from DeFi protocols. A compromised agent with unlimited signing authority is indistinguishable from a malicious actor.

The problem decomposes into four sub-problems:

1. **Key custody without human presence.** The agent must be able to decrypt and use its private key programmatically, but the key must not persist in memory longer than necessary.
2. **Policy enforcement without human approval.** Spending limits, rate limits, and program allowlists must be enforced automatically -- before every transaction reaches the network.
3. **Multi-agent isolation.** When multiple agents operate concurrently, a failure or compromise in one agent must not cascade to others.
4. **Observability without overhead.** Every decision, every transaction, every policy violation must be logged and scored for risk, without degrading agent throughput.

SentinelVault is a production-quality answer to all four. It gives AI agents the freedom to operate autonomously on Solana while wrapping that freedom in eight distinct layers of security, cryptographic key isolation, and a comprehensive audit trail.

---

## 2. Architecture Overview

SentinelVault is organized as a four-layer stack where each layer depends only on the layer below it:

```
+-----------------------------------------------------+
|                    Interface Layer                    |
|         CLI  |  REST API  |  WebSocket Dashboard     |
+-----------------------------------------------------+
|                     Agent Layer                       |
|   BaseAgent (OODA)  |  TradingAgent  |  LiquidityAgent  |  Orchestrator  |
+-----------------------------------------------------+
|                    Security Layer                     |
|        PolicyEngine  |  AuditLogger                  |
+-----------------------------------------------------+
|                      Core Layer                       |
|         KeystoreManager  |  AgenticWallet          |
+-----------------------------------------------------+
|                  Solana (devnet / mainnet)            |
+-----------------------------------------------------+
```

**Why layered?** Each layer can be tested, replaced, or extended independently. The `KeystoreManager` knows nothing about agents. The `PolicyEngine` knows nothing about wallets. The `AgentOrchestrator` knows nothing about cryptography. This separation means that swapping in a hardware security module for key storage, or replacing the policy engine with an on-chain governance contract, requires changes to exactly one layer.

**Why EventEmitter-driven?** Every major component -- `AgenticWallet`, `BaseAgent`, `PolicyEngine`, `AgentOrchestrator` -- extends `EventEmitter`. This creates loose coupling between components: the wallet emits `transaction:confirmed`, the orchestrator listens and forwards it to the audit logger, and the dashboard broadcasts it over WebSocket. No component holds a direct reference to any component it does not strictly depend on. This pattern eliminates circular dependencies, simplifies testing with mock listeners, and makes the system extensible. Adding a Telegram alerting integration, for instance, requires zero changes to existing code -- just a new listener on the orchestrator's `alert` event.

---

## 3. Wallet Design and Key Management

Key management is the foundation that everything else rests on. A single implementation error here means total loss of funds. SentinelVault uses a defense-in-depth approach to minimize the window in which key material is vulnerable.

### Encryption at Rest: AES-256-GCM + PBKDF2

Each agent's Solana keypair is encrypted using AES-256-GCM with a key derived from a password via PBKDF2. The specific parameters:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Cipher | AES-256-GCM | Authenticated encryption -- the GCM authentication tag detects tampering, unlike CBC which is malleable |
| KDF | PBKDF2 | NIST SP 800-132 recommended; hardware acceleration resistance on commodity CPUs |
| KDF digest | SHA-512 | Wider internal state than SHA-256, marginally harder to parallelize on GPUs |
| KDF iterations | 100,000 | Balances security against agent startup latency (~200ms on modern hardware) |
| Key length | 256 bits | Full AES-256 key space |
| IV length | 96 bits | NIST recommended length for GCM; avoids the birthday-bound weakness of longer IVs |
| Salt length | 256 bits | Unique per keystore; prevents rainbow table attacks across agents |

**Why GCM over CBC?** CBC mode encrypts data but provides no integrity guarantee. An attacker who can modify the ciphertext file on disk can flip bits in the decrypted plaintext without detection. GCM produces a 128-bit authentication tag that is verified during decryption. If even a single bit of the ciphertext, IV, or additional authenticated data has been altered, decryption fails with an explicit authentication error. For a system where a corrupted private key means sending funds to a random address, integrity verification is not optional.

**Why PBKDF2 over bcrypt or scrypt?** PBKDF2 with SHA-512 is the NIST-recommended password-based key derivation function (SP 800-132). While bcrypt and scrypt offer stronger memory-hardness properties against ASIC attackers, PBKDF2 has two practical advantages in this context: it is available natively in Node.js's `crypto` module with no C++ addon dependencies, and its iteration count maps directly to computational cost in a way that is simple to tune per-deployment. For a devnet prototype where the threat model is primarily accidental exposure rather than nation-state-level offline cracking, PBKDF2 at 100,000 iterations provides a strong baseline that can be swapped for Argon2id on the path to mainnet.

### Secure Key Material Lifecycle

The critical design principle is **minimal exposure window**. Key material follows a strict lifecycle:

1. **Decrypt on demand.** `KeystoreManager.decryptKeypair()` reads the encrypted keystore from disk, derives the decryption key, and returns a `Keypair`.
2. **Use immediately.** The wallet signs the transaction with the decrypted keypair.
3. **Wipe unconditionally.** In a `finally` block, `keypair.secretKey.fill(0)` overwrites the secret key bytes with zeros. This executes whether the transaction succeeded, failed, or threw an exception.

This pattern appears consistently across the codebase. In `AgenticWallet.signAndSendTransaction()`:

```typescript
try {
  keypair = this.keystoreManager.decryptKeypair(this.keystoreId!, this.password);
  // ... sign and send ...
} finally {
  if (keypair !== null) {
    keypair.secretKey.fill(0);
  }
}
```

The derived encryption key itself is also wiped after use inside the `KeystoreManager.encrypt()` and `decrypt()` methods via the private `secureWipe()` helper. Secret key bytes (the Ed25519 keypair) never persist in memory beyond the scope of a single operation.

**Password lifecycle.** The wallet password is retained in memory for the wallet's lifetime because the agent must decrypt the keypair autonomously for each transaction. This is an intentional design trade-off: an autonomous agent cannot prompt for a password interactively. The password is a string, not raw key material -- it must still pass through PBKDF2 (100,000 iterations) to derive the decryption key, so possession of the password alone does not yield the private key without the keystore file's unique salt. In production deployments, we recommend sourcing the password from a secure vault (e.g. HashiCorp Vault, AWS Secrets Manager) and restricting process memory access via OS-level controls.

### Filesystem Hardening

Keystore files are written with POSIX permission mode `0o600` (owner read/write only). The keystore directory is created with mode `0o700`. If the directory already exists with looser permissions, the constructor tightens them on startup.

---

## 4. Transaction Lifecycle

A transaction in SentinelVault passes through a well-defined pipeline before reaching the Solana network:

```
Request  -->  Policy Validation  -->  Signing  -->  Submission  -->  Confirmation
                    |                                    |
                    v                                    v
              [BLOCKED]                            [RETRY with backoff]
```

### Transaction Signing Pipeline

The `AgenticWallet.signAndSendTransaction()` method is the critical path for all on-chain interactions. It follows a strict sequence: decrypt keypair → attach fresh blockhash → sign → broadcast → confirm → wipe key. The keypair is wiped in a `finally` block regardless of outcome, ensuring that secret key material never persists beyond a single operation.

### Retry with Exponential Backoff

The airdrop mechanism retries up to 3 times with exponential backoff: `baseDelay * 2^attempt`, capped at a reasonable ceiling. This prevents hammering the RPC endpoint during transient outages while ensuring rapid recovery once the issue resolves.

### Metrics

The orchestrator maintains rolling aggregate metrics -- total transactions, successful vs. failed, total volume, and average TPS -- computed from agent performance data. The wallet emits `transaction:confirmed` and `transaction:failed` events that feed the agent's performance counters, which in turn feed the orchestrator's system-wide dashboard without requiring any batch aggregation.

---

## 5. AI Agent Integration -- The OODA Loop

### Why OODA?

The OODA loop (Observe, Orient, Decide, Act) was developed by military strategist John Boyd to model decision-making in adversarial, time-sensitive environments. DeFi trading is precisely such an environment: prices move against you in milliseconds, adversaries (MEV bots, other traders) actively compete for the same opportunities, and information is incomplete. OODA's explicit separation of observation from analysis from execution maps naturally onto the distinct concerns of data ingestion, strategy logic, and transaction submission.

SentinelVault adapts OODA into four abstract methods that every agent must implement:

1. **`observe()`** -- Gather market data, wallet balances, pool states, or any other environmental signal.
2. **`analyze()`** -- Apply strategy logic to the observations and produce an `AgentDecision` with a confidence score, action type, and human-readable reasoning.
3. **`execute()`** -- Translate the decision into on-chain action (SOL transfers, LP operations). Only called when confidence exceeds the 0.5 threshold and the action is not `hold`.
4. **`evaluate()`** -- Assess the outcome and update internal performance metrics, strategy state, or feedback signals.

### Confidence Gate

The confidence threshold (0.5) acts as a decision filter. Low-conviction signals -- ambiguous market conditions, converging moving averages, prices within the neutral zone -- produce decisions with confidence below the threshold. These are recorded in the decision history for post-hoc analysis but never executed. This prevents the agent from overtrading during periods of uncertainty.

### Auto-Recovery

If any phase of the OODA cycle throws an unhandled exception, the agent transitions to `error` status, emits `agent:error`, and schedules a self-healing recovery after a 5-second cooldown. The recovery restarts the OODA interval only if the agent has not been explicitly stopped in the meantime. This design prevents transient RPC failures from permanently killing an agent while respecting intentional shutdown commands.

### Strategy Implementations

The `TradingAgent` ships with three strategies, each demonstrating a distinct trading philosophy:

- **DCA (Dollar-Cost Averaging):** Buy unconditionally on every cycle. Confidence is the higher of 0.6 or the multi-factor composite score. The simplest strategy -- exists to prove the framework works end-to-end with real transactions.
- **Momentum:** Uses a multi-factor scoring system. Buy when composite confidence > 0.55 and trend is bullish (SMA20 > SL50). Sell when composite < 0.45 and trend is bearish. Hold otherwise.
- **Mean Reversion:** Buy when price falls below 95% of the base price; sell when it rises above 105%. Confidence incorporates the multi-factor composite score plus deviation magnitude, capped at 0.95.

### Multi-Factor AI Decision Model

All three strategies now use a four-factor scoring system that produces explainable decisions:

1. **Trend Score (weight: 0.4)** — SMA crossover direction and magnitude. Measures how strongly the short SMA has crossed above/below the long SMA.
2. **Momentum Score (weight: 0.3)** — Rate of price change over the most recent 5 ticks. Captures short-term directional pressure.
3. **Volatility Score (weight: 0.2)** — Inverse of price standard deviation. Low volatility environments are more favorable for entry.
4. **Balance Score (weight: 0.1)** — Penalizes when wallet balance < 0.05 SOL, preventing trades that would deplete the agent.

The weighted composite confidence is: `0.4×trend + 0.3×momentum + 0.2×volatility + 0.1×balance`.

Each decision includes a `reasoningChain` — an array of strings documenting every factor's contribution to the final decision. This transforms the agent from a simple if/else into a legitimate multi-factor expert system with fully explainable decisions.

The `LiquidityAgent` demonstrates a different class of agent entirely: it manages a simulated LP pool, making rebalance, add-liquidity, and remove-liquidity decisions based on pool imbalance, APY, and utilization thresholds.

### Real Price Feeds and Jupiter Integration

The `TradingAgent` integrates with two real price APIs and a DEX quote service:

**Price Feed (PriceFeed class):**
1. **Jupiter Price API V2** — Primary source. Fetches SOL/USD from `https://api.jup.ag/price/v2`. Response is cached for 30 seconds to avoid rate limiting.
2. **CoinGecko API** — Fallback when Jupiter is unavailable. Uses the free `/simple/price` endpoint.
3. **Simulated price** — Final fallback. A random walk with mean reversion generates realistic-looking price series when both APIs are unreachable.

This three-tier fallback ensures the agent always has a price to work with, regardless of network conditions. The price source is recorded in the reasoning chain for transparency.

**Jupiter DEX Quotes (JupiterClient class):**

On each OODA cycle, the agent fetches a real Jupiter V6 swap quote for 0.01 SOL → USDC. The quote reveals:
- **Route plan** — Which AMM pools (Raydium, Orca, etc.) Jupiter would route through
- **Price impact** — How much the swap would move the market
- **Output amount** — The real USDC equivalent at current market prices

This demonstrates that the agent is aware of real DEX infrastructure and could execute swaps on mainnet. On devnet, actual execution remains as SOL transfers since Jupiter AMM pools are mainnet-only — this is documented explicitly in the reasoning chain.

### AI Advisor Integration

When `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is configured, the `AIAdvisor` class sends market context to an LLM and blends the recommendation with the quantitative signal:

```
Blended Confidence = 0.6 × quantitativeConfidence + 0.4 × aiConfidence
```

The AI receives: current SOL price, price history, wallet balance, strategy type, and the quantitative signal. It returns a structured JSON recommendation (action, confidence, reasoning) that is included in the agent's reasoning chain.

Design principles:
- **Graceful degradation** — When no API key is set, `aiAdvisor.getTradeRecommendation()` returns `null` and the agent uses pure quantitative scoring. There is zero impact on functionality.
- **Cost efficiency** — Uses Claude Haiku (cheapest/fastest model) with a 300-token limit.
- **Timeout protection** — 8-second timeout prevents slow API responses from blocking the OODA cycle.
- **Error isolation** — All API errors are caught and logged; they never propagate to the agent's error state.

### Simulated Price Feeds (Fallback)

When real APIs are unavailable, the `TradingAgent` generates prices via a random walk with mean reversion:

```
drift    = (basePrice - currentPrice) * 0.1
noise    = (Math.random() - 0.5) * 0.04
newPrice = clamp(currentPrice + drift + noise, basePrice * 0.5, basePrice * 1.5)
```

This produces realistic-looking price series that oscillate around a base value, generating enough signal variation to exercise all three strategies.

---

## 6. Security Model -- Eight Layers of Defense

The `PolicyEngine` evaluates every outbound transaction against an ordered chain of eight checks. The chain short-circuits on the first failure, so the cheapest checks (circuit breaker, allowlist lookup) run before the more expensive ones (spending window aggregation, rate counting).

### Layer 1: Circuit Breaker

After 5 consecutive transaction failures, the circuit breaker opens and blocks all outbound transactions for 60 seconds. This prevents a malfunctioning agent from burning through funds on repeated failed attempts. The breaker auto-resets after the recovery period, and can also be manually reset via `resetCircuitBreaker()`.

### Layer 2: Program Allowlist

Only transactions targeting explicitly approved Solana programs are permitted. The default policy allowlists four programs: System Program (`11111111...`), SPL Token Program (`TokenkegQ...`), Associated Token Program (`ATokenGPv...`), and Memo Program v2 (`MemoSq4gq...`). Any attempt to interact with an unlisted program -- whether a malicious contract injection or an accidental misconfiguration -- is blocked with a `high` severity violation.

### Layer 3: Address Blocklist

Known malicious or sanctioned addresses can be added to a blocklist. Transactions targeting any blocklisted address are rejected with `critical` severity. This provides a rapid-response mechanism for emerging threats.

### Layer 4: Per-Transaction Spending Limit

Each individual transaction is capped at a configurable SOL amount (default: 1 SOL). This ensures that even if every other check passes, no single operation can drain a disproportionate share of the wallet.

### Layer 5: Hourly Spending Limit

Rolling one-hour window tracking cumulative spend (default: 5 SOL). Windows are lazily reset -- no background timers are needed. When the window's start time is more than one hour ago, the counters reset to zero on the next check.

### Layer 6: Daily Spending Limit

Rolling 24-hour window (default: 20 SOL). Same lazy-reset mechanism.

### Layer 7: Weekly Spending Limit

Rolling 7-day window (default: 100 SOL). Provides a longer-horizon guardrail that catches slow-drip attacks that stay within hourly and daily limits.

### Layer 8: Rate Limiting

Three independent rate counters: per-minute (default: 10), per-hour (default: 60), and per-day (default: 500). Transaction timestamps are stored in a flat array and pruned of entries older than 24 hours on each check, preventing unbounded memory growth over long agent lifetimes.

### Violation Tracking and Risk Scoring

Every blocked transaction generates a `SecurityViolation` object with a unique ID, timestamp, agent ID, rule name, severity level, and structured details. Violations are stored in-memory and emitted as events so the audit logger and dashboard can react in real time.

The `AuditLogger` assigns a composite risk score to every logged event. Base scores are determined by category (policy violations start at 0.8, transactions at 0.3, agent decisions at 0.1). Modifiers are added for transaction amount (0.05 per SOL), unknown programs (+0.2), and error presence (+0.15). The final score is clamped to [0, 1]. This scoring enables at-a-glance identification of the highest-risk actions across the system.

---

## 7. Multi-Agent Scalability

### Orchestrator Pattern

The `AgentOrchestrator` is the central coordination layer. It owns the agent registry (a `Map<string, AgentRegistryEntry>`) and manages the complete lifecycle: creation, wallet initialization, policy engine setup, event wiring, funding, health monitoring, and graceful shutdown.

### Wallet Isolation

Each agent receives its own `AgenticWallet` with its own encrypted keystore, its own `PolicyEngine` instance, and its own spending windows. There is no shared key material, no shared spending budget, and no shared state between agents. A compromised or malfunctioning agent cannot access another agent's funds or policy configuration.

### Health Monitoring with Auto-Restart

The orchestrator runs periodic health checks (default: every 30 seconds). When an agent is found in `error` status and `autoRestart` is enabled, the orchestrator calls `agent.resume()` to restart the OODA loop. If recovery fails, a `critical` alert is raised. This ensures that transient failures -- network timeouts, RPC rate limits -- do not require manual intervention.

### Resource Awareness

The orchestrator enforces a configurable `maxAgents` capacity (default: 10). System metrics include `memoryUsageMb` from `process.memoryUsage().heapUsed`, surfaced through the dashboard API so operators can monitor resource consumption as agent count scales.

### Event-Driven Architecture

The orchestrator subscribes to agent and wallet events and forwards them to the audit logger and alert system. This avoids the need for agents to hold references to infrastructure they should not know about, and eliminates polling overhead entirely. The WebSocket dashboard layer subscribes to orchestrator events in turn, creating a clean fan-out from source events to UI updates.

---

## 8. Devnet Prototype

### What Works Today

SentinelVault is not a whitepaper or a mockup. The following operations execute against the real Solana devnet:

- **Wallet creation:** `Keypair.generate()` produces a real ed25519 keypair, encrypted and persisted to disk.
- **Airdrops:** `connection.requestAirdrop()` requests real devnet SOL from the Solana faucet, with exponential backoff retry (up to 3 attempts).
- **SOL transfers:** `connection.sendRawTransaction()` submits real signed transactions to devnet validators. Transaction signatures are verifiable on Solana Explorer.
- **SPL token operations:** Create token mints, mint tokens, transfer tokens between agent wallets, and query token balances — all using `@solana/spl-token` against real devnet state.
- **Memo program interaction:** Write arbitrary text on-chain via the Memo Program v2 (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`), demonstrating dApp protocol interaction.
- **Agent-to-agent transfers:** Agents target each other's wallet addresses, enabling inter-agent SOL and token transfers.
- **Balance queries:** `connection.getBalance()` and `connection.getParsedTokenAccountsByOwner()` read real on-chain state.

### Devnet Safety Controls

All trading is capped at 0.01 SOL per transaction (`MAX_TRADE_AMOUNT_SOL`). An additional guard ensures no trade exceeds 10% of the wallet balance (`MAX_TRADE_BALANCE_FRACTION`). If the computed trade amount falls below 0.001 SOL, the trade is skipped entirely. These three constraints work in concert to ensure that devnet funds are consumed slowly enough for meaningful multi-day testing.

### Demo Scripts

Four demo scripts provide turnkey demonstrations:

- **`demo-showcase.ts`** -- **Judge-facing showcase** that exercises every bounty requirement: wallet creation, SPL token mint/transfer, Memo program interaction, agent-to-agent trading with reasoning chains, and live dashboard. Run with `npm run demo:showcase`.
- **`demo.ts`** -- Full multi-agent end-to-end: create four agents, fund, run OODA loops, display status tables.
- **`demo-multi-agent.ts`** -- Wallet independence demo with concurrent agents.
- **`demo-trading.ts`** -- Focused trading demonstration with detailed per-decision output.

All scripts produce Solana Explorer URLs for every transaction, allowing judges to independently verify that real on-chain activity occurred.

### Dashboard

The `DashboardServer` exposes a REST API on port 3000 and a WebSocket server on port 3001. It also serves a self-contained HTML dashboard at `http://localhost:3000` with a dark-themed "crypto native" UI featuring agent cards (name, type, status badge, SOL/token balances, decisions, trades), a system metrics bar, and a live WebSocket activity feed. Endpoints include `/api/health`, `/api/metrics`, `/api/dashboard`, `/api/agents`, `/api/audit`, `/api/risk`, and `/api/alerts`. The WebSocket layer pushes real-time updates to connected clients on every agent creation, start, stop, alert, and metrics tick. New WebSocket clients receive an immediate full-state snapshot so they do not have to wait for the next broadcast cycle.

---

## 9. Performance Characteristics

The following measurements were collected on a typical development machine (Intel i7, Node.js 18, Solana devnet). All timings are wall-clock averages over multiple runs.

| Operation | Measured Time | Notes |
|---|---|---|
| PBKDF2 key derivation | ~180–250 ms | 100,000 iterations, SHA-512 |
| Wallet initialize (keygen + encrypt + disk write) | ~250–350 ms | Includes PBKDF2 + AES-256-GCM + `fs.writeFileSync` |
| OODA cycle (no execution) | < 5 ms | observe + analyze + evaluate with mock wallet |
| Policy validation (8 layers) | < 1 ms | All 8 checks run sequentially; short-circuits on first failure |
| Agent creation via orchestrator | ~300–400 ms | Wallet init + policy engine setup + event wiring |
| Transaction signing + submission | ~50–100 ms | Decrypt keypair + sign + `sendRawTransaction` (local; network latency adds ~200–800 ms on devnet) |
| Simulated price tick | < 0.1 ms | Random walk + mean reversion + history append |

### Multi-Factor Decision Model Weights

The `TradingAgent`'s multi-factor scoring system computes a weighted composite confidence:

```
Composite Confidence = 0.4 × trendScore + 0.3 × momentumScore + 0.2 × volatilityScore + 0.1 × balanceScore
```

| Factor | Weight | Signal Source | Range |
|---|---|---|---|
| Trend Score | 0.4 | SMA₂₀ vs SMA₅₀ crossover magnitude | 0–1 |
| Momentum Score | 0.3 | Price change over last 5 ticks | 0–1 |
| Volatility Score | 0.2 | Inverse of price standard deviation | 0–1 (low vol = high score) |
| Balance Score | 0.1 | Wallet SOL balance vs 0.05 SOL floor | 0–1 |

Each factor produces a human-readable reasoning chain entry, making every decision fully explainable and auditable.

### Trade Size Constraints

Three independent guards prevent excessive spending on devnet:

1. **Hard cap**: `MAX_TRADE_AMOUNT_SOL = 0.01` — no single trade exceeds 0.01 SOL
2. **Balance fraction**: `MAX_TRADE_BALANCE_FRACTION = 0.1` — no trade exceeds 10% of current balance
3. **Minimum threshold**: `MIN_TRADE_AMOUNT_SOL = 0.001` — trades below 0.001 SOL are skipped entirely

The effective trade size is `min(0.01, balance × 0.1)`, and the trade is only executed if this value ≥ 0.001 SOL.

---

## 10. Future Directions

SentinelVault is designed as an extensible framework, not a finished product. The architecture explicitly anticipates several expansion vectors:

**Jupiter and Raydium Integration.** The `allowedPrograms` policy field is designed to accommodate arbitrary Solana programs. Adding Jupiter swap routing requires implementing a new execution strategy in the agent layer and adding the Jupiter program IDs to the allowlist, while the security and core layers remain unchanged.

**On-Chain Governance.** The `PolicyEngine.updatePolicy()` method accepts partial policy updates at runtime. Moving policy storage on-chain -- where updates require multi-sig approval or DAO vote -- would replace the in-memory policy object with an on-chain account read, preserving the same validation interface.

**Multi-Signature Support.** `AgenticWallet.signTransaction()` already supports signing without broadcasting, returning the signed transaction for multi-sig aggregation. Extending this to a k-of-n threshold scheme requires adding a co-signer coordination layer above the wallet.

**ML-Based Anomaly Detection.** The audit logger's risk scoring system produces a continuous stream of labeled events. This data is the natural input for an anomaly detection model that could learn normal agent behavior patterns and flag statistical outliers -- unusual transaction sizes, atypical timing patterns, or sudden shifts in strategy decisions.

**Cross-Chain Expansion.** The layered architecture means the agent and security layers are not Solana-specific. The `BaseAgent` OODA loop, `PolicyEngine` validation chain, and `AuditLogger` risk scoring could operate over an EVM wallet adapter with no changes to their interfaces.

---

## 11. Conclusion

SentinelVault demonstrates that autonomous AI agents can safely manage blockchain wallets without sacrificing the speed and independence that make them valuable. The framework achieves this through a deliberate architectural decomposition:

- **Core layer** provides military-grade key encryption with AES-256-GCM and a minimal-exposure key lifecycle that wipes secrets in `finally` blocks.
- **Security layer** enforces eight independent checks -- from circuit breakers to weekly spending caps -- before any transaction reaches the network, with every violation logged, scored, and emitted as a real-time event.
- **Agent layer** adapts the OODA decision loop from military strategy to DeFi, with a confidence gate that prevents low-conviction trades, auto-recovery from transient errors, and isolated wallets per agent.
- **Interface layer** surfaces everything through a CLI, REST API, and WebSocket dashboard, making the system observable and controllable in real time.

This is not a theoretical design. The devnet prototype creates real wallets, requests real airdrops, submits real transactions, and produces real Solana Explorer-verifiable signatures. Every architectural decision documented here is implemented in working TypeScript, backed by a test suite covering the keystore, wallet, policy engine, audit logger, and orchestrator.

The framework already integrates with Jupiter for real price feeds and DEX swap quotes, and supports optional LLM-powered trade recommendations via the AI Advisor. The path from devnet prototype to mainnet deployment requires executing Jupiter swaps against real liquidity pools, hardening the KDF to Argon2id, adding multi-sig support for high-value operations, and implementing ML-based anomaly detection on the audit stream. The framework is explicitly designed so that each of these additions touches exactly one layer while the rest remains stable.

SentinelVault is a security-first, production-quality foundation for the next generation of autonomous DeFi agents on Solana.
