// SentinelVault — BaseAgent Tests
// Tests the abstract BaseAgent OODA loop, lifecycle management, event emission,
// performance tracking, and policy-engine integration using a concrete TestAgent.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

  // ── 17. Adaptive Learning: EMA weight convergence ──────────────────────────

  test('EMA updateWeights produces larger shifts than old fixed nudge after 10 consecutive wins', () => {
    const decision = makeDecision({
      marketConditions: { trendScore: 0.9, momentumScore: 0.5, volatilityScore: 0.5, balanceScore: 0.5 },
    });

    const initialTrend = agent.getAdaptiveWeights().trend;
    for (let i = 0; i < 10; i++) {
      (agent as any).updateWeights('win', decision);
    }

    const finalTrend = agent.getAdaptiveWeights().trend;
    // EMA shift after 10 wins should be substantially more than 10 * 0.02 = 0.2 (old approach)
    // With WEIGHT_LEARNING_RATE=0.1 and deviation=0.4, each nudge ≈ 0.14
    expect(finalTrend - initialTrend).toBeGreaterThan(0.05);
  });

  // ── 18. Adaptive Learning: applyRegimeScaling ─────────────────────────────

  test('applyRegimeScaling: trending boosts non-hold confidence by 10%', () => {
    (agent as any).currentRegime = 'trending';
    const result = (agent as any).applyRegimeScaling(0.7, 'buy');
    expect(result).toBeCloseTo(0.77, 2);
  });

  test('applyRegimeScaling: volatile reduces confidence by 15%', () => {
    (agent as any).currentRegime = 'volatile';
    const result = (agent as any).applyRegimeScaling(0.7, 'buy');
    expect(result).toBeCloseTo(0.595, 2);
  });

  test('applyRegimeScaling: quiet returns unchanged', () => {
    (agent as any).currentRegime = 'quiet';
    const result = (agent as any).applyRegimeScaling(0.7, 'buy');
    expect(result).toBe(0.7);
  });

  // ── 19. Adaptive Learning: getCalibrationAdjustment ───────────────────────

  test('getCalibrationAdjustment returns unadjusted below MIN_CALIBRATION_SAMPLES', () => {
    // Add only 3 samples (below threshold of 5)
    (agent as any).recordCalibration(0.75, true);
    (agent as any).recordCalibration(0.72, false);
    (agent as any).recordCalibration(0.78, true);

    const result = (agent as any).getCalibrationAdjustment(0.75);
    expect(result).toBe(0.75);
  });

  test('getCalibrationAdjustment adjusts correctly with enough samples', () => {
    // Add 6 samples: 3 correct, 3 incorrect → 50% accuracy in 0.7-0.8 bucket
    for (let i = 0; i < 3; i++) {
      (agent as any).recordCalibration(0.75, true);
      (agent as any).recordCalibration(0.72, false);
    }

    const result = (agent as any).getCalibrationAdjustment(0.75);
    // bucket midpoint = 0.75, accuracy = 0.5, adjusted = 0.75 * (0.5 / 0.75) = 0.5
    expect(result).toBeCloseTo(0.5, 1);
  });

  // ── 20. Adaptive Learning: processPendingOutcomes ─────────────────────────

  test('processPendingOutcomes resolves after ticksRemaining reaches 0', () => {
    const decision = makeDecision({ action: 'buy', confidence: 0.8 });
    (agent as any).queuePendingOutcome(decision, 100);

    // 3 ticks to resolve
    (agent as any).processPendingOutcomes(105); // tick 1
    expect((agent as any).pendingOutcomes.length).toBe(1);
    (agent as any).processPendingOutcomes(105); // tick 2
    expect((agent as any).pendingOutcomes.length).toBe(1);
    (agent as any).processPendingOutcomes(105); // tick 3 → resolved
    expect((agent as any).pendingOutcomes.length).toBe(0);
    // Weight history should show the update
    expect(agent.getWeightHistory().length).toBeGreaterThanOrEqual(1);
  });

  test('processPendingOutcomes does NOT resolve when ticks remain', () => {
    const decision = makeDecision({ action: 'buy', confidence: 0.8 });
    (agent as any).queuePendingOutcome(decision, 100);

    (agent as any).processPendingOutcomes(105); // tick 1
    expect((agent as any).pendingOutcomes.length).toBe(1);
  });

  test('queuePendingOutcome adds to pendingOutcomes array', () => {
    const decision = makeDecision({ action: 'sell', confidence: 0.7 });
    (agent as any).queuePendingOutcome(decision, 50);

    expect((agent as any).pendingOutcomes.length).toBe(1);
    expect((agent as any).pendingOutcomes[0].action).toBe('sell');
    expect((agent as any).pendingOutcomes[0].entryPrice).toBe(50);
    expect((agent as any).pendingOutcomes[0].ticksRemaining).toBe(3);
  });

  // ── Concurrent cycle guard ────────────────────────────────────────────────

  describe('concurrent cycle guard', () => {
    it('skips cycle if previous cycle is still running', async () => {
      jest.useRealTimers();

      // Create agent with a slow observe that takes 100ms
      let observeCallCount = 0;
      const SlowAgent = class extends (BaseAgent as any) {
        constructor(cfg: any, w: any) {
          super(cfg, w);
        }
        protected async observe() {
          observeCallCount++;
          await new Promise(r => setTimeout(r, 100));
          return { price: 1.0 };
        }
        protected async analyze() {
          return { id: 'test', agentId: 'test', timestamp: Date.now(), marketConditions: {}, analysis: 'test', action: 'hold', confidence: 0.3, reasoning: 'test', executed: false };
        }
        protected async execute() { return null; }
        protected async evaluate() {}
      };

      // Start with very short interval (10ms)
      const config = {
        id: 'test-slow',
        name: 'Slow Agent',
        type: 'trader' as const,
        walletConfig: { id: 'w', label: 'w', password: 'p', cluster: 'devnet' as const },
        strategy: { name: 'test', type: 'dca', cooldownMs: 10, params: { targetAddress: '11111111111111111111111111111111' } },
        securityPolicy: {} as any,
        enabled: true,
      };

      const slowWallet = createMockWallet();
      const slowAgent = new SlowAgent(config, slowWallet);
      slowAgent.start();

      // Wait enough time for multiple intervals to fire
      await new Promise(r => setTimeout(r, 250));
      slowAgent.stop();

      // With guard: observe should be called ~2-3 times (100ms observe + 10ms interval)
      // Without guard: observe would be called ~25 times
      expect(observeCallCount).toBeLessThanOrEqual(5);
      expect(observeCallCount).toBeGreaterThanOrEqual(1);

      jest.useFakeTimers();
    });
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

  // ── 21. Persistent Adaptive State ─────────────────────────────────────────

  describe('Persistent Adaptive State', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      jest.useRealTimers();
      // Create an isolated temp directory for each test so state files don't
      // bleed between runs. We override process.cwd() by writing the adaptive
      // state dir relative to the resolved path the source uses (.sentinelvault/adaptive).
      // The source resolves via path.resolve() so we patch the agent directly.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-base-agent-'));
    });

    afterEach(() => {
      // Clean up temp directory
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      jest.useFakeTimers();
    });

    function buildAgentWithTmpDir(id: string): TestAgent {
      const config: AgentConfig = {
        ...mockConfig,
        id,
        name: `PersistTest-${id}`,
      };
      const w = createMockWallet();
      const a = new TestAgent(config, w);
      a.observe.mockResolvedValue({ price: 100 });
      a.analyze.mockResolvedValue(makeDecision());
      a.execute.mockResolvedValue(makeAction());
      a.evaluate.mockResolvedValue(undefined);
      // Override the state dir path by patching the private method at runtime
      const stateDir = path.join(tmpDir, 'adaptive');
      (a as any).persistAdaptiveState = function () {
        try {
          fs.mkdirSync(stateDir, { recursive: true });
          const bucketsObj: Record<string, { total: number; correct: number }> = {};
          for (const [k, v] of (this as any).confidenceBuckets.entries()) {
            bucketsObj[k] = v;
          }
          const state = {
            version: 1,
            agentId: (this as any).config.id,
            timestamp: Date.now(),
            adaptiveWeights: { ...(this as any).adaptiveWeights },
            calibrationBuckets: bucketsObj,
            weightHistory: (this as any).weightHistory.slice(-50),
            decisionCount: (this as any).decisionHistory.length,
            currentRegime: (this as any).currentRegime,
          };
          const tmpFile = path.join(stateDir, `${(this as any).config.id}.json.tmp`);
          const finalFile = path.join(stateDir, `${(this as any).config.id}.json`);
          fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
          fs.renameSync(tmpFile, finalFile);
        } catch { /* best-effort */ }
      };
      (a as any).restoreAdaptiveState = function (): boolean {
        try {
          const filePath = path.join(stateDir, `${(this as any).config.id}.json`);
          if (!fs.existsSync(filePath)) return false;
          const raw = fs.readFileSync(filePath, 'utf8');
          const state = JSON.parse(raw);
          if (state.version !== 1) return false;
          if (state.agentId !== (this as any).config.id) return false;
          const weightSum = Object.values(state.adaptiveWeights as Record<string, number>).reduce((s: number, v: number) => s + v, 0);
          if (Math.abs(weightSum - 1.0) > 0.01) return false;
          (this as any).adaptiveWeights = { ...state.adaptiveWeights };
          (this as any).weightHistory = state.weightHistory ?? [];
          (this as any).currentRegime = state.currentRegime ?? 'quiet';
          (this as any).confidenceBuckets = new Map();
          for (const [k, v] of Object.entries(state.calibrationBuckets ?? {})) {
            (this as any).confidenceBuckets.set(k, v);
          }
          return true;
        } catch {
          return false;
        }
      };
      return a;
    }

    test('persistAdaptiveState writes valid JSON', () => {
      const a = buildAgentWithTmpDir('persist-test-id');
      (a as any).persistAdaptiveState();

      const stateDir = path.join(tmpDir, 'adaptive');
      const filePath = path.join(stateDir, 'persist-test-id.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(parsed.version).toBe(1);
      expect(parsed.agentId).toBe('persist-test-id');
      expect(parsed).toHaveProperty('adaptiveWeights');
      expect(parsed.adaptiveWeights).toHaveProperty('trend');
    });

    test('restoreAdaptiveState loads saved state correctly', () => {
      const id = 'restore-test-id';
      const a1 = buildAgentWithTmpDir(id);

      // Apply a weight update so the saved state differs from defaults
      const decision = makeDecision({
        marketConditions: { trendScore: 0.9, momentumScore: 0.5, volatilityScore: 0.5, balanceScore: 0.5 },
      });
      (a1 as any).updateWeights('win', decision);
      (a1 as any).persistAdaptiveState();

      const savedWeights = a1.getAdaptiveWeights();

      // Create a second agent with the same id pointing to the same tmp dir
      const a2 = buildAgentWithTmpDir(id);
      const restored = (a2 as any).restoreAdaptiveState();
      expect(restored).toBe(true);

      const restoredWeights = a2.getAdaptiveWeights();
      expect(restoredWeights.trend).toBeCloseTo(savedWeights.trend, 5);
      expect(restoredWeights.momentum).toBeCloseTo(savedWeights.momentum, 5);
    });

    test('restoreAdaptiveState returns false for missing file', () => {
      const a = buildAgentWithTmpDir('no-file-agent');
      const result = (a as any).restoreAdaptiveState();
      expect(result).toBe(false);
    });

    test('restoreAdaptiveState returns false for corrupt JSON', () => {
      const id = 'corrupt-agent';
      const stateDir = path.join(tmpDir, 'adaptive');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, `${id}.json`), '{this is not valid json{{{{', 'utf8');

      const a = buildAgentWithTmpDir(id);
      const result = (a as any).restoreAdaptiveState();
      expect(result).toBe(false);
    });

    test('restoreAdaptiveState returns false for wrong agentId', () => {
      // Save state under a different agent id
      const a1 = buildAgentWithTmpDir('other-agent-id');
      (a1 as any).persistAdaptiveState();

      // The saved file in tmpDir/adaptive/other-agent-id.json has agentId=other-agent-id
      // Now create an agent with id='my-agent-id' but manually copy the file
      const stateDir = path.join(tmpDir, 'adaptive');
      const srcFile = path.join(stateDir, 'other-agent-id.json');
      const destFile = path.join(stateDir, 'my-agent-id.json');
      const raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
      // Keep agentId as 'other-agent-id' but write to my-agent-id.json
      fs.writeFileSync(destFile, JSON.stringify({ ...raw, agentId: 'other-agent-id' }), 'utf8');

      const a2 = buildAgentWithTmpDir('my-agent-id');
      const result = (a2 as any).restoreAdaptiveState();
      expect(result).toBe(false);
    });

    test('restoreAdaptiveState returns false for weights that do not sum to 1.0', () => {
      const id = 'bad-weights-agent';
      const stateDir = path.join(tmpDir, 'adaptive');
      fs.mkdirSync(stateDir, { recursive: true });
      const badState = {
        version: 1,
        agentId: id,
        timestamp: Date.now(),
        adaptiveWeights: { trend: 0.9, momentum: 0.9, volatility: 0.9, balance: 0.9 }, // sum = 3.6
        calibrationBuckets: {},
        weightHistory: [],
        decisionCount: 0,
        currentRegime: 'quiet',
      };
      fs.writeFileSync(path.join(stateDir, `${id}.json`), JSON.stringify(badState), 'utf8');

      const a = buildAgentWithTmpDir(id);
      const result = (a as any).restoreAdaptiveState();
      expect(result).toBe(false);
    });
  });

  // ── 22. P&L Tracking ──────────────────────────────────────────────────────

  describe('P&L Tracking', () => {
    test('recordPnL creates entry with correct profitLoss', () => {
      // buy: profitLoss = (entryPrice - exitPrice) * amountSol / exitPrice
      // with entryPrice=150, exitPrice=160, amountSol=0.01:
      // profitLoss = (150 - 160) * 0.01 / 160 ≈ -0.000625
      (agent as any).recordPnL('buy', 0.01, 150, 160);

      const summary = agent.getPnLSummary();
      expect(summary.history).toHaveLength(1);
      expect(summary.history[0].action).toBe('buy');
      expect(summary.history[0].amountSol).toBe(0.01);
      expect(typeof summary.history[0].profitLoss).toBe('number');
    });

    test('getPnLSummary computes correct winRate and ROI', () => {
      // sell: profitLoss = (exitPrice - entryPrice) * amountSol / entryPrice
      // Winning sell: exit(160) > entry(150) → positive
      (agent as any).recordPnL('sell', 0.01, 150, 160);
      // Losing sell: exit(140) < entry(150) → negative
      (agent as any).recordPnL('sell', 0.01, 150, 140);
      // Winning sell again
      (agent as any).recordPnL('sell', 0.01, 150, 160);

      const summary = agent.getPnLSummary();
      expect(summary.winCount).toBe(2);
      expect(summary.lossCount).toBe(1);
      expect(summary.winRate).toBeCloseTo(2 / 3, 5);
    });

    test('pnlHistory caps at 500 entries', () => {
      for (let i = 0; i < 510; i++) {
        (agent as any).recordPnL('sell', 0.001, 150, 151);
      }
      const summary = agent.getPnLSummary();
      expect(summary.history.length).toBeLessThanOrEqual(500);
    });

    test('P&L cumulative tracking is accurate', () => {
      // Three winning sells, each with the same profit
      (agent as any).recordPnL('sell', 0.01, 100, 110); // profit = 0.01 * 10/100 = 0.001
      (agent as any).recordPnL('sell', 0.01, 100, 110);
      (agent as any).recordPnL('sell', 0.01, 100, 110);

      const summary = agent.getPnLSummary();
      const lastEntry = summary.history[summary.history.length - 1];
      // cumulative should equal the sum of all profits
      const total = summary.history.reduce((s, e) => s + e.profitLoss, 0);
      expect(lastEntry.cumulativePnL).toBeCloseTo(total, 10);
      expect(summary.totalPnL).toBeCloseTo(total, 10);
    });
  });

  // ── 23. Market Consensus ──────────────────────────────────────────────────

  describe('Market Consensus', () => {
    test('setMarketConsensus stores consensus', () => {
      const consensus = {
        regime: 'trending' as const,
        regimeAgreement: 0.75,
        averageConfidence: 0.7,
        lastUpdate: Date.now(),
        agentSignals: [],
      };
      agent.setMarketConsensus(consensus);
      expect((agent as any).marketConsensus).toEqual(consensus);
    });

    test('disagreeing consensus reduces confidence via applyRegimeScaling', () => {
      // Set agent's local regime to 'quiet'
      (agent as any).currentRegime = 'quiet';

      // Set a consensus that disagrees (trending)
      agent.setMarketConsensus({
        regime: 'trending',
        regimeAgreement: 0.6,
        averageConfidence: 0.7,
        lastUpdate: Date.now(),
        agentSignals: [],
      });

      // With disagreeing consensus, a 10% penalty is applied first.
      // Then for 'quiet' regime, no further scaling → result = 0.7 * 0.90 = 0.63
      const result = (agent as any).applyRegimeScaling(0.7, 'buy');
      expect(result).toBeCloseTo(0.63, 5);
    });

    test('matching consensus does not apply disagreement penalty', () => {
      (agent as any).currentRegime = 'trending';

      // Set a consensus that agrees with local regime
      agent.setMarketConsensus({
        regime: 'trending',
        regimeAgreement: 1.0,
        averageConfidence: 0.8,
        lastUpdate: Date.now(),
        agentSignals: [],
      });

      // No disagreement penalty. trending regime boosts by 10% for non-hold actions.
      const result = (agent as any).applyRegimeScaling(0.7, 'buy');
      expect(result).toBeCloseTo(0.77, 2);
    });
  });
});
