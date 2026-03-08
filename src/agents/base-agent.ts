// SentinelVault — BaseAgent
// Abstract base class implementing the OODA (Observe-Orient-Decide-Act) loop
// for all autonomous AI agents operating over an AgenticWallet on Solana.

import EventEmitter from 'eventemitter3';
import {
  AgentConfig,
  AgentState,
  AgentStatus,
  AgentDecision,
  AgentAction,
  AgentPerformance,
} from '../types';
import { AgenticWallet } from '../core/wallet';

// ─── Event Map ────────────────────────────────────────────────────────────────

interface AgentEvents {
  'agent:started': [agentId: string];
  'agent:stopped': [agentId: string];
  'agent:decision': [decision: AgentDecision];
  'agent:action': [action: AgentAction];
  'agent:error': [error: Error, agentId: string];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.5;
const AUTO_RECOVERY_DELAY_MS = 5_000;

// ─── BaseAgent ────────────────────────────────────────────────────────────────

/**
 * Abstract base class for all SentinelVault agents. Provides:
 *  - OODA (Observe → Analyze → Decide → Act → Evaluate) decision loop
 *  - Lifecycle management (start / stop / pause / resume)
 *  - Wallet event wiring for automatic performance metric tracking
 *  - Decision history and state snapshots
 *
 * Concrete subclasses must implement the four abstract OODA methods.
 */
export abstract class BaseAgent extends EventEmitter<AgentEvents> {
  protected readonly config: AgentConfig;
  protected readonly wallet: AgenticWallet;
  protected performance: AgentPerformance;

  private status: AgentStatus;
  private startedAt: number;
  private uptime: number;
  private decisionHistory: AgentDecision[];
  private cycleInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: AgentConfig, wallet: AgenticWallet) {
    super();

    this.config = config;
    this.wallet = wallet;

    this.status = 'idle';
    this.startedAt = 0;
    this.uptime = 0;
    this.decisionHistory = [];

    this.performance = {
      totalTransactions: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      totalVolumeSol: 0,
      totalFeePaid: 0,
      profitLoss: 0,
      winRate: 0,
      averageExecutionTime: 0,
    };

    this.wireWalletEvents();
  }

  // ── Abstract OODA Methods ────────────────────────────────────────────────────

  /**
   * OBSERVE: Gather market data and environmental context needed for a decision.
   * Implementations should query price feeds, on-chain state, portfolio
   * positions, or any other relevant signal sources.
   */
  protected abstract observe(): Promise<Record<string, unknown>>;

  /**
   * ANALYZE: Evaluate the observations and produce a structured decision.
   * Implementations encode the agent's strategy logic here, setting a
   * confidence score and the intended action type.
   */
  protected abstract analyze(observations: Record<string, unknown>): Promise<AgentDecision>;

  /**
   * EXECUTE: Translate an approved decision into on-chain or off-chain actions.
   * Returns the resulting AgentAction, or null if no action was taken.
   * Called only when confidence >= CONFIDENCE_THRESHOLD and action !== 'hold'.
   */
  protected abstract execute(decision: AgentDecision): Promise<AgentAction | null>;

  /**
   * EVALUATE: Assess the outcome of an executed action and update any internal
   * strategy state (e.g. PnL tracking, model feedback, position registers).
   */
  protected abstract evaluate(action: AgentAction | null, decision: AgentDecision): Promise<void>;

  // ── OODA Cycle ───────────────────────────────────────────────────────────────

  /**
   * Run a single OODA cycle. Orchestrated as:
   *   observe → analyze → (confidence gate) → execute → evaluate
   *
   * Decisions below the confidence threshold or with action 'hold' are
   * recorded but not executed. Errors trigger auto-recovery after a short
   * delay unless the agent has been explicitly stopped.
   */
  private async runCycle(): Promise<void> {
    this.status = 'analyzing';

    try {
      // ── Observe ──────────────────────────────────────────────────────────────
      const observations = await this.observe();

      // ── Analyze ──────────────────────────────────────────────────────────────
      const decision = await this.analyze(observations);

      // ── Confidence gate ───────────────────────────────────────────────────────
      const shouldExecute =
        decision.confidence >= CONFIDENCE_THRESHOLD && decision.action !== 'hold';

      let action: AgentAction | null = null;

      if (shouldExecute) {
        // ── Execute ────────────────────────────────────────────────────────────
        this.status = 'executing';
        action = await this.execute(decision);
        decision.executed = true;
      } else {
        decision.executed = false;
      }

      // ── Evaluate ──────────────────────────────────────────────────────────────
      await this.evaluate(action, decision);

      // ── Record & emit ─────────────────────────────────────────────────────────
      this.decisionHistory.push(decision);
      this.emit('agent:decision', decision);

      if (action !== null) {
        this.emit('agent:action', action);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.status = 'error';
      this.emit('agent:error', error, this.config.id);
      this.scheduleAutoRecovery();
      return;
    }

    // Restore idle status only on a clean cycle completion.
    this.status = 'idle';
  }

  /**
   * Wait AUTO_RECOVERY_DELAY_MS then resume the agent loop, but only if the
   * agent has not been explicitly stopped in the meantime.
   */
  private scheduleAutoRecovery(): void {
    setTimeout(() => {
      if (this.status !== 'stopped') {
        this.resume();
      }
    }, AUTO_RECOVERY_DELAY_MS);
  }

  // ── Lifecycle Methods ────────────────────────────────────────────────────────

  /**
   * Start the OODA loop. Sets startedAt, begins executing runCycle on the
   * configured cooldown interval, and emits 'agent:started'.
   */
  start(): void {
    this.status = 'idle';
    this.startedAt = Date.now();
    this.cycleInterval = setInterval(
      () => void this.runCycle(),
      this.config.strategy.cooldownMs,
    );
    this.emit('agent:started', this.config.id);
  }

  /**
   * Stop the OODA loop permanently. Clears the interval, updates status to
   * 'stopped', and emits 'agent:stopped'. Call start() to begin a fresh run.
   */
  stop(): void {
    this.clearCycleInterval();
    this.status = 'stopped';
    this.emit('agent:stopped', this.config.id);
  }

  /**
   * Temporarily suspend the OODA loop without emitting a lifecycle event.
   * Call resume() to restart execution.
   */
  pause(): void {
    this.clearCycleInterval();
    this.status = 'paused';
  }

  /**
   * Restart the OODA loop after a pause() or auto-recovery. Sets status back
   * to 'idle' and re-registers the interval.
   */
  resume(): void {
    this.cycleInterval = setInterval(
      () => void this.runCycle(),
      this.config.strategy.cooldownMs,
    );
    this.status = 'idle';
  }

  // ── Accessors ────────────────────────────────────────────────────────────────

  /** Return the agent's unique identifier. */
  getId(): string {
    return this.config.id;
  }

  /** Return the human-readable agent name. */
  getName(): string {
    return this.config.name;
  }

  /** Return the agent type (trader, arbitrageur, etc.). */
  getType(): AgentConfig['type'] {
    return this.config.type;
  }

  /** Return the current lifecycle status. */
  getStatus(): AgentStatus {
    return this.status;
  }

  /**
   * Build and return a full snapshot of the agent's current state, including
   * the wallet state, performance metrics, and decision history head.
   */
  getState(): AgentState {
    return {
      id: this.config.id,
      name: this.config.name,
      type: this.config.type,
      status: this.status,
      wallet: this.wallet.getState()!,
      performance: this.getPerformance(),
      currentStrategy: this.config.strategy.name,
      activeActions: [],
      lastDecision: this.decisionHistory[this.decisionHistory.length - 1] ?? null,
      uptime: this.computeUptime(),
      startedAt: this.startedAt,
    };
  }

  /**
   * Return current performance metrics. Computes winRate from the transaction
   * counters and uptime from the running clock on each call.
   */
  getPerformance(): AgentPerformance {
    const total = this.performance.totalTransactions;
    const winRate = total > 0
      ? this.performance.successfulTransactions / total
      : 0;

    return {
      ...this.performance,
      winRate,
      // Expose uptime as seconds in the performance snapshot.
      averageExecutionTime: this.performance.averageExecutionTime,
    };
  }

  /** Return a shallow copy of the full decision history. */
  getDecisionHistory(): AgentDecision[] {
    return [...this.decisionHistory];
  }

  // ── Protected Helpers ────────────────────────────────────────────────────────

  /**
   * Merge partial performance updates into the tracked metrics. Subclasses
   * use this to record volume, fees, PnL, and execution timing data.
   */
  protected updatePerformance(updates: Partial<AgentPerformance>): void {
    this.performance = { ...this.performance, ...updates };
  }

  // ── Private Helpers ──────────────────────────────────────────────────────────

  /** Clear the active cycle interval if one exists. */
  private clearCycleInterval(): void {
    if (this.cycleInterval !== null) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
  }

  /** Calculate elapsed uptime in seconds since the agent was last started. */
  private computeUptime(): number {
    if (this.startedAt === 0) {
      return 0;
    }
    return Math.floor((Date.now() - this.startedAt) / 1_000);
  }

  /**
   * Subscribe to wallet transaction events so that performance counters stay
   * in sync without requiring subclasses to wire these manually.
   */
  private wireWalletEvents(): void {
    this.wallet.on('transaction:confirmed', () => {
      this.performance.successfulTransactions += 1;
      this.performance.totalTransactions += 1;
    });

    this.wallet.on('transaction:failed', () => {
      this.performance.failedTransactions += 1;
      this.performance.totalTransactions += 1;
    });
  }
}
