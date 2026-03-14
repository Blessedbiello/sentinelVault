import { PolicyEngine } from '../src/security/policy-engine';
import type { SecurityPolicy } from '../src/types';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/** Build a tight policy with small limits for easy testing. */
function createTestPolicy(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  return {
    spendingLimits: {
      perTransaction: 1,
      hourly: 2,
      daily: 5,
      weekly: 10,
      monthly: 30,
    },
    allowedPrograms: [SYSTEM_PROGRAM_ID],
    blockedAddresses: ['BLOCKEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
    requireSimulation: false,
    maxTransactionsPerMinute: 3,
    maxTransactionsPerHour: 60,
    maxTransactionsPerDay: 500,
    alertThresholds: [],
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine('test-agent-001', createTestPolicy());
  });

  // ── 1. Valid transaction passes ──────────────────────────────────────────────

  it('should allow a valid transaction within all limits', () => {
    const result = engine.validateTransaction({
      amountSol: 0.5,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.violation).toBeUndefined();
  });

  // ── 2. Per-transaction limit exceeded ────────────────────────────────────────

  it('should block a transaction exceeding the per-transaction limit', () => {
    const result = engine.validateTransaction({
      amountSol: 1.5,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/per-transaction limit/i);
    expect(result.violation).toBeDefined();
    expect(result.violation!.rule).toBe('per_transaction_limit_exceeded');
  });

  // ── 3. Hourly spending limit ─────────────────────────────────────────────────

  it('should block a transaction that would exceed the hourly spending limit', () => {
    // Record two transactions totalling 1.8 SOL (under hourly limit of 2)
    engine.recordTransaction(0.9);
    engine.recordTransaction(0.9);

    // Next 0.5 SOL would push projected to 2.3, exceeding limit of 2
    const result = engine.validateTransaction({
      amountSol: 0.5,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/hourly/i);
    expect(result.violation!.rule).toBe('hourly_spending_limit_exceeded');
  });

  // ── 4. Daily spending limit ──────────────────────────────────────────────────

  it('should block a transaction that would exceed the daily spending limit', () => {
    // Use a policy where hourly is large enough not to interfere
    engine = new PolicyEngine('test-agent-001', createTestPolicy({
      spendingLimits: { perTransaction: 5, hourly: 50, daily: 5, weekly: 100, monthly: 500 },
    }));

    engine.recordTransaction(2);
    engine.recordTransaction(2);

    // Projected daily = 4 + 1.5 = 5.5 > 5
    const result = engine.validateTransaction({
      amountSol: 1.5,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily/i);
    expect(result.violation!.rule).toBe('daily_spending_limit_exceeded');
  });

  // ── 5. Weekly spending limit ─────────────────────────────────────────────────

  it('should block a transaction that would exceed the weekly spending limit', () => {
    engine = new PolicyEngine('test-agent-001', createTestPolicy({
      spendingLimits: { perTransaction: 10, hourly: 50, daily: 50, weekly: 10, monthly: 500 },
    }));

    engine.recordTransaction(4);
    engine.recordTransaction(4);

    // Projected weekly = 8 + 3 = 11 > 10
    const result = engine.validateTransaction({
      amountSol: 3,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/weekly/i);
    expect(result.violation!.rule).toBe('weekly_spending_limit_exceeded');
  });

  // ── 6. Rate limits ──────────────────────────────────────────────────────────

  it('should block when per-minute rate limit is exceeded', () => {
    // maxTransactionsPerMinute is 3 in test policy
    engine.recordTransaction(0.1);
    engine.recordTransaction(0.1);
    engine.recordTransaction(0.1);

    const result = engine.validateTransaction({
      amountSol: 0.1,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/rate limit/i);
    expect(result.violation!.rule).toBe('rate_limit_per_minute_exceeded');
  });

  // ── 7. Circuit breaker opens after repeated failures ─────────────────────────

  it('should open circuit breaker after 5 failures and emit event', () => {
    const eventSpy = jest.fn();
    engine.on('circuit-breaker:open', eventSpy);

    for (let i = 0; i < 5; i++) {
      engine.recordFailure();
    }

    expect(eventSpy).toHaveBeenCalledTimes(1);
    const cbState = eventSpy.mock.calls[0][0];
    expect(cbState.isOpen).toBe(true);
    expect(cbState.failures).toBe(5);

    const result = engine.validateTransaction({
      amountSol: 0.1,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(false);
    expect(result.violation!.rule).toBe('circuit_breaker_open');
  });

  // ── 8. Circuit breaker reset restores normal operation ───────────────────────

  it('should allow transactions again after circuit breaker is reset', () => {
    for (let i = 0; i < 5; i++) {
      engine.recordFailure();
    }

    // Confirm it is blocked
    const blocked = engine.validateTransaction({
      amountSol: 0.1,
      programId: SYSTEM_PROGRAM_ID,
    });
    expect(blocked.allowed).toBe(false);

    engine.resetCircuitBreaker();

    const result = engine.validateTransaction({
      amountSol: 0.1,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(true);
  });

  // ── 9. Program allowlist enforcement ─────────────────────────────────────────

  it('should block a program not in the allowed programs list', () => {
    const result = engine.validateTransaction({
      amountSol: 0.1,
      programId: 'UNKNOWNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in the allowed programs/i);
    expect(result.violation!.rule).toBe('program_not_allowlisted');
  });

  // ── 10. Address blocklist enforcement ────────────────────────────────────────

  it('should block a transaction to a blocked address', () => {
    const result = engine.validateTransaction({
      amountSol: 0.1,
      programId: SYSTEM_PROGRAM_ID,
      destination: 'BLOCKEDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blocked addresses/i);
    expect(result.violation!.rule).toBe('destination_blocked');
  });

  // ── 11. getSpendingSummary reflects recorded transactions ────────────────────

  it('should return correct amounts in spending summary after recording transactions', () => {
    engine.recordTransaction(0.3);
    engine.recordTransaction(0.7);

    const summary = engine.getSpendingSummary();

    expect(summary.hourly.amount).toBeCloseTo(1.0, 10);
    expect(summary.hourly.transactions).toBe(2);
    expect(summary.hourly.limit).toBe(2);

    expect(summary.daily.amount).toBeCloseTo(1.0, 10);
    expect(summary.daily.transactions).toBe(2);
    expect(summary.daily.limit).toBe(5);

    expect(summary.weekly.amount).toBeCloseTo(1.0, 10);
    expect(summary.weekly.transactions).toBe(2);
    expect(summary.weekly.limit).toBe(10);

    expect(summary.monthly.amount).toBeCloseTo(1.0, 10);
    expect(summary.monthly.transactions).toBe(2);
    expect(summary.monthly.limit).toBe(30);

    expect(summary.circuitBreaker.isOpen).toBe(false);
    expect(summary.circuitBreaker.failures).toBe(0);
  });

  // ── 12. createDefaultPolicy returns a valid policy object ────────────────────

  it('should return a valid default policy from createDefaultPolicy', () => {
    const policy = PolicyEngine.createDefaultPolicy();

    expect(policy.spendingLimits).toBeDefined();
    expect(policy.spendingLimits.perTransaction).toBeGreaterThan(0);
    expect(policy.spendingLimits.hourly).toBeGreaterThan(0);
    expect(policy.spendingLimits.daily).toBeGreaterThan(0);
    expect(policy.spendingLimits.weekly).toBeGreaterThan(0);
    expect(policy.spendingLimits.monthly).toBeGreaterThan(0);

    expect(Array.isArray(policy.allowedPrograms)).toBe(true);
    expect(policy.allowedPrograms.length).toBeGreaterThan(0);

    expect(Array.isArray(policy.blockedAddresses)).toBe(true);
    expect(typeof policy.requireSimulation).toBe('boolean');

    expect(policy.maxTransactionsPerMinute).toBeGreaterThan(0);
    expect(policy.maxTransactionsPerHour).toBeGreaterThan(0);
    expect(policy.maxTransactionsPerDay).toBeGreaterThan(0);

    expect(Array.isArray(policy.alertThresholds)).toBe(true);
    expect(policy.alertThresholds.length).toBeGreaterThan(0);
  });

  // ── 13. Default allowlist contains Stake Program ──────────────────────────────

  it('should include the Native Stake Program in the default allowlist', () => {
    const policy = PolicyEngine.createDefaultPolicy();
    expect(policy.allowedPrograms).toContain('Stake11111111111111111111111111111111111111');
  });

  // ── 14. Default allowlist contains Jupiter V6 ─────────────────────────────────

  it('should include Jupiter V6 Aggregator in the default allowlist', () => {
    const policy = PolicyEngine.createDefaultPolicy();
    expect(policy.allowedPrograms).toContain('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  });

  // ── 15. Circuit breaker auto-recovery after timeout ───────────────────────────

  it('should auto-recover and allow transactions after CIRCUIT_BREAKER_RECOVERY_MS has elapsed', () => {
    jest.useFakeTimers();

    for (let i = 0; i < 5; i++) {
      engine.recordFailure();
    }

    // Confirm blocked immediately after opening
    const blocked = engine.validateTransaction({ amountSol: 0.1, programId: SYSTEM_PROGRAM_ID });
    expect(blocked.allowed).toBe(false);
    expect(blocked.violation!.rule).toBe('circuit_breaker_open');

    // Advance past the 60-second recovery window
    jest.advanceTimersByTime(61 * 1000);

    // The next validation should pass (auto-reset inside checkCircuitBreaker)
    const recovered = engine.validateTransaction({ amountSol: 0.1, programId: SYSTEM_PROGRAM_ID });
    expect(recovered.allowed).toBe(true);

    jest.useRealTimers();
  });

  // ── 16. Weekly spending limit enforcement ─────────────────────────────────────

  it('should block exactly at the weekly boundary (projected == limit + epsilon)', () => {
    engine = new PolicyEngine('test-agent-001', createTestPolicy({
      spendingLimits: { perTransaction: 10, hourly: 50, daily: 50, weekly: 10, monthly: 500 },
    }));

    // Record exactly at the limit
    engine.recordTransaction(10);

    // A 0.001 SOL transaction would project to 10.001 > 10 → blocked
    const result = engine.validateTransaction({ amountSol: 0.001, programId: SYSTEM_PROGRAM_ID });
    expect(result.allowed).toBe(false);
    expect(result.violation!.rule).toBe('weekly_spending_limit_exceeded');
  });

  // ── 17. Hourly spending limit enforcement ─────────────────────────────────────

  it('should block exactly at the hourly boundary (projected > limit)', () => {
    // Hourly limit in createTestPolicy is 2 SOL
    engine.recordTransaction(1.9);

    // 1.9 + 0.2 = 2.1 > 2 → blocked
    const result = engine.validateTransaction({ amountSol: 0.2, programId: SYSTEM_PROGRAM_ID });
    expect(result.allowed).toBe(false);
    expect(result.violation!.rule).toBe('hourly_spending_limit_exceeded');
  });

  // ── 18. getViolations accumulates across multiple rejections ──────────────────

  it('should accumulate violations for every blocked transaction', () => {
    // Exceed per-transaction limit twice
    engine.validateTransaction({ amountSol: 5, programId: SYSTEM_PROGRAM_ID });
    engine.validateTransaction({ amountSol: 5, programId: SYSTEM_PROGRAM_ID });

    const violations = engine.getViolations();
    expect(violations.length).toBe(2);
    violations.forEach(v => expect(v.rule).toBe('per_transaction_limit_exceeded'));
  });

  // ── 19. updatePolicy merges spending limits without losing unmentioned fields ──

  it('should merge spending limits when updatePolicy is called with partial limits', () => {
    engine.updatePolicy({ spendingLimits: { perTransaction: 5 } } as any);
    // The new per-transaction limit should be 5, but hourly (2) must be unchanged
    const summary = engine.getSpendingSummary();
    expect(summary.hourly.limit).toBe(2); // original hourly limit preserved
  });

  // ── 20. evaluateAlertThresholds ──────────────────────────────────────────────

  describe('evaluateAlertThresholds', () => {
    it('detects low balance', () => {
      const policy = PolicyEngine.createDefaultPolicy();
      const engine = new PolicyEngine('test', policy);

      const alerts = engine.evaluateAlertThresholds(0.05);
      const lowBalanceAlert = alerts.find(a => a.type === 'balance_low');
      expect(lowBalanceAlert).toBeDefined();
      expect(lowBalanceAlert!.message).toContain('below threshold');
    });

    it('returns empty when balance is above threshold', () => {
      const policy = PolicyEngine.createDefaultPolicy();
      const engine = new PolicyEngine('test', policy);

      const alerts = engine.evaluateAlertThresholds(1.0);
      const lowBalanceAlert = alerts.find(a => a.type === 'balance_low');
      expect(lowBalanceAlert).toBeUndefined();
    });
  });

  // ── 21. requireSimulation flag ──────────────────────────────────────────────

  it('validateTransaction sets simulationRequired when policy.requireSimulation=true', () => {
    engine = new PolicyEngine(
      'test-agent-001',
      createTestPolicy({ requireSimulation: true }),
    );

    const result = engine.validateTransaction({
      amountSol: 0.1,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(true);
    expect(result.simulationRequired).toBe(true);
  });

  it('validateTransaction does not set simulationRequired when policy.requireSimulation=false', () => {
    engine = new PolicyEngine(
      'test-agent-001',
      createTestPolicy({ requireSimulation: false }),
    );

    const result = engine.validateTransaction({
      amountSol: 0.1,
      programId: SYSTEM_PROGRAM_ID,
    });

    expect(result.allowed).toBe(true);
    // simulationRequired should be falsy (undefined or false) when not required
    expect(result.simulationRequired).toBeFalsy();
  });
});
