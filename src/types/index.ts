// SentinelVault — Type Definitions
// Single source of truth for all TypeScript interfaces and types

// ─── Wallet Types ────────────────────────────────────────────────────────────

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
export type WalletStatus = 'active' | 'locked' | 'suspended' | 'archived';

export interface WalletConfig {
  id: string;
  label: string;
  password: string;
  keystorePath?: string;
  cluster: SolanaCluster;
  rpcEndpoint?: string;
}

export interface WalletState {
  id: string;
  label: string;
  publicKey: string;
  cluster: SolanaCluster;
  balanceSol: number;
  tokenBalances: TokenBalance[];
  createdAt: number;
  lastActivity: number;
  transactionCount: number;
  status: WalletStatus;
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  balance: number;
  decimals: number;
  uiBalance: string;
}

// ─── Keystore Types ──────────────────────────────────────────────────────────

export interface EncryptedKeystore {
  version: number;
  id: string;
  publicKey: string;
  crypto: {
    cipher: string;
    cipherText: string;
    cipherParams: {
      iv: string;
      tag: string;
    };
    kdf: string;
    kdfParams: {
      salt: string;
      iterations: number;
      keyLength: number;
      digest: string;
    };
  };
  metadata: {
    createdAt: number;
    label: string;
    cluster: SolanaCluster;
  };
}

// ─── Transaction Types ───────────────────────────────────────────────────────

export type TransactionType =
  | 'transfer_sol'
  | 'transfer_spl'
  | 'swap'
  | 'swap_sol_for_token'
  | 'swap_token_for_sol'
  | 'add_liquidity'
  | 'create_pool'
  | 'stake'
  | 'unstake'
  | 'create_account'
  | 'close_account'
  | 'vault_deposit'
  | 'vault_withdraw'
  | 'custom';

export type TransactionPriority = 'low' | 'medium' | 'high' | 'critical';

export interface TransactionRequest {
  id: string;
  agentId: string;
  walletId: string;
  type: TransactionType;
  priority: TransactionPriority;
  maxRetries: number;
  simulateFirst: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface TransactionResult {
  id: string;
  signature: string;
  status: 'confirmed' | 'finalized' | 'failed' | 'timeout';
  slot: number;
  blockTime: number | null;
  fee: number;
  error: string | null;
  logs: string[];
  duration: number;
}

export interface TransactionRecord {
  id: string;
  request: TransactionRequest;
  result: TransactionResult | null;
  attempts: number;
  createdAt: number;
  completedAt: number | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export interface TransactionOptions {
  priority?: TransactionPriority;
  maxRetries?: number;
  simulateFirst?: boolean;
  metadata?: Record<string, unknown>;
}

// ─── Agent Types ─────────────────────────────────────────────────────────────

export type AgentType = 'trader' | 'liquidity_provider' | 'arbitrageur' | 'portfolio_manager';

// ─── Adaptive Learning Types ────────────────────────────────────────────────

export type MarketRegime = 'trending' | 'mean_reverting' | 'volatile' | 'quiet';

export interface AdaptiveWeights {
  trend: number;
  momentum: number;
  volatility: number;
  balance: number;
}

export interface WeightUpdate {
  timestamp: number;
  oldWeights: AdaptiveWeights;
  newWeights: AdaptiveWeights;
  trigger: string;
}

export interface ConfidenceCalibration {
  predictedBucket: string;
  totalPredictions: number;
  correctPredictions: number;
  accuracy: number;
}

export interface PendingOutcome {
  decisionId: string;
  action: string;
  entryPrice: number;
  confidence: number;
  ticksRemaining: number;
  decision: AgentDecision;
}
export type AgentStatus = 'idle' | 'analyzing' | 'executing' | 'paused' | 'error' | 'stopped';
export type StrategyType = 'dca' | 'momentum' | 'mean_reversion' | 'grid_trading' | 'liquidity_provision';

export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  walletConfig: WalletConfig;
  strategy: StrategyConfig;
  securityPolicy: SecurityPolicy;
  enabled: boolean;
}

export interface AgentState {
  id: string;
  name: string;
  type: AgentType;
  status: AgentStatus;
  wallet: WalletState;
  performance: AgentPerformance;
  currentStrategy: string;
  activeActions: AgentAction[];
  lastDecision: AgentDecision | null;
  uptime: number;
  startedAt: number;
  adaptiveWeights?: AdaptiveWeights;
  marketRegime?: MarketRegime;
  confidenceCalibration?: ConfidenceCalibration[];
  recentDecisions?: AgentDecision[];
}

export interface AgentPerformance {
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  totalVolumeSol: number;
  totalFeePaid: number;
  profitLoss: number;
  winRate: number;
  averageExecutionTime: number;
}

export interface AgentDecision {
  id: string;
  agentId: string;
  timestamp: number;
  marketConditions: Record<string, unknown>;
  analysis: string;
  action: string;
  confidence: number;
  reasoning: string;
  executed: boolean;
}

export interface AgentAction {
  id: string;
  agentId: string;
  timestamp: number;
  type: string;
  details: Record<string, unknown>;
  result?: TransactionResult;
}

export interface StrategyConfig {
  name: string;
  type: StrategyType;
  params: Record<string, unknown>;
  riskLevel: 'conservative' | 'moderate' | 'aggressive';
  maxPositionSize: number;
  stopLoss?: number;
  takeProfit?: number;
  cooldownMs: number;
}

// ─── Security Types ──────────────────────────────────────────────────────────

export interface SecurityPolicy {
  spendingLimits: {
    perTransaction: number;
    hourly: number;
    daily: number;
    weekly: number;
    monthly: number;
  };
  allowedPrograms: string[];
  blockedAddresses: string[];
  requireSimulation: boolean;
  maxTransactionsPerMinute: number;
  maxTransactionsPerHour: number;
  maxTransactionsPerDay: number;
  alertThresholds: AlertThreshold[];
}

export interface AlertThreshold {
  type: 'balance_low' | 'high_spending' | 'unusual_activity' | 'failed_tx_spike';
  value: number;
  action: 'log' | 'alert' | 'pause' | 'stop';
}

export interface SecurityViolation {
  id: string;
  timestamp: number;
  agentId: string;
  rule: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: Record<string, unknown>;
  blocked: boolean;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  violation?: SecurityViolation;
}

export interface TransactionValidationParams {
  amountSol: number;
  programId?: string;
  destination?: string;
  type?: TransactionType;
}

export interface SpendingWindow {
  amount: number;
  transactions: number;
  windowStart: number;
}

// ─── Audit Types ─────────────────────────────────────────────────────────────

export type AuditLevel = 'info' | 'warning' | 'critical' | 'security';
export type AuditCategory =
  | 'wallet_operation'
  | 'transaction'
  | 'security_event'
  | 'agent_decision'
  | 'system_event'
  | 'policy_violation';

export interface AuditEntry {
  id: string;
  timestamp: number;
  level: AuditLevel;
  category: AuditCategory;
  agentId: string;
  walletId: string;
  action: string;
  details: Record<string, unknown>;
  transactionSignature?: string;
  riskScore: number;
}

export interface AuditQueryFilters {
  agentId?: string;
  walletId?: string;
  category?: AuditCategory;
  level?: AuditLevel;
  since?: number;
  limit?: number;
}

export interface RiskSummary {
  averageRiskScore: number;
  highRiskCount: number;
  totalEntries: number;
  topRisksByAction: { action: string; avgRisk: number; count: number }[];
}

// ─── Orchestrator & Dashboard Types ──────────────────────────────────────────

export interface OrchestratorConfig {
  maxAgents: number;
  healthCheckIntervalMs: number;
  metricsIntervalMs: number;
  autoRestart: boolean;
  dashboardPort: number;
  websocketPort: number;
}

export interface SystemMetrics {
  totalAgents: number;
  activeAgents: number;
  totalWallets: number;
  totalTransactions: number;
  totalVolumeSol: number;
  uptimeSeconds: number;
  averageTps: number;
  memoryUsageMb: number;
}

export interface DashboardState {
  agents: AgentState[];
  systemMetrics: SystemMetrics;
  recentTransactions: TransactionRecord[];
  recentAuditEntries: AuditEntry[];
  alerts: AlertEntry[];
}

export interface AlertEntry {
  id: string;
  timestamp: number;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  agentId?: string;
  acknowledged: boolean;
}

export interface HealthCheck {
  agentId: string;
  timestamp: number;
  status: AgentStatus;
  healthy: boolean;
  details: Record<string, unknown>;
}

export interface CreateAgentParams {
  name: string;
  type: AgentType;
  strategy: StrategyConfig;
  password: string;
  cluster?: SolanaCluster;
  rpcEndpoint?: string;
  securityPolicy?: Partial<SecurityPolicy>;
}

// ─── Event Types ─────────────────────────────────────────────────────────────

// ─── Integration Types ──────────────────────────────────────────────────────

export interface PriceData {
  price: number;
  source: 'pyth' | 'jupiter' | 'coingecko' | 'simulated' | 'cache';
  timestamp: number;
  confidence?: number;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label: string } }[];
  otherAmountThreshold: string;
}

// ─── AMM Pool Types ─────────────────────────────────────────────────────────

export interface PoolState {
  authority: string;
  tokenMint: string;
  poolTokenAccount: string;
  solReserve: number;
  tokenReserve: number;
  feeBps: number;
  bump: number;
}

// ─── Event Types ─────────────────────────────────────────────────────────────

export type SentinelVaultEvent =
  | 'wallet:created'
  | 'wallet:funded'
  | 'wallet:locked'
  | 'wallet:unlocked'
  | 'transaction:submitted'
  | 'transaction:confirmed'
  | 'transaction:failed'
  | 'agent:started'
  | 'agent:stopped'
  | 'agent:decision'
  | 'agent:action'
  | 'agent:error'
  | 'security:alert'
  | 'security:violation'
  | 'security:limit_reached'
  | 'system:error'
  | 'system:info';
