// SentinelVault — Public API
// Barrel exports for the autonomous AI agent wallet framework

// Core
export { KeystoreManager, createKeystoreManager } from './core/keystore';
export type { CreatedWalletResult, KeystoreSummary } from './core/keystore';
export { AgenticWallet } from './core/wallet';

// Security
export { PolicyEngine } from './security/policy-engine';
export { AuditLogger } from './security/audit-logger';

// Agents
export { BaseAgent } from './agents/base-agent';
export { TradingAgent } from './agents/trading-agent';
export { LiquidityAgent } from './agents/liquidity-agent';
export { AgentOrchestrator } from './agents/orchestrator';

// Integrations
export { PriceFeed } from './integrations/price-feed';
export { JupiterClient } from './integrations/jupiter';
export { AIAdvisor } from './integrations/ai-advisor';

// Dashboard
export { DashboardServer } from './dashboard/server';

// Types — re-export everything from the types module
export * from './types';
