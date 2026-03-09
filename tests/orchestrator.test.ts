import { AgentOrchestrator } from '../src/agents/orchestrator';
import type { OrchestratorConfig, CreateAgentParams } from '../src/types';

// ── Mock: AgenticWallet ─────────────────────────────────────────────────────

jest.mock('../src/core/wallet', () => ({
  AgenticWallet: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    getBalance: jest.fn().mockResolvedValue(1.0),
    getState: jest.fn().mockReturnValue({
      id: 'mock-wallet-id',
      label: 'Mock Wallet',
      publicKey: 'MockPubKey1111111111111111111111111111111111',
      cluster: 'devnet',
      balanceSol: 1.0,
      tokenBalances: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      transactionCount: 0,
      status: 'active',
    }),
    requestAirdrop: jest.fn().mockResolvedValue('mock-sig'),
    setPolicyEngine: jest.fn(),
    getPolicyEngine: jest.fn().mockReturnValue(null),
    on: jest.fn(),
    emit: jest.fn(),
  })),
}));

// ── Mock: TradingAgent ──────────────────────────────────────────────────────

const mockTradingStop = jest.fn();

jest.mock('../src/agents/trading-agent', () => ({
  TradingAgent: jest.fn().mockImplementation((config: any) => ({
    getId: jest.fn().mockReturnValue(config.id),
    getName: jest.fn().mockReturnValue(config.name),
    getType: jest.fn().mockReturnValue(config.type),
    getStatus: jest.fn().mockReturnValue('idle'),
    start: jest.fn(),
    stop: mockTradingStop,
    pause: jest.fn(),
    resume: jest.fn(),
    getState: jest.fn().mockReturnValue({
      id: config.id,
      name: config.name,
      type: config.type,
      status: 'idle',
      wallet: {
        id: 'mock-wallet-id',
        label: 'Mock Wallet',
        publicKey: 'MockPubKey1111111111111111111111111111111111',
        cluster: 'devnet',
        balanceSol: 1.0,
        tokenBalances: [],
        createdAt: Date.now(),
        lastActivity: Date.now(),
        transactionCount: 0,
        status: 'active',
      },
      performance: {
        totalTransactions: 0,
        successfulTransactions: 0,
        failedTransactions: 0,
        totalVolumeSol: 0,
        totalFeePaid: 0,
        profitLoss: 0,
        winRate: 0,
        averageExecutionTime: 0,
      },
      currentStrategy: config.strategy.name,
      activeActions: [],
      lastDecision: null,
      uptime: 0,
      startedAt: 0,
    }),
    getPerformance: jest.fn().mockReturnValue({
      totalTransactions: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      totalVolumeSol: 0,
      totalFeePaid: 0,
      profitLoss: 0,
      winRate: 0,
      averageExecutionTime: 0,
    }),
    setPolicyEngine: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  })),
}));

// ── Mock: LiquidityAgent ────────────────────────────────────────────────────

const mockLiquidityStop = jest.fn();

jest.mock('../src/agents/liquidity-agent', () => ({
  LiquidityAgent: jest.fn().mockImplementation((config: any) => ({
    getId: jest.fn().mockReturnValue(config.id),
    getName: jest.fn().mockReturnValue(config.name),
    getType: jest.fn().mockReturnValue(config.type),
    getStatus: jest.fn().mockReturnValue('idle'),
    start: jest.fn(),
    stop: mockLiquidityStop,
    pause: jest.fn(),
    resume: jest.fn(),
    getState: jest.fn().mockReturnValue({
      id: config.id,
      name: config.name,
      type: config.type,
      status: 'idle',
      wallet: {
        id: 'mock-wallet-id',
        label: 'Mock Wallet',
        publicKey: 'MockPubKey1111111111111111111111111111111111',
        cluster: 'devnet',
        balanceSol: 1.0,
        tokenBalances: [],
        createdAt: Date.now(),
        lastActivity: Date.now(),
        transactionCount: 0,
        status: 'active',
      },
      performance: {
        totalTransactions: 0,
        successfulTransactions: 0,
        failedTransactions: 0,
        totalVolumeSol: 0,
        totalFeePaid: 0,
        profitLoss: 0,
        winRate: 0,
        averageExecutionTime: 0,
      },
      currentStrategy: config.strategy.name,
      activeActions: [],
      lastDecision: null,
      uptime: 0,
      startedAt: 0,
    }),
    getPerformance: jest.fn().mockReturnValue({
      totalTransactions: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      totalVolumeSol: 0,
      totalFeePaid: 0,
      profitLoss: 0,
      winRate: 0,
      averageExecutionTime: 0,
    }),
    setPolicyEngine: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  })),
}));

// ── Mock: PolicyEngine ──────────────────────────────────────────────────────

jest.mock('../src/security/policy-engine', () => ({
  PolicyEngine: jest.fn().mockImplementation(() => ({
    validateTransaction: jest.fn().mockReturnValue({ allowed: true }),
    recordTransaction: jest.fn(),
    recordFailure: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  })),
  // Attach createDefaultPolicy as a static method on the mock constructor
  ...((): Record<string, unknown> => {
    const ctor = jest.fn().mockImplementation(() => ({
      validateTransaction: jest.fn().mockReturnValue({ allowed: true }),
      recordTransaction: jest.fn(),
      recordFailure: jest.fn(),
      on: jest.fn(),
      emit: jest.fn(),
    }));
    (ctor as any).createDefaultPolicy = jest.fn().mockReturnValue({
      spendingLimits: {
        perTransaction: 1,
        hourly: 5,
        daily: 20,
        weekly: 100,
        monthly: 500,
      },
      allowedPrograms: ['11111111111111111111111111111111'],
      blockedAddresses: [],
      requireSimulation: true,
      maxTransactionsPerMinute: 10,
      maxTransactionsPerHour: 60,
      maxTransactionsPerDay: 500,
      alertThresholds: [],
    });
    return { PolicyEngine: ctor };
  })(),
}));

// ── Mock: AuditLogger ───────────────────────────────────────────────────────

const mockAuditClose = jest.fn();

jest.mock('../src/security/audit-logger', () => ({
  AuditLogger: jest.fn().mockImplementation(() => ({
    logWalletOperation: jest.fn(),
    logTransaction: jest.fn(),
    logSecurityEvent: jest.fn(),
    logAgentDecision: jest.fn(),
    logSystemEvent: jest.fn(),
    getRecentEntries: jest.fn().mockReturnValue([]),
    getRiskSummary: jest.fn().mockReturnValue({
      averageRiskScore: 0,
      highRiskCount: 0,
      totalEntries: 0,
      topRisksByAction: [],
    }),
    query: jest.fn().mockReturnValue([]),
    close: mockAuditClose,
  })),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeOrchestratorConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    maxAgents: 5,
    healthCheckIntervalMs: 60_000,
    metricsIntervalMs: 60_000,
    autoRestart: false,
    dashboardPort: 0,
    websocketPort: 0,
    ...overrides,
  };
}

function makeCreateAgentParams(overrides: Partial<CreateAgentParams> = {}): CreateAgentParams {
  return {
    name: 'Test Agent',
    type: 'trader',
    password: 'test-password',
    cluster: 'devnet',
    strategy: {
      name: 'dca',
      type: 'dca',
      params: {},
      riskLevel: 'conservative',
      maxPositionSize: 1,
      cooldownMs: 30_000,
    },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;

  afterEach(async () => {
    await orchestrator.shutdown();
    jest.clearAllMocks();
  });

  test('createAgent creates an agent and returns a valid ID string', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams());

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('createAgent with trader type creates a TradingAgent', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams({ type: 'trader' }));

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('createAgent with liquidity_provider type creates a LiquidityAgent', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(
      makeCreateAgentParams({ type: 'liquidity_provider', name: 'LP Agent' }),
    );

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('cannot exceed maxAgents limit', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig({ maxAgents: 2 }));

    await orchestrator.createAgent(makeCreateAgentParams({ name: 'Agent 1' }));
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'Agent 2' }));

    await expect(
      orchestrator.createAgent(makeCreateAgentParams({ name: 'Agent 3' })),
    ).rejects.toThrow();
  });

  test('removeAgent removes the agent and getAgentCount decreases', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams());

    expect(orchestrator.getAgentCount()).toBe(1);

    await orchestrator.removeAgent(id);

    expect(orchestrator.getAgentCount()).toBe(0);
  });

  test('getSystemMetrics returns correct totalAgents count', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());

    await orchestrator.createAgent(makeCreateAgentParams({ name: 'Agent A' }));
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'Agent B' }));

    const metrics = orchestrator.getSystemMetrics();

    expect(metrics.totalAgents).toBe(2);
  });

  test('getAgentStates returns array of agent states', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());

    await orchestrator.createAgent(makeCreateAgentParams({ name: 'Agent X' }));

    const states = orchestrator.getAgentStates();

    expect(Array.isArray(states)).toBe(true);
    expect(states.length).toBe(1);
    expect(states[0]).toHaveProperty('id');
    expect(states[0]).toHaveProperty('status');
  });

  test('shutdown stops all agents and closes the audit logger', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());

    await orchestrator.createAgent(makeCreateAgentParams({ name: 'Trader 1' }));
    await orchestrator.createAgent(
      makeCreateAgentParams({ name: 'LP 1', type: 'liquidity_provider' }),
    );

    await orchestrator.shutdown();

    expect(mockTradingStop).toHaveBeenCalled();
    expect(mockLiquidityStop).toHaveBeenCalled();
    expect(mockAuditClose).toHaveBeenCalled();
  });
});
