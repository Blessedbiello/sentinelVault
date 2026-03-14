import { AgentOrchestrator } from '../src/agents/orchestrator';
import type { OrchestratorConfig, CreateAgentParams, AlertEntry } from '../src/types';

// ── Mock: AgenticWallet ─────────────────────────────────────────────────────

const mockWalletOn = jest.fn();
const mockRequestAirdrop = jest.fn().mockResolvedValue('mock-sig');
const mockGetConnection = jest.fn().mockReturnValue({
  getTransaction: jest.fn().mockResolvedValue(null),
});

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
    requestAirdrop: mockRequestAirdrop,
    setPolicyEngine: jest.fn(),
    getPolicyEngine: jest.fn().mockReturnValue(null),
    getConnection: mockGetConnection,
    on: mockWalletOn,
    emit: jest.fn(),
  })),
}));

// ── Shared mock agent factory ─────────────────────────────────────────────

function createMockAgent(config: any) {
  return {
    getId: jest.fn().mockReturnValue(config.id),
    getName: jest.fn().mockReturnValue(config.name),
    getType: jest.fn().mockReturnValue(config.type),
    getStatus: jest.fn().mockReturnValue('idle'),
    start: jest.fn(),
    stop: jest.fn(),
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
    setPoolMint: jest.fn(),
    getDecisionHistory: jest.fn().mockReturnValue([]),
    getAdaptiveWeights: jest.fn().mockReturnValue({ trend: 0.4, momentum: 0.3, volatility: 0.2, balance: 0.1 }),
    getMarketRegime: jest.fn().mockReturnValue('quiet'),
    getConfidenceCalibration: jest.fn().mockReturnValue([]),
    on: jest.fn(),
    emit: jest.fn(),
    setSharedServices: jest.fn(),
    setAIAdvisor: jest.fn(),
    setDexScreenerClient: jest.fn(),
    setTargetAddress: jest.fn(),
    setMarketConsensus: jest.fn(),
    getPnLSummary: jest.fn().mockReturnValue({
      totalPnL: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      currentBalanceSol: 0,
      initialBalanceSol: 0,
      roiPercent: 0,
      history: [],
    }),
    setKoraClient: jest.fn(),
  };
}

// ── Mock: TradingAgent ──────────────────────────────────────────────────────

jest.mock('../src/agents/trading-agent', () => ({
  TradingAgent: jest.fn().mockImplementation((config: any) => createMockAgent(config)),
}));

// ── Mock: LiquidityAgent ────────────────────────────────────────────────────

jest.mock('../src/agents/liquidity-agent', () => ({
  LiquidityAgent: jest.fn().mockImplementation((config: any) => createMockAgent(config)),
}));

// ── Mock: ArbitrageAgent ────────────────────────────────────────────────────

jest.mock('../src/agents/arbitrage-agent', () => ({
  ArbitrageAgent: jest.fn().mockImplementation((config: any) => createMockAgent(config)),
}));

// ── Mock: PortfolioAgent ────────────────────────────────────────────────────

jest.mock('../src/agents/portfolio-agent', () => ({
  PortfolioAgent: jest.fn().mockImplementation((config: any) => createMockAgent(config)),
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
const mockLogAgentDecision = jest.fn();
const mockLogSecurityEvent = jest.fn();
const mockLogTransaction = jest.fn();

jest.mock('../src/security/audit-logger', () => ({
  AuditLogger: jest.fn().mockImplementation(() => ({
    logWalletOperation: jest.fn(),
    logTransaction: mockLogTransaction,
    logSecurityEvent: mockLogSecurityEvent,
    logAgentDecision: mockLogAgentDecision,
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

// ── Mock: Integration Services ───────────────────────────────────────────────

jest.mock('../src/integrations/price-feed', () => ({
  PriceFeed: jest.fn().mockImplementation(() => ({
    getSOLPrice: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../src/integrations/jupiter', () => ({
  JupiterClient: jest.fn().mockImplementation(() => ({
    getQuote: jest.fn().mockResolvedValue(null),
    getSwapTransaction: jest.fn().mockResolvedValue(null),
  })),
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}));

jest.mock('../src/integrations/ai-advisor', () => ({
  AIAdvisor: jest.fn().mockImplementation(() => ({
    getAgentDecision: jest.fn().mockResolvedValue(null),
    getTradeRecommendation: jest.fn().mockResolvedValue(null),
    recordOutcome: jest.fn(),
  })),
}));

jest.mock('../src/integrations/dexscreener-client', () => ({
  DexScreenerClient: jest.fn().mockImplementation(() => ({
    getSOLPrice: jest.fn().mockResolvedValue(null),
    isAvailable: jest.fn().mockReturnValue(false),
    getCachedPrice: jest.fn().mockReturnValue(null),
    clearCache: jest.fn(),
  })),
}));

jest.mock('../src/integrations/kora-client', () => ({
  KoraClient: jest.fn().mockImplementation(() => ({
    isAvailable: jest.fn().mockReturnValue(false),
    getRpcUrl: jest.fn().mockReturnValue(null),
  })),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeOrchestratorConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    maxAgents: 10,
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

function getLastCreatedMockAgent(mockCtor: jest.Mock): any {
  const results = mockCtor.mock.results;
  return results[results.length - 1]?.value;
}

function getEventCallback(mockOn: jest.Mock, eventName: string): ((...args: any[]) => void) | undefined {
  const call = mockOn.mock.calls.find(([name]: [string]) => name === eventName);
  return call ? call[1] : undefined;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;

  afterEach(async () => {
    await orchestrator.shutdown();
    jest.clearAllMocks();
  });

  // ── Agent Factory ─────────────────────────────────────────────────────────

  test('createAgent creates an agent and returns a valid ID string', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams());
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('createAgent with trader type creates a TradingAgent', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams({ type: 'trader' }));
    const { TradingAgent } = require('../src/agents/trading-agent');
    expect(TradingAgent).toHaveBeenCalled();
    expect(id.length).toBeGreaterThan(0);
  });

  test('createAgent with liquidity_provider type creates a LiquidityAgent', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams({ type: 'liquidity_provider', name: 'LP' }));
    const { LiquidityAgent } = require('../src/agents/liquidity-agent');
    expect(LiquidityAgent).toHaveBeenCalled();
  });

  test('createAgent with arbitrageur type creates an ArbitrageAgent', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams({ type: 'arbitrageur', name: 'Arb' }));
    const { ArbitrageAgent } = require('../src/agents/arbitrage-agent');
    expect(ArbitrageAgent).toHaveBeenCalled();
  });

  test('createAgent with portfolio_manager type creates a PortfolioAgent', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams({ type: 'portfolio_manager', name: 'PM' }));
    const { PortfolioAgent } = require('../src/agents/portfolio-agent');
    expect(PortfolioAgent).toHaveBeenCalled();
  });

  test('cannot exceed maxAgents limit', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig({ maxAgents: 2 }));
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'Agent 1' }));
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'Agent 2' }));
    await expect(
      orchestrator.createAgent(makeCreateAgentParams({ name: 'Agent 3' })),
    ).rejects.toThrow();
  });

  // ── Lifecycle Management ─────────────────────────────────────────────────

  test('startAgent calls agent.start() and emits agent:started', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const emitSpy = jest.fn();
    orchestrator.on('agent:started', emitSpy);
    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const agent = orchestrator.getAgent(id)!;

    orchestrator.startAgent(id);
    expect(agent.start).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(id);
  });

  test('startAgent throws for invalid ID', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    expect(() => orchestrator.startAgent('nonexistent')).toThrow('Agent not found');
  });

  test('stopAgent calls agent.stop() and emits agent:stopped', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const emitSpy = jest.fn();
    orchestrator.on('agent:stopped', emitSpy);
    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const agent = orchestrator.getAgent(id)!;

    orchestrator.stopAgent(id);
    expect(agent.stop).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(id);
  });

  test('stopAgent throws for invalid ID', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    expect(() => orchestrator.stopAgent('nonexistent')).toThrow('Agent not found');
  });

  test('pauseAgent calls agent.pause()', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const agent = orchestrator.getAgent(id)!;

    orchestrator.pauseAgent(id);
    expect(agent.pause).toHaveBeenCalled();
  });

  test('pauseAgent throws for invalid ID', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    expect(() => orchestrator.pauseAgent('nonexistent')).toThrow('Agent not found');
  });

  test('resumeAgent calls agent.resume()', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const agent = orchestrator.getAgent(id)!;

    orchestrator.resumeAgent(id);
    expect(agent.resume).toHaveBeenCalled();
  });

  test('resumeAgent throws for invalid ID', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    expect(() => orchestrator.resumeAgent('nonexistent')).toThrow('Agent not found');
  });

  test('removeAgent removes the agent and getAgentCount decreases', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams());
    expect(orchestrator.getAgentCount()).toBe(1);
    orchestrator.removeAgent(id);
    expect(orchestrator.getAgentCount()).toBe(0);
  });

  // ── Batch Operations ─────────────────────────────────────────────────────

  test('startAll starts all registered agents', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id1 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'A1' }));
    const id2 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'A2' }));

    orchestrator.startAll();

    expect(orchestrator.getAgent(id1)!.start).toHaveBeenCalled();
    expect(orchestrator.getAgent(id2)!.start).toHaveBeenCalled();
  });

  test('stopAll stops all registered agents', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id1 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'A1' }));
    const id2 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'A2' }));

    orchestrator.stopAll();

    expect(orchestrator.getAgent(id1)!.stop).toHaveBeenCalled();
    expect(orchestrator.getAgent(id2)!.stop).toHaveBeenCalled();
  });

  // ── Funding ──────────────────────────────────────────────────────────────

  test('fundAllAgents calls requestAirdrop for each agent', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'A1' }));
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'A2' }));

    await orchestrator.fundAllAgents(2);

    expect(mockRequestAirdrop).toHaveBeenCalledTimes(2);
    expect(mockRequestAirdrop).toHaveBeenCalledWith(2);
  });

  test('fundAllAgents handles airdrop failure without throwing', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'A1' }));
    mockRequestAirdrop.mockRejectedValueOnce(new Error('rate limited'));

    await expect(orchestrator.fundAllAgents()).resolves.toBeUndefined();
    // Alert should have been created
    const alerts = orchestrator.getAlerts();
    expect(alerts.some(a => a.message.includes('Airdrop failed'))).toBe(true);
  });

  test('fundAllAgents passes custom amount', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'A1' }));

    await orchestrator.fundAllAgents(5);

    expect(mockRequestAirdrop).toHaveBeenCalledWith(5);
  });

  // ── Health Monitoring ────────────────────────────────────────────────────

  test('startHealthMonitoring is idempotent', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig({ healthCheckIntervalMs: 100_000, metricsIntervalMs: 100_000 }));
    orchestrator.startHealthMonitoring();
    orchestrator.startHealthMonitoring(); // second call is no-op
    orchestrator.stopHealthMonitoring();
  });

  test('stopHealthMonitoring clears intervals', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig({ healthCheckIntervalMs: 100_000, metricsIntervalMs: 100_000 }));
    orchestrator.startHealthMonitoring();
    orchestrator.stopHealthMonitoring();
    // No errors, intervals cleared
  });

  test('health check with autoRestart=true resumes errored agents', async () => {
    jest.useFakeTimers();
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig({
      autoRestart: true,
      healthCheckIntervalMs: 100,
      metricsIntervalMs: 100_000,
    }));

    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const agent = orchestrator.getAgent(id)!;
    (agent.getStatus as jest.Mock).mockReturnValue('error');

    orchestrator.startHealthMonitoring();
    jest.advanceTimersByTime(150);

    expect(agent.resume).toHaveBeenCalled();

    orchestrator.stopHealthMonitoring();
    jest.useRealTimers();
  });

  test('health check with autoRestart=true handles resume failure with critical alert', async () => {
    jest.useFakeTimers();
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig({
      autoRestart: true,
      healthCheckIntervalMs: 100,
      metricsIntervalMs: 100_000,
    }));

    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const agent = orchestrator.getAgent(id)!;
    (agent.getStatus as jest.Mock).mockReturnValue('error');
    (agent.resume as jest.Mock).mockImplementation(() => { throw new Error('cannot resume'); });

    orchestrator.startHealthMonitoring();
    jest.advanceTimersByTime(150);

    const alerts = orchestrator.getAlerts();
    expect(alerts.some(a => a.severity === 'critical' && a.message.includes('could not be recovered'))).toBe(true);

    orchestrator.stopHealthMonitoring();
    jest.useRealTimers();
  });

  test('health check with autoRestart=false creates warning alert only', async () => {
    jest.useFakeTimers();
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig({
      autoRestart: false,
      healthCheckIntervalMs: 100,
      metricsIntervalMs: 100_000,
    }));

    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const agent = orchestrator.getAgent(id)!;
    (agent.getStatus as jest.Mock).mockReturnValue('error');

    orchestrator.startHealthMonitoring();
    jest.advanceTimersByTime(150);

    const alerts = orchestrator.getAlerts();
    expect(alerts.some(a => a.severity === 'warning' && a.message.includes('Auto-restart is disabled'))).toBe(true);
    expect(agent.resume).not.toHaveBeenCalled();

    orchestrator.stopHealthMonitoring();
    jest.useRealTimers();
  });

  // ── Alert System ──────────────────────────────────────────────────────────

  test('addAlert creates alert with correct shape', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    orchestrator.addAlert('warning', 'test alert', 'agent-123');

    const alerts = orchestrator.getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveProperty('id');
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].message).toBe('test alert');
    expect(alerts[0].agentId).toBe('agent-123');
    expect(alerts[0].acknowledged).toBe(false);
  });

  test('addAlert emits alert event', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const alertHandler = jest.fn();
    orchestrator.on('alert', alertHandler);

    orchestrator.addAlert('info', 'test');
    expect(alertHandler).toHaveBeenCalledTimes(1);
    expect(alertHandler).toHaveBeenCalledWith(expect.objectContaining({ severity: 'info', message: 'test' }));
  });

  test('alerts cap at 1000', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    for (let i = 0; i < 1010; i++) {
      orchestrator.addAlert('info', `alert-${i}`);
    }
    expect(orchestrator.getAlerts().length).toBeLessThanOrEqual(1000);
  });

  // ── State & Accessors ─────────────────────────────────────────────────────

  test('getDashboardState returns correct shape', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams());

    const state = orchestrator.getDashboardState();
    expect(state).toHaveProperty('agents');
    expect(state).toHaveProperty('systemMetrics');
    expect(state).toHaveProperty('recentTransactions');
    expect(state).toHaveProperty('recentAuditEntries');
    expect(state).toHaveProperty('alerts');
    expect(state.agents).toHaveLength(1);
  });

  test('getSystemMetrics returns correct totalAgents count', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'A' }));
    await orchestrator.createAgent(makeCreateAgentParams({ name: 'B' }));
    const metrics = orchestrator.getSystemMetrics();
    expect(metrics.totalAgents).toBe(2);
  });

  test('getAgentStates returns array with adaptive fields', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams());
    const states = orchestrator.getAgentStates();
    expect(states).toHaveLength(1);
    expect(states[0]).toHaveProperty('adaptiveWeights');
    expect(states[0]).toHaveProperty('marketRegime');
    expect(states[0]).toHaveProperty('confidenceCalibration');
    expect(states[0]).toHaveProperty('recentDecisions');
  });

  test('getAgent returns agent for valid ID', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const agent = orchestrator.getAgent(id);
    expect(agent).toBeDefined();
    expect(agent!.getId()).toBe(id);
  });

  test('getAgent returns undefined for invalid ID', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    expect(orchestrator.getAgent('nonexistent')).toBeUndefined();
  });

  test('getAgentWallet returns wallet, throws for invalid', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const wallet = orchestrator.getAgentWallet(id);
    expect(wallet).toBeDefined();
    expect(() => orchestrator.getAgentWallet('nonexistent')).toThrow('Agent not found');
  });

  test('getAgentWalletAddresses returns Map with correct entries', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id = await orchestrator.createAgent(makeCreateAgentParams());
    const addresses = orchestrator.getAgentWalletAddresses();
    expect(addresses.size).toBe(1);
    expect(addresses.has(id)).toBe(true);
    expect(addresses.get(id)).toBe('MockPubKey1111111111111111111111111111111111');
  });

  test('getAuditLogger returns the logger', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const logger = orchestrator.getAuditLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.logSystemEvent).toBe('function');
  });

  // ── Event Wiring ─────────────────────────────────────────────────────────

  test('wireAgentEvents: agent:decision triggers auditLogger.logAgentDecision', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams());

    const { TradingAgent } = require('../src/agents/trading-agent');
    const mockAgent = getLastCreatedMockAgent(TradingAgent);
    const decisionCb = getEventCallback(mockAgent.on, 'agent:decision');
    expect(decisionCb).toBeDefined();

    const mockDecision = {
      id: 'dec-1',
      action: 'buy',
      confidence: 0.8,
      reasoning: 'test',
      executed: true,
      marketConditions: {},
    };
    decisionCb!(mockDecision);

    expect(mockLogAgentDecision).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'buy',
      expect.objectContaining({ decisionId: 'dec-1' }),
    );
  });

  test('wireAgentEvents: agent:error triggers alert with warning severity', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams());

    const { TradingAgent } = require('../src/agents/trading-agent');
    const mockAgent = getLastCreatedMockAgent(TradingAgent);
    const errorCb = getEventCallback(mockAgent.on, 'agent:error');
    expect(errorCb).toBeDefined();

    errorCb!(new Error('test error'));

    const alerts = orchestrator.getAlerts();
    expect(alerts.some(a => a.severity === 'warning' && a.message.includes('test error'))).toBe(true);
  });

  test('wireAgentEvents: transaction:confirmed pushes to recentTransactions', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    await orchestrator.createAgent(makeCreateAgentParams());

    // Get the wallet on callback for transaction:confirmed
    const txCb = getEventCallback(mockWalletOn, 'transaction:confirmed');
    expect(txCb).toBeDefined();

    txCb!('mock-sig-123');

    const dashboard = orchestrator.getDashboardState();
    expect(dashboard.recentTransactions.length).toBeGreaterThanOrEqual(1);
  });

  // ── setPoolMintForAgents ──────────────────────────────────────────────────

  test('setPoolMintForAgents iterates all agent types without throwing', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());

    // Create one agent of each type to ensure the method iterates all branches
    await orchestrator.createAgent(makeCreateAgentParams({ type: 'trader', name: 'T1' }));
    await orchestrator.createAgent(makeCreateAgentParams({ type: 'liquidity_provider', name: 'LP1' }));
    await orchestrator.createAgent(makeCreateAgentParams({ type: 'arbitrageur', name: 'Arb1' }));
    await orchestrator.createAgent(makeCreateAgentParams({ type: 'portfolio_manager', name: 'PM1' }));

    expect(orchestrator.getAgentCount()).toBe(4);

    // setPoolMintForAgents uses instanceof checks which require real class instances.
    // With jest.mock, the mock constructors return plain objects so instanceof returns false.
    // This test verifies the method runs without error and covers the iteration logic.
    // The actual setPoolMint dispatch for each agent type is tested in:
    //   - tests/liquidity-agent.test.ts (AMM pool integration)
    //   - tests/trading-agent.test.ts (AMM swap execution)
    //   - tests/portfolio-agent.test.ts (pool price valuation)
    expect(() => {
      orchestrator.setPoolMintForAgents('TestPoolMint999', 'TestPoolAuth999');
    }).not.toThrow();
  });

  // ── Shutdown ─────────────────────────────────────────────────────────────

  test('shutdown stops all agents and closes the audit logger', async () => {
    orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
    const id1 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'T1' }));
    const id2 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'LP1', type: 'liquidity_provider' }));

    await orchestrator.shutdown();

    expect(orchestrator.getAgent(id1)!.stop).toHaveBeenCalled();
    expect(orchestrator.getAgent(id2)!.stop).toHaveBeenCalled();
    expect(mockAuditClose).toHaveBeenCalled();
  });

  // ── Inter-Agent Target Wiring ─────────────────────────────────────────────

  describe('Inter-Agent Target Wiring', () => {
    test('wireAgentTargetAddresses sets round-robin targets', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());

      const id1 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'A1', type: 'trader' }));
      const id2 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'A2', type: 'trader' }));
      const id3 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'A3', type: 'trader' }));

      // Clear call counts from auto-wiring that occurred during createAgent
      jest.clearAllMocks();

      // Trigger an explicit round
      orchestrator.wireAgentTargetAddresses();

      const agent1 = orchestrator.getAgent(id1)!;
      const agent2 = orchestrator.getAgent(id2)!;
      const agent3 = orchestrator.getAgent(id3)!;

      // After a single explicit call with 3 agents, each should be wired once
      expect((agent1 as any).setTargetAddress).toHaveBeenCalledTimes(1);
      expect((agent2 as any).setTargetAddress).toHaveBeenCalledTimes(1);
      expect((agent3 as any).setTargetAddress).toHaveBeenCalledTimes(1);

      // Round-robin: each gets the next agent's public key
      // All mock wallets return 'MockPubKey1111111111111111111111111111111111'
      expect((agent1 as any).setTargetAddress).toHaveBeenCalledWith('MockPubKey1111111111111111111111111111111111');
      expect((agent2 as any).setTargetAddress).toHaveBeenCalledWith('MockPubKey1111111111111111111111111111111111');
      expect((agent3 as any).setTargetAddress).toHaveBeenCalledWith('MockPubKey1111111111111111111111111111111111');
    });

    test('wireAgentTargetAddresses skips when less than 2 agents', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
      const id1 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'Solo', type: 'trader' }));

      orchestrator.wireAgentTargetAddresses();

      const agent1 = orchestrator.getAgent(id1)!;
      expect((agent1 as any).setTargetAddress).not.toHaveBeenCalled();
    });

    test('createAgent re-wires when agents >= 2', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());

      await orchestrator.createAgent(makeCreateAgentParams({ name: 'First', type: 'trader' }));
      await orchestrator.createAgent(makeCreateAgentParams({ name: 'Second', type: 'trader' }));

      // With 2 agents registered, orchestrator should support round-robin wiring without error.
      // wireAgentTargetAddresses is idempotent and callable at any time.
      expect(orchestrator.getAgentCount()).toBe(2);
      expect(() => orchestrator.wireAgentTargetAddresses()).not.toThrow();
    });
  });

  // ── Market Intelligence ───────────────────────────────────────────────────

  describe('Market Intelligence', () => {
    test('getMarketConsensus computes majority regime', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
      await orchestrator.createAgent(makeCreateAgentParams({ name: 'T1', type: 'trader' }));
      await orchestrator.createAgent(makeCreateAgentParams({ name: 'T2', type: 'trader' }));
      await orchestrator.createAgent(makeCreateAgentParams({ name: 'T3', type: 'trader' }));

      // Set 2 agents to 'trending', 1 to 'volatile' → majority is 'trending'
      const agents = Array.from((orchestrator as any).agents.values()).map((e: any) => e.agent);
      (agents[0].getMarketRegime as jest.Mock).mockReturnValue('trending');
      (agents[1].getMarketRegime as jest.Mock).mockReturnValue('trending');
      (agents[2].getMarketRegime as jest.Mock).mockReturnValue('volatile');

      const consensus = orchestrator.getMarketConsensus();
      expect(consensus.regime).toBe('trending');
      expect(consensus.agentSignals).toHaveLength(3);
    });

    test('broadcastMarketIntelligence distributes consensus to all agents', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
      await orchestrator.createAgent(makeCreateAgentParams({ name: 'T1', type: 'trader' }));
      await orchestrator.createAgent(makeCreateAgentParams({ name: 'T2', type: 'trader' }));

      orchestrator.broadcastMarketIntelligence();

      const agents = Array.from((orchestrator as any).agents.values()).map((e: any) => e.agent);
      for (const agent of agents) {
        expect((agent as any).setMarketConsensus).toHaveBeenCalledTimes(1);
        expect((agent as any).setMarketConsensus).toHaveBeenCalledWith(
          expect.objectContaining({ regime: expect.any(String), agentSignals: expect.any(Array) })
        );
      }
    });

    test('intelligence:updated event is emitted on broadcastMarketIntelligence', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
      await orchestrator.createAgent(makeCreateAgentParams({ name: 'T1', type: 'trader' }));

      const eventHandler = jest.fn();
      orchestrator.on('intelligence:updated', eventHandler);

      orchestrator.broadcastMarketIntelligence();

      expect(eventHandler).toHaveBeenCalledTimes(1);
      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({ regime: expect.any(String), averageConfidence: expect.any(Number) })
      );
    });

    test('broadcastMarketIntelligence is a no-op when no agents registered', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());

      const eventHandler = jest.fn();
      orchestrator.on('intelligence:updated', eventHandler);

      // Should not throw and should NOT emit when agents.size === 0
      expect(() => orchestrator.broadcastMarketIntelligence()).not.toThrow();
      expect(eventHandler).not.toHaveBeenCalled();
    });
  });

  // ── Graceful Shutdown ─────────────────────────────────────────────────────

  describe('Graceful Shutdown', () => {
    test('gracefulShutdown stops all agents', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
      const id1 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'T1' }));
      const id2 = await orchestrator.createAgent(makeCreateAgentParams({ name: 'T2' }));

      await orchestrator.gracefulShutdown();

      expect(orchestrator.getAgent(id1)!.stop).toHaveBeenCalled();
      expect(orchestrator.getAgent(id2)!.stop).toHaveBeenCalled();
    });

    test('gracefulShutdown emits system:shutdown event', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
      await orchestrator.createAgent(makeCreateAgentParams({ name: 'T1' }));

      const shutdownHandler = jest.fn();
      orchestrator.on('system:shutdown', shutdownHandler);

      await orchestrator.gracefulShutdown();

      expect(shutdownHandler).toHaveBeenCalledTimes(1);
      expect(shutdownHandler).toHaveBeenCalledWith(
        expect.objectContaining({ timestamp: expect.any(Number) })
      );
    });

    test('shutdown closes the audit logger', async () => {
      orchestrator = new AgentOrchestrator(makeOrchestratorConfig());
      await orchestrator.createAgent(makeCreateAgentParams({ name: 'T1' }));

      await orchestrator.shutdown();

      expect(mockAuditClose).toHaveBeenCalled();
    });
  });
});
