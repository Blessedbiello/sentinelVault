# CLAUDE.md -- Development Instructions for AI Coding Assistants

## Project

SentinelVault -- Autonomous AI Agent Wallet Framework for Solana.
TypeScript, Node.js >= 18, Solana devnet.

## Build Commands

```
npm run build          # Compile TypeScript (tsc)
npm test               # Run all tests (Jest, verbose)
npm run test:coverage  # Run tests with coverage report
npx tsc --noEmit       # Type check only, no emit
```

## Run Commands

```
npm run demo           # Full multi-agent demo
npm run demo:multi     # Wallet independence demo
npm run demo:trade     # Single trading agent demo
npm run cli -- status  # CLI status check
npm run dashboard      # Start REST (port 3000) + WebSocket (port 3001) server
npm run dev            # Dev mode with auto-restart (ts-node-dev)
```

## Project Structure

```
src/
  index.ts                  # Public barrel exports
  types/index.ts            # All TypeScript interfaces and types (single source of truth)
  core/
    keystore.ts             # AES-256-GCM encrypted keystore manager
    wallet.ts               # AgenticWallet -- event-driven wallet for agents
  security/
    policy-engine.ts        # 8-layer security validation chain
    audit-logger.ts         # Structured audit log with risk scoring
  integrations/
    price-feed.ts           # Real SOL/USD from Pyth + Jupiter + CoinGecko
    jupiter.ts              # Jupiter V6 DEX quote/swap client
    amm-client.ts           # TypeScript client for on-chain constant-product AMM
    ai-advisor.ts           # Optional LLM trade advisor (Claude/OpenAI)
  agents/
    base-agent.ts           # Abstract OODA loop base class
    trading-agent.ts        # DCA, momentum, mean reversion + real prices + AI
    liquidity-agent.ts      # Simulated LP pool management
    arbitrage-agent.ts      # Cross-DEX arbitrage with oracle-vs-pool price comparison
    portfolio-agent.ts      # Multi-asset portfolio rebalancing with drift detection
    orchestrator.ts         # Multi-agent lifecycle coordinator
  cli/index.ts              # Commander-based CLI
  dashboard/server.ts       # Express REST API + WebSocket push server
programs/                    # Anchor on-chain programs (AMM, vault)
tests/                      # Jest test files (*.test.ts)
scripts/                    # Demo scripts (demo.ts, demo-multi-agent.ts, demo-trading.ts)
.sentinelvault/             # Runtime data directory (keystores, audit logs)
```

## Key Conventions

- **EventEmitter**: Use `eventemitter3` (not the Node.js built-in). Import as:
  ```typescript
  import EventEmitter from 'eventemitter3';
  ```
- **Module system**: CommonJS (`"module": "commonjs"` in tsconfig). Use CJS-compatible package versions:
  - `chalk` v4 (not v5+)
  - `ora` v5 (not v6+)
  - `boxen` v5 (not v6+)
- **Imports**: Relative imports only within `src/`. No path aliases.
- **bs58**: Version 5. Import as `import bs58 from 'bs58'`.
- **Data directory**: `.sentinelvault/` for keystores and audit logs. Created automatically by KeystoreManager.
- **Secure wipe**: Always zero out secret key buffers in `finally` blocks:
  ```typescript
  finally {
    if (keypair !== null) {
      keypair.secretKey.fill(0);
    }
  }
  ```
- **Types**: All interfaces and type aliases live in `src/types/index.ts`. Do not scatter type definitions across modules.
- **UUIDs**: Use `uuid` v9 (`import { v4 as uuidv4 } from 'uuid'`).
- **Error handling**: Normalize errors with `err instanceof Error ? err : new Error(String(err))`.

## Testing

- **Framework**: Jest with `ts-jest` preset. Config in `jest.config.js`.
- **Test location**: `tests/*.test.ts` (not co-located with source).
- **Timeout**: 30 seconds per test (network operations).
- **Mock external deps**: Mock Solana RPC calls (`@solana/web3.js` Connection methods). Do not hit real devnet in unit tests.
- **Temp directories**: Use `fs.mkdtempSync` for keystore tests; clean up in `afterEach`/`afterAll`.
- **Coverage**: Collected from `src/**/*.ts` excluding `cli/`, `dashboard/`, and `index.ts`.

## Commit Guidelines

- Write descriptive commit messages explaining what changed and why.
- No `Co-Authored-By` trailer needed.
- Keep commits focused: one logical change per commit.
