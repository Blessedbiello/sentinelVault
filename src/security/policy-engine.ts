import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import type {
  SecurityPolicy,
  SecurityViolation,
  SpendingWindow,
  TransactionValidationParams,
  ValidationResult,
} from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR   = 60 * MS_PER_MINUTE;
const MS_PER_DAY    = 24 * MS_PER_HOUR;
const MS_PER_WEEK   = 7  * MS_PER_DAY;
const MS_PER_MONTH  = 30 * MS_PER_DAY;

const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_RECOVERY_MS       = 60 * 1000; // 60 seconds

/** Solana System Program address used in the default allowlist. */
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

// ─── Internal State Interfaces ───────────────────────────────────────────────

interface CircuitBreakerState {
  failures: number;
  isOpen: boolean;
  lastFailureTime: number;
  openedAt: number;
}

interface PolicyEngineEvents {
  'violation': [violation: SecurityViolation];
  'circuit-breaker:open': [state: CircuitBreakerState];
}

// ─── PolicyEngine ─────────────────────────────────────────────────────────────

/**
 * Evaluates outbound transactions against a SecurityPolicy before they are
 * submitted to the network.  All blocking decisions are recorded as
 * SecurityViolation objects and re-emitted so upstream components (audit log,
 * dashboard, etc.) can react without polling.
 *
 * Validation is performed as an ordered chain of eight checks:
 *   1. Circuit breaker gate
 *   2. Program allowlist
 *   3. Address blocklist
 *   4. Per-transaction spending limit
 *   5. Hourly spending limit
 *   6. Daily spending limit
 *   7. Weekly spending limit
 *   8. Rate limits (per-minute / per-hour / per-day)
 *
 * The chain short-circuits on the first failing check.
 */
export class PolicyEngine extends EventEmitter<PolicyEngineEvents> {
  private readonly agentId: string;
  private policy: SecurityPolicy;

  // Rolling spending windows — reset lazily when their period has elapsed.
  private hourlyWindow:  SpendingWindow;
  private dailyWindow:   SpendingWindow;
  private weeklyWindow:  SpendingWindow;
  private monthlyWindow: SpendingWindow;

  // Flat list of all recorded violations (never pruned — callers can slice).
  private violations: SecurityViolation[];

  // Epoch-millisecond timestamps of each confirmed transaction, used to
  // calculate rate-limit windows by pruning stale entries on demand.
  private transactionTimestamps: number[];

  private circuitBreaker: CircuitBreakerState;

  // ── Constructor ─────────────────────────────────────────────────────────────

  constructor(agentId: string, policy: SecurityPolicy) {
    super();

    this.agentId = agentId;
    this.policy  = { ...policy };

    const now = Date.now();

    this.hourlyWindow  = { amount: 0, transactions: 0, windowStart: now };
    this.dailyWindow   = { amount: 0, transactions: 0, windowStart: now };
    this.weeklyWindow  = { amount: 0, transactions: 0, windowStart: now };
    this.monthlyWindow = { amount: 0, transactions: 0, windowStart: now };

    this.violations            = [];
    this.transactionTimestamps = [];

    this.circuitBreaker = {
      failures:        0,
      isOpen:          false,
      lastFailureTime: 0,
      openedAt:        0,
    };
  }

  // ── Public Validation API ────────────────────────────────────────────────────

  /**
   * Run the full eight-step validation chain for a prospective transaction.
   * Returns as soon as any check fails so that the cheapest checks run first.
   */
  validateTransaction(params: TransactionValidationParams): ValidationResult {
    // 1. Circuit breaker
    const cbResult = this.checkCircuitBreaker();
    if (cbResult !== null) return cbResult;

    // 2. Program allowlist
    const allowlistResult = this.checkProgramAllowlist(params.programId);
    if (allowlistResult !== null) return allowlistResult;

    // 3. Address blocklist
    const blocklistResult = this.checkAddressBlocklist(params.destination);
    if (blocklistResult !== null) return blocklistResult;

    // 4. Per-transaction spending limit
    const perTxResult = this.checkPerTransactionLimit(params.amountSol);
    if (perTxResult !== null) return perTxResult;

    // 5–7. Cumulative spending windows
    const hourlyResult = this.checkHourlyLimit(params.amountSol);
    if (hourlyResult !== null) return hourlyResult;

    const dailyResult = this.checkDailyLimit(params.amountSol);
    if (dailyResult !== null) return dailyResult;

    const weeklyResult = this.checkWeeklyLimit(params.amountSol);
    if (weeklyResult !== null) return weeklyResult;

    // 8. Transaction rate limits
    const rateResult = this.checkRateLimits();
    if (rateResult !== null) return rateResult;

    // All checks passed. Signal preflight simulation when the policy requires it.
    if (this.policy.requireSimulation) {
      return { allowed: true, simulationRequired: true };
    }

    return { allowed: true };
  }

  /**
   * Persist a completed transaction into all spending windows and the
   * timestamp log.  Must be called after a transaction has been confirmed so
   * that subsequent validations reflect the current spend.
   */
  recordTransaction(amountSol: number): void {
    const now = Date.now();

    this.refreshWindowIfExpired(this.hourlyWindow,  MS_PER_HOUR,  now);
    this.refreshWindowIfExpired(this.dailyWindow,   MS_PER_DAY,   now);
    this.refreshWindowIfExpired(this.weeklyWindow,  MS_PER_WEEK,  now);
    this.refreshWindowIfExpired(this.monthlyWindow, MS_PER_MONTH, now);

    this.hourlyWindow.amount       += amountSol;
    this.hourlyWindow.transactions += 1;
    this.dailyWindow.amount        += amountSol;
    this.dailyWindow.transactions  += 1;
    this.weeklyWindow.amount       += amountSol;
    this.weeklyWindow.transactions += 1;
    this.monthlyWindow.amount      += amountSol;
    this.monthlyWindow.transactions += 1;

    this.transactionTimestamps.push(now);
  }

  /**
   * Signal that a transaction submission or network operation has failed.
   * After five consecutive failures the circuit breaker opens, pausing all
   * outbound transactions for CIRCUIT_BREAKER_RECOVERY_MS milliseconds.
   */
  recordFailure(): void {
    const now = Date.now();

    this.circuitBreaker.failures       += 1;
    this.circuitBreaker.lastFailureTime = now;

    if (this.circuitBreaker.failures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD && !this.circuitBreaker.isOpen) {
      this.circuitBreaker.isOpen   = true;
      this.circuitBreaker.openedAt = now;
      this.emit('circuit-breaker:open', { ...this.circuitBreaker });
    }
  }

  /** Close the circuit breaker and clear the failure counter. */
  resetCircuitBreaker(): void {
    this.circuitBreaker = {
      failures:        0,
      isOpen:          false,
      lastFailureTime: 0,
      openedAt:        0,
    };
  }

  // ── Introspection ────────────────────────────────────────────────────────────

  /** Snapshot of all spending window totals, their configured limits, and circuit breaker state. */
  getSpendingSummary(): {
    hourly:         SpendingWindow & { limit: number };
    daily:          SpendingWindow & { limit: number };
    weekly:         SpendingWindow & { limit: number };
    monthly:        SpendingWindow & { limit: number };
    circuitBreaker: CircuitBreakerState;
  } {
    const now = Date.now();

    // Provide fresh (auto-reset) window data in the summary.
    this.refreshWindowIfExpired(this.hourlyWindow,  MS_PER_HOUR,  now);
    this.refreshWindowIfExpired(this.dailyWindow,   MS_PER_DAY,   now);
    this.refreshWindowIfExpired(this.weeklyWindow,  MS_PER_WEEK,  now);
    this.refreshWindowIfExpired(this.monthlyWindow, MS_PER_MONTH, now);

    return {
      hourly:  { ...this.hourlyWindow,  limit: this.policy.spendingLimits.hourly  },
      daily:   { ...this.dailyWindow,   limit: this.policy.spendingLimits.daily   },
      weekly:  { ...this.weeklyWindow,  limit: this.policy.spendingLimits.weekly  },
      monthly: { ...this.monthlyWindow, limit: this.policy.spendingLimits.monthly },
      circuitBreaker: { ...this.circuitBreaker },
    };
  }

  /** Return a shallow copy of the violations array. */
  getViolations(): SecurityViolation[] {
    return [...this.violations];
  }

  // ── Policy Management ────────────────────────────────────────────────────────

  /**
   * Merge a partial policy update into the active policy.  Only the supplied
   * keys are overwritten; everything else remains unchanged.
   */
  updatePolicy(partial: Partial<SecurityPolicy>): void {
    this.policy = {
      ...this.policy,
      ...partial,
      // Deep-merge spending limits so callers can update a single sub-field.
      spendingLimits: partial.spendingLimits
        ? { ...this.policy.spendingLimits, ...partial.spendingLimits }
        : this.policy.spendingLimits,
    };
  }

  // ── Static Factory ───────────────────────────────────────────────────────────

  /**
   * Returns a conservative default SecurityPolicy suitable for devnet usage.
   * These limits should be tightened before deploying an agent to mainnet.
   */
  static createDefaultPolicy(): SecurityPolicy {
    return {
      spendingLimits: {
        perTransaction: 1,    // 1 SOL maximum per transaction
        hourly:         5,    // 5 SOL per hour
        daily:          20,   // 20 SOL per day
        weekly:         100,  // 100 SOL per week
        monthly:        500,  // 500 SOL per month
      },
      allowedPrograms: [
        SYSTEM_PROGRAM_ID,
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',    // SPL Token Program
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',    // Associated Token Program
        'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',     // Memo Program v2
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',     // Jupiter V6 Aggregator
        'Stake11111111111111111111111111111111111111',        // Native Stake Program
        'Frdq7Ro6txmf5YuWLiCuKyVrSiY1tmFDCtTU6CfxQub2',     // SentinelVault On-Chain Program
      ],
      blockedAddresses:        [],
      requireSimulation:       true,  // Reserved: preflight tx simulation (requires RPC simulateTransaction)
      maxTransactionsPerMinute: 10,
      maxTransactionsPerHour:   60,
      maxTransactionsPerDay:    500,
      alertThresholds: [
        { type: 'balance_low',       value: 0.1,  action: 'alert' },
        { type: 'high_spending',     value: 0.8,  action: 'alert' },
        { type: 'unusual_activity',  value: 5,    action: 'pause' },
        { type: 'failed_tx_spike',   value: 10,   action: 'stop'  },
      ],
    };
  }

  // ── Alert Threshold Evaluation ─────────────────────────────────────────────

  /**
   * Evaluate alert thresholds against current wallet balance and spending.
   * Returns an array of triggered alerts. Call this after transactions or on
   * a periodic health check.
   *
   * @param currentBalanceSol - Current wallet SOL balance.
   */
  evaluateAlertThresholds(currentBalanceSol: number): { type: string; value: number; action: string; message: string }[] {
    const alerts: { type: string; value: number; action: string; message: string }[] = [];

    if (!this.policy.alertThresholds || this.policy.alertThresholds.length === 0) {
      return alerts;
    }

    for (const threshold of this.policy.alertThresholds) {
      switch (threshold.type) {
        case 'balance_low':
          if (currentBalanceSol < threshold.value) {
            alerts.push({
              ...threshold,
              message: `Balance ${currentBalanceSol.toFixed(4)} SOL is below threshold ${threshold.value} SOL`,
            });
          }
          break;
        case 'high_spending': {
          // threshold.value is fraction of daily limit (e.g. 0.8 = 80%)
          const now = Date.now();
          this.refreshWindowIfExpired(this.dailyWindow, MS_PER_DAY, now);
          const dailyLimit = this.policy.spendingLimits.daily;
          const spendingRatio = dailyLimit > 0 ? this.dailyWindow.amount / dailyLimit : 0;
          if (spendingRatio >= threshold.value) {
            alerts.push({
              ...threshold,
              message: `Daily spending at ${(spendingRatio * 100).toFixed(1)}% of limit (${this.dailyWindow.amount.toFixed(4)}/${dailyLimit} SOL)`,
            });
          }
          break;
        }
        case 'unusual_activity': {
          // threshold.value = max tx count per minute before flagging
          const now = Date.now();
          const recentCount = this.transactionTimestamps.filter(ts => now - ts < MS_PER_MINUTE).length;
          if (recentCount >= threshold.value) {
            alerts.push({
              ...threshold,
              message: `${recentCount} transactions in the last minute exceeds threshold of ${threshold.value}`,
            });
          }
          break;
        }
        case 'failed_tx_spike':
          if (this.circuitBreaker.failures >= threshold.value) {
            alerts.push({
              ...threshold,
              message: `${this.circuitBreaker.failures} consecutive failures exceeds threshold of ${threshold.value}`,
            });
          }
          break;
      }
    }

    return alerts;
  }

  // ── Private Validation Steps ─────────────────────────────────────────────────

  private checkCircuitBreaker(): ValidationResult | null {
    if (!this.circuitBreaker.isOpen) return null;

    const elapsed = Date.now() - this.circuitBreaker.openedAt;

    if (elapsed < CIRCUIT_BREAKER_RECOVERY_MS) {
      return this.buildViolation({
        rule:     'circuit_breaker_open',
        severity: 'critical',
        reason:   `Circuit breaker is open after ${this.circuitBreaker.failures} consecutive failures. ` +
                  `Recovers in ${Math.ceil((CIRCUIT_BREAKER_RECOVERY_MS - elapsed) / 1000)}s.`,
        details: {
          failures:    this.circuitBreaker.failures,
          openedAt:    this.circuitBreaker.openedAt,
          elapsedMs:   elapsed,
          recoveryMs:  CIRCUIT_BREAKER_RECOVERY_MS,
        },
        blocked: true,
      });
    }

    // Recovery period has elapsed — auto-reset and allow the transaction.
    this.resetCircuitBreaker();
    return null;
  }

  private checkProgramAllowlist(programId?: string): ValidationResult | null {
    const { allowedPrograms } = this.policy;

    if (allowedPrograms.length === 0) return null;  // empty list means "allow all"
    if (!programId) return null;                    // no program to check
    if (allowedPrograms.includes(programId)) return null;

    return this.buildViolation({
      rule:     'program_not_allowlisted',
      severity: 'high',
      reason:   `Program ${programId} is not in the allowed programs list.`,
      details:  { programId, allowedPrograms },
      blocked:  true,
    });
  }

  private checkAddressBlocklist(destination?: string): ValidationResult | null {
    if (!destination) return null;
    if (!this.policy.blockedAddresses.includes(destination)) return null;

    return this.buildViolation({
      rule:     'destination_blocked',
      severity: 'critical',
      reason:   `Destination address ${destination} is on the blocked addresses list.`,
      details:  { destination },
      blocked:  true,
    });
  }

  private checkPerTransactionLimit(amountSol: number): ValidationResult | null {
    const limit = this.policy.spendingLimits.perTransaction;

    if (amountSol <= limit) return null;

    return this.buildViolation({
      rule:     'per_transaction_limit_exceeded',
      severity: 'high',
      reason:   `Transaction amount ${amountSol} SOL exceeds the per-transaction limit of ${limit} SOL.`,
      details:  { amountSol, limit },
      blocked:  true,
    });
  }

  private checkHourlyLimit(amountSol: number): ValidationResult | null {
    const now   = Date.now();
    const limit = this.policy.spendingLimits.hourly;

    this.refreshWindowIfExpired(this.hourlyWindow, MS_PER_HOUR, now);

    const projected = this.hourlyWindow.amount + amountSol;

    if (projected <= limit) return null;

    return this.buildViolation({
      rule:     'hourly_spending_limit_exceeded',
      severity: 'high',
      reason:   `Projected hourly spend of ${projected.toFixed(4)} SOL would exceed the hourly limit of ${limit} SOL.`,
      details:  { currentSpend: this.hourlyWindow.amount, amountSol, projected, limit },
      blocked:  true,
    });
  }

  private checkDailyLimit(amountSol: number): ValidationResult | null {
    const now   = Date.now();
    const limit = this.policy.spendingLimits.daily;

    this.refreshWindowIfExpired(this.dailyWindow, MS_PER_DAY, now);

    const projected = this.dailyWindow.amount + amountSol;

    if (projected <= limit) return null;

    return this.buildViolation({
      rule:     'daily_spending_limit_exceeded',
      severity: 'high',
      reason:   `Projected daily spend of ${projected.toFixed(4)} SOL would exceed the daily limit of ${limit} SOL.`,
      details:  { currentSpend: this.dailyWindow.amount, amountSol, projected, limit },
      blocked:  true,
    });
  }

  private checkWeeklyLimit(amountSol: number): ValidationResult | null {
    const now   = Date.now();
    const limit = this.policy.spendingLimits.weekly;

    this.refreshWindowIfExpired(this.weeklyWindow, MS_PER_WEEK, now);

    const projected = this.weeklyWindow.amount + amountSol;

    if (projected <= limit) return null;

    return this.buildViolation({
      rule:     'weekly_spending_limit_exceeded',
      severity: 'medium',
      reason:   `Projected weekly spend of ${projected.toFixed(4)} SOL would exceed the weekly limit of ${limit} SOL.`,
      details:  { currentSpend: this.weeklyWindow.amount, amountSol, projected, limit },
      blocked:  true,
    });
  }

  private checkRateLimits(): ValidationResult | null {
    const now = Date.now();

    // Prune timestamps outside the largest window we care about (1 day) to
    // prevent the array from growing without bound over a long agent lifetime.
    this.transactionTimestamps = this.transactionTimestamps.filter(
      (ts) => now - ts < MS_PER_DAY,
    );

    const countInWindow = (windowMs: number): number =>
      this.transactionTimestamps.filter((ts) => now - ts < windowMs).length;

    const perMinuteCount = countInWindow(MS_PER_MINUTE);
    if (perMinuteCount >= this.policy.maxTransactionsPerMinute) {
      return this.buildViolation({
        rule:     'rate_limit_per_minute_exceeded',
        severity: 'medium',
        reason:   `Rate limit exceeded: ${perMinuteCount} transactions in the last minute ` +
                  `(max ${this.policy.maxTransactionsPerMinute}).`,
        details:  { count: perMinuteCount, limit: this.policy.maxTransactionsPerMinute, window: '1m' },
        blocked:  true,
      });
    }

    const perHourCount = countInWindow(MS_PER_HOUR);
    if (perHourCount >= this.policy.maxTransactionsPerHour) {
      return this.buildViolation({
        rule:     'rate_limit_per_hour_exceeded',
        severity: 'medium',
        reason:   `Rate limit exceeded: ${perHourCount} transactions in the last hour ` +
                  `(max ${this.policy.maxTransactionsPerHour}).`,
        details:  { count: perHourCount, limit: this.policy.maxTransactionsPerHour, window: '1h' },
        blocked:  true,
      });
    }

    const perDayCount = countInWindow(MS_PER_DAY);
    if (perDayCount >= this.policy.maxTransactionsPerDay) {
      return this.buildViolation({
        rule:     'rate_limit_per_day_exceeded',
        severity: 'high',
        reason:   `Rate limit exceeded: ${perDayCount} transactions today ` +
                  `(max ${this.policy.maxTransactionsPerDay}).`,
        details:  { count: perDayCount, limit: this.policy.maxTransactionsPerDay, window: '24h' },
        blocked:  true,
      });
    }

    return null;
  }

  // ── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Reset a spending window to zero if its period has elapsed.
   * This is a lazy reset — no background timer is needed.
   */
  private refreshWindowIfExpired(window: SpendingWindow, periodMs: number, now: number): void {
    if (now - window.windowStart >= periodMs) {
      window.amount       = 0;
      window.transactions = 0;
      window.windowStart  = now;
    }
  }

  /**
   * Build a ValidationResult containing a new SecurityViolation, append it to
   * the internal log, and emit the 'violation' event so subscribers are notified
   * synchronously before control returns to the caller.
   */
  private buildViolation(opts: {
    rule:     string;
    severity: SecurityViolation['severity'];
    reason:   string;
    details:  Record<string, unknown>;
    blocked:  boolean;
  }): ValidationResult {
    const violation: SecurityViolation = {
      id:        uuidv4(),
      timestamp: Date.now(),
      agentId:   this.agentId,
      rule:      opts.rule,
      severity:  opts.severity,
      details:   opts.details,
      blocked:   opts.blocked,
    };

    this.violations.push(violation);
    this.emit('violation', violation);

    return {
      allowed:   false,
      reason:    opts.reason,
      violation,
    };
  }
}
