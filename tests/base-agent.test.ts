// SentinelVault — BaseAgent Tests
// Tests the abstract BaseAgent OODA loop, lifecycle management, event emission,
// performance tracking, and policy-engine integration using a concrete TestAgent.

import EventEmitter from 'eventemitter3';
import { BaseAgent } from '../src/agents/base-agent';
import type {
  AgentConfig,
  AgentDecision,
  AgentAction,
  WalletState,
} from '../src/types';

// ─── Mock AgenticWallet ───────────────────────────────────────────────────────
// The wallet must be a real EventEmitter so wireWalletEvents() can attach
// listeners. We mix eventemitter3 with jest.fn() stubs for the wallet API.

const MOCK_WALLET_STATE: WalletState = {
  id: 'w1',
  label: 'Test',
  publicKey: 'MockPubKey1111111111111111111111111111111111',
  cluster: 'devnet',
  balanceSol: 1.0,
  tokenBalances: [],
  createdAt: 0,
  lastActivity: 0,
  transactionCount: 0,
  status: 'active',
};

function createMockWallet() {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    getBalance: jest.fn().mockResolvedValue(1.0),
    transferSOL: jest.fn().mockResolvedValue(undefined),
    getState: jest.fn().mockReturnValue(MOCK_WALLET_STATE),
  });
}

type MockWallet = ReturnType<typeof createMockWallet>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockConfig: AgentConfig = {
  id: 'test-agent-1',
  name: 'TestAgent',
  type: 'trader',
  walletConfig: { id: 'w1', label: 'Test', password: 'pass', cluster: 'devnet' },
  strategy: {
    name: 'test',
    type: 'dca',
    params: {},
    riskLevel: 'moderate',
    maxPositionSize: 0.01,
    cooldownMs: 1000,
  },
  securityPolicy: {
    spendingLimits: { perTransaction: 1, hourly: 5, daily: 20, weekly: 100, monthly: 500 },
    allowedPrograms: ['11111111111111111111111111111111'],
    blockedAddresses: [],
    requireSimulation: false,
    maxTransactionsPerMinute: 10,
    maxTransactionsPerHour: 60,
    maxTransactionsPerDay: 500,
    alertThresholds: [],
  },
  enabled: true,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    id: 'decision-1',
    agentId: mockConfig.id,
    timestamp: Date.now(),
    marketConditions: { price: 100 },
    analysis: 'test analysis',
    action: 'buy',
    confidence: 0.8,
    reasoning: 'strong signal',
    executed: false,
    ...overrides,
  };
}

function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: 'action-1',
    agentId: mockConfig.id,
    timestamp: Date.now(),
    type: 'buy',
    details: { amountSol: 0.01 },
    ...overrides,
  };
}

// ─── TestAgent ────────────────────────────────────────────────────────────────
// Concrete subclass with controllable OODA step implementations. Each step is
// a jest.fn() whose implementation can be replaced per-test.

class TestAgent extends BaseAgent {
  observe   = jest.fn<Promise<Record<string, unknown>>, []>();
  analyze   = jest.fn<Promise<AgentDecision>, [Record<string, unknown>]>();
  execute   = jest.fn<Promise<AgentAction | null>, [AgentDecision]>();
  evaluate  = jest.fn<Promise<void>, [AgentAction | null, AgentDecision]>();

  constructor(config: AgentConfig, wallet: MockWallet) {
    // BaseAgent requires an AgenticWallet; we satisfy the type constraint with
    // a cast since our mock is structurally compatible for test purposes.
    super(config, wallet as any);
  }
}

// Expose runCycle for synchronous testing via a helper on TestAgent.
// runCycle is private on BaseAgent, so we call it via the prototype.
async function triggerCycle(agent: TestAgent): Promise<void> {
  // Access the private method through the prototype chain.
  await (agent as any).runCycle();
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('BaseAgent', () => {
  let wallet: MockWallet;
  let agent: TestAgent;

  beforeEach(() => {
    jest.useFakeTimers();
    wallet = createMockWallet();
    agent = new TestAgent(mockConfig, wallet);

    // Default OODA step implementations — override in individual tests as needed.
    agent.observe.mockResolvedValue({ price: 100 });
    agent.analyze.mockResolvedValue(makeDecision());
    agent.execute.mockResolvedValue(makeAction());
    agent.evaluate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    agent.stop();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // ── 1. OODA cycle: full happy path ─────────────────────────────────────────

  test('OODA cycle runs observe → analyze → execute → evaluate in order when confidence >= 0.5 and action != "hold"', async () => {
    const order: string[] = [];

    agent.observe.mockImplementation(async () => { order.push('observe'); return { price: 100 }; });
    agent.analyze.mockImplementation(async () => { order.push('analyze'); return makeDecision({ confidence: 0.8, action: 'buy' }); });
    agent.execute.mockImplementation(async () => { order.push('execute'); return makeAction(); });
    agent.evaluate.mockImplementation(async () => { order.push('evaluate'); });

    await triggerCycle(agent);

    expect(order).toEqual(['observe', 'analyze', 'execute', 'evaluate']);
  });

  // ── 2. Confidence gate — decision NOT executed when confidence < 0.5 ────────

  test('execute is NOT called when decision confidence is below the threshold (< 0.5)', async () => {
    agent.analyze.mockResolvedValue(makeDecision({ confidence: 0.3, action: 'buy' }));

    await triggerCycle(agent);

    expect(agent.execute).not.toHaveBeenCalled();
    // evaluate is still called (non-blocking path)
    expect(agent.evaluate).toHaveBeenCalledTimes(1);
  });

  // ── 3. Hold gate — action 'hold' not executed even with high confidence ─────

  test('execute is NOT called when decision action is "hold" even with confidence >= 0.5', async () => {
    agent.analyze.mockResolvedValue(makeDecision({ confidence: 0.9, action: 'hold' }));

    await triggerCycle(agent);

    expect(agent.execute).not.toHaveBeenCalled();
    expect(agent.evaluate).toHaveBeenCalledTimes(1);
  });

  // ── 4. Lifecycle: start sets status to idle, stop sets status to stopped ───

  test('start() sets status to "idle" and stop() transitions status to "stopped"', () => {
    agent.start();
    expect(agent.getStatus()).toBe('idle');

    agent.stop();
    expect(agent.getStatus()).toBe('stopped');
  });

  // ── 5. Lifecycle: pause and resume ─────────────────────────────────────────

  test('pause() sets status to "paused" and resume() restores it to "idle"', () => {
    agent.start();
    agent.pause();
    expect(agent.getStatus()).toBe('paused');

    agent.resume();
    expect(agent.getStatus()).toBe('idle');
  });

  // ── 6. Error recovery: observe throws → status "error", auto-recovery ──────

  test('error in observe() sets status to "error" and schedules auto-recovery after AUTO_RECOVERY_DELAY_MS', async () => {
    agent.observe.mockRejectedValue(new Error('RPC unavailable'));

    // Spy on resume to verify it is called after recovery delay.
    const resumeSpy = jest.spyOn(agent, 'resume');

    await triggerCycle(agent);

    expect(agent.getStatus()).toBe('error');
    expect(resumeSpy).not.toHaveBeenCalled();

    // Advance timers by the auto-recovery delay (5000 ms).
    jest.advanceTimersByTime(5000);

    // resume() should now have been called by the scheduled setTimeout.
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(agent.getStatus()).toBe('idle');
  });

  // ── 7. Decision history recorded and retrievable ───────────────────────────

  test('decisions are recorded in history and retrievable via getDecisionHistory()', async () => {
    const decision = makeDecision({ id: 'dec-42', action: 'sell', confidence: 0.75 });
    agent.analyze.mockResolvedValue(decision);

    await triggerCycle(agent);

    const history = agent.getDecisionHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe('dec-42');
    expect(history[0].action).toBe('sell');
  });

  test('multiple cycles accumulate decisions in order in getDecisionHistory()', async () => {
    const d1 = makeDecision({ id: 'dec-1', action: 'buy' });
    const d2 = makeDecision({ id: 'dec-2', action: 'sell' });

    agent.analyze
      .mockResolvedValueOnce(d1)
      .mockResolvedValueOnce(d2);

    await triggerCycle(agent);
    await triggerCycle(agent);

    const history = agent.getDecisionHistory();
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe('dec-1');
    expect(history[1].id).toBe('dec-2');
  });

  // ── 8. Performance: wallet 'transaction:confirmed' updates successfulTransactions

  test("wallet 'transaction:confirmed' events increment successfulTransactions and totalTransactions", () => {
    // Events are wired during construction; emit confirms to trigger counters.
    wallet.emit('transaction:confirmed', 'sig-1');
    wallet.emit('transaction:confirmed', 'sig-2');

    const perf = agent.getPerformance();
    expect(perf.successfulTransactions).toBe(2);
    expect(perf.totalTransactions).toBe(2);
    expect(perf.failedTransactions).toBe(0);
  });

  // ── 9. Performance: wallet 'transaction:failed' updates failedTransactions ──

  test("wallet 'transaction:failed' events increment failedTransactions and totalTransactions", () => {
    wallet.emit('transaction:failed', new Error('tx failed'));
    wallet.emit('transaction:failed', new Error('tx failed again'));

    const perf = agent.getPerformance();
    expect(perf.failedTransactions).toBe(2);
    expect(perf.totalTransactions).toBe(2);
    expect(perf.successfulTransactions).toBe(0);
  });

  // ── 10. Event emission: lifecycle events ───────────────────────────────────

  test('agent:started is emitted on start() and agent:stopped is emitted on stop()', () => {
    const startedHandler = jest.fn();
    const stoppedHandler = jest.fn();

    agent.on('agent:started', startedHandler);
    agent.on('agent:stopped', stoppedHandler);

    agent.start();
    expect(startedHandler).toHaveBeenCalledTimes(1);
    expect(startedHandler).toHaveBeenCalledWith(mockConfig.id);

    agent.stop();
    expect(stoppedHandler).toHaveBeenCalledTimes(1);
    expect(stoppedHandler).toHaveBeenCalledWith(mockConfig.id);
  });

  // ── 11. Event emission: decision and action events during a cycle ──────────

  test('agent:decision is emitted after each cycle and agent:action is emitted when an action is taken', async () => {
    const decisionHandler = jest.fn();
    const actionHandler   = jest.fn();

    agent.on('agent:decision', decisionHandler);
    agent.on('agent:action',   actionHandler);

    const decision = makeDecision({ confidence: 0.8, action: 'buy' });
    const action   = makeAction();
    agent.analyze.mockResolvedValue(decision);
    agent.execute.mockResolvedValue(action);

    await triggerCycle(agent);

    expect(decisionHandler).toHaveBeenCalledTimes(1);
    expect(decisionHandler).toHaveBeenCalledWith(expect.objectContaining({ id: decision.id }));

    expect(actionHandler).toHaveBeenCalledTimes(1);
    expect(actionHandler).toHaveBeenCalledWith(expect.objectContaining({ id: action.id }));
  });

  test('agent:action is NOT emitted when execute returns null', async () => {
    const actionHandler = jest.fn();
    agent.on('agent:action', actionHandler);

    agent.analyze.mockResolvedValue(makeDecision({ confidence: 0.8, action: 'buy' }));
    agent.execute.mockResolvedValue(null);

    await triggerCycle(agent);

    expect(actionHandler).not.toHaveBeenCalled();
  });

  // ── 12. setPolicyEngine: rejected transaction skips execute ────────────────

  test('execute is NOT called when the policy engine rejects the transaction', async () => {
    // Import PolicyEngine lazily so we can construct a real-ish mock without
    // jest.mock() hoisting (we want to avoid affecting other test files).
    const mockPolicyEngine = {
      validateTransaction: jest.fn().mockReturnValue({ allowed: false, reason: 'spending limit' }),
      recordTransaction: jest.fn(),
      recordFailure: jest.fn(),
      on: jest.fn(),
      emit: jest.fn(),
    };

    // Override estimateTransactionParams so the policy gate is entered.
    (agent as any).estimateTransactionParams = jest.fn().mockReturnValue({
      amountSol: 10,
      programId: '11111111111111111111111111111111',
    });

    agent.setPolicyEngine(mockPolicyEngine as any);

    agent.analyze.mockResolvedValue(makeDecision({ confidence: 0.9, action: 'buy' }));

    await triggerCycle(agent);

    expect(mockPolicyEngine.validateTransaction).toHaveBeenCalledTimes(1);
    expect(agent.execute).not.toHaveBeenCalled();
  });

  test('execute IS called when the policy engine allows the transaction', async () => {
    const mockPolicyEngine = {
      validateTransaction: jest.fn().mockReturnValue({ allowed: true }),
      recordTransaction: jest.fn(),
      recordFailure: jest.fn(),
      on: jest.fn(),
      emit: jest.fn(),
    };

    (agent as any).estimateTransactionParams = jest.fn().mockReturnValue({
      amountSol: 0.01,
      programId: '11111111111111111111111111111111',
    });

    agent.setPolicyEngine(mockPolicyEngine as any);

    agent.analyze.mockResolvedValue(makeDecision({ confidence: 0.9, action: 'buy' }));

    await triggerCycle(agent);

    expect(mockPolicyEngine.validateTransaction).toHaveBeenCalledTimes(1);
    expect(agent.execute).toHaveBeenCalledTimes(1);
  });

  // ── Supplemental: getState returns expected shape ──────────────────────────

  test('getState() returns a snapshot with correct id, name, type, and status', () => {
    agent.start();
    const state = agent.getState();

    expect(state.id).toBe(mockConfig.id);
    expect(state.name).toBe(mockConfig.name);
    expect(state.type).toBe(mockConfig.type);
    expect(state.status).toBe('idle');
    expect(state.lastDecision).toBeNull();
  });

  // ── Supplemental: error in observe does NOT call execute ───────────────────

  test('execute and evaluate are NOT called when observe() throws', async () => {
    agent.observe.mockRejectedValue(new Error('network error'));

    await triggerCycle(agent);

    expect(agent.execute).not.toHaveBeenCalled();
    expect(agent.evaluate).not.toHaveBeenCalled();
  });

  // ── Supplemental: agent:error emitted on observe failure ──────────────────

  test('agent:error is emitted with the error and agentId when observe() throws', async () => {
    const errorHandler = jest.fn();
    agent.on('agent:error', errorHandler);

    const boom = new Error('observe failure');
    agent.observe.mockRejectedValue(boom);

    await triggerCycle(agent);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(boom, mockConfig.id);
  });

  // ── 13. Adaptive Learning: detectRegime ───────────────────────────────────

  test('detectRegime returns "quiet" for a flat price history', () => {
    const prices = Array(20).fill(100);
    const regime = (agent as any).detectRegime(prices);
    expect(regime).toBe('quiet');
  });

  test('detectRegime returns "trending" for a steadily rising price history', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    const regime = (agent as any).detectRegime(prices);
    expect(regime).toBe('trending');
  });

  test('detectRegime returns "volatile" for wildly swinging prices', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 20 : -20));
    const regime = (agent as any).detectRegime(prices);
    expect(regime).toBe('volatile');
  });

  test('detectRegime returns "quiet" for fewer than 5 data points', () => {
    const regime = (agent as any).detectRegime([100, 101]);
    expect(regime).toBe('quiet');
  });

  // ── 14. Adaptive Learning: updateWeights ──────────────────────────────────

  test('updateWeights nudges weights on win and normalizes to sum=1', () => {
    const decision = makeDecision({
      marketConditions: { trendScore: 0.9, momentumScore: 0.5, volatilityScore: 0.5, balanceScore: 0.5 },
    });

    (agent as any).updateWeights('win', decision);

    const weights = agent.getAdaptiveWeights();
    const sum = weights.trend + weights.momentum + weights.volatility + weights.balance;
    expect(sum).toBeCloseTo(1.0, 5);
    // Trend was dominant (0.9 vs 0.5), so trend weight should increase
    expect(weights.trend).toBeGreaterThan(0.4);
  });

  test('updateWeights nudges weights on loss and normalizes to sum=1', () => {
    const decision = makeDecision({
      marketConditions: { trendScore: 0.9, momentumScore: 0.5, volatilityScore: 0.5, balanceScore: 0.5 },
    });

    (agent as any).updateWeights('loss', decision);

    const weights = agent.getAdaptiveWeights();
    const sum = weights.trend + weights.momentum + weights.volatility + weights.balance;
    expect(sum).toBeCloseTo(1.0, 5);
    // Trend was dominant so its weight should decrease on loss
    expect(weights.trend).toBeLessThan(0.4);
  });

  // ── 15. Adaptive Learning: recordCalibration ──────────────────────────────

  test('recordCalibration buckets correctly and computes accuracy', () => {
    (agent as any).recordCalibration(0.75, true);
    (agent as any).recordCalibration(0.72, false);
    (agent as any).recordCalibration(0.78, true);

    const calibration = agent.getConfidenceCalibration();
    expect(calibration).toHaveLength(1);
    expect(calibration[0].predictedBucket).toBe('0.7-0.8');
    expect(calibration[0].totalPredictions).toBe(3);
    expect(calibration[0].correctPredictions).toBe(2);
    expect(calibration[0].accuracy).toBeCloseTo(2 / 3, 5);
  });

  // ── 16. History caps ─────────────────────────────────────────────────────

  test('decisionHistory caps at 500 entries', async () => {
    for (let i = 0; i < 510; i++) {
      agent.analyze.mockResolvedValueOnce(makeDecision({ id: `dec-${i}`, confidence: 0.3, action: 'hold' }));
      await triggerCycle(agent);
    }

    const history = agent.getDecisionHistory();
    expect(history.length).toBeLessThanOrEqual(500);
  });

  test('weightHistory caps at 100 entries', () => {
    const decision = makeDecision({
      marketConditions: { trendScore: 0.9, momentumScore: 0.5, volatilityScore: 0.5, balanceScore: 0.5 },
    });

    for (let i = 0; i < 110; i++) {
      (agent as any).updateWeights('win', decision);
    }

    expect(agent.getWeightHistory().length).toBeLessThanOrEqual(100);
  });

  // ── Supplemental: auto-recovery does NOT fire if agent is stopped ──────────

  test('auto-recovery does not call resume() when the agent is explicitly stopped before the delay elapses', async () => {
    agent.observe.mockRejectedValue(new Error('fail'));

    const resumeSpy = jest.spyOn(agent, 'resume');

    await triggerCycle(agent);
    expect(agent.getStatus()).toBe('error');

    // Stop the agent before the recovery timer fires.
    agent.stop();
    expect(agent.getStatus()).toBe('stopped');

    jest.advanceTimersByTime(5000);

    // resume() should NOT have been called because status is 'stopped'.
    expect(resumeSpy).not.toHaveBeenCalled();
  });
});
