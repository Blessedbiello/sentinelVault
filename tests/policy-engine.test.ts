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
});
