// SentinelVault — BaseAgent
// Abstract base class implementing the OODA (Observe-Orient-Decide-Act) loop
// for all autonomous AI agents operating over an AgenticWallet on Solana.

import * as fs from 'fs';
import * as path from 'path';
import EventEmitter from 'eventemitter3';
import {
  AgentConfig,
  AgentState,
  AgentStatus,
  AgentDecision,
  AgentAction,
  AgentPerformance,
  TransactionValidationParams,
  AdaptiveWeights,
  WeightUpdate,
  MarketRegime,
  ConfidenceCalibration,
  PendingOutcome,
  PnLEntry,
  PnLSummary,
  MarketConsensus,
} from '../types';
import { AgenticWallet } from '../core/wallet';
import { PolicyEngine } from '../security/policy-engine';

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
const MAX_DECISION_HISTORY = 500;
const MAX_WEIGHT_HISTORY = 100;
const DEFAULT_WEIGHTS: AdaptiveWeights = { trend: 0.4, momentum: 0.3, volatility: 0.2, balance: 0.1 };
const WEIGHT_LEARNING_RATE = 0.1;
const OUTCOME_EVAL_TICKS = 3;
const MIN_CALIBRATION_SAMPLES = 5;
const ADAPTIVE_STATE_DIR = '.sentinelvault/adaptive';
const PERSIST_EVERY_N_DECISIONS = 10;
const MAX_PNL_HISTORY = 500;

// ─── Internal Persistence Interface ──────────────────────────────────────────

interface PersistedAdaptiveState {
  version: number;
  agentId: string;
  timestamp: number;
  adaptiveWeights: AdaptiveWeights;
  calibrationBuckets: Record<string, { total: number; correct: number }>;
  weightHistory: WeightUpdate[];
  decisionCount: number;
  currentRegime: MarketRegime;
}

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

  // Adaptive learning state
  protected adaptiveWeights: AdaptiveWeights;
  protected weightHistory: WeightUpdate[];
  protected currentRegime: MarketRegime;
  private confidenceBuckets: Map<string, { total: number; correct: number }>;
  protected pendingOutcomes: PendingOutcome[] = [];

  // P&L tracking
  protected pnlHistory: PnLEntry[] = [];
  protected initialBalanceSol: number = 0;

  // Market consensus
  protected marketConsensus: MarketConsensus | null = null;

  private policyEngine: PolicyEngine | null = null;
  private status: AgentStatus;
  private startedAt: number;
  private uptime: number;
  private decisionHistory: AgentDecision[];
  private cycleInterval: ReturnType<typeof setInterval> | null = null;
  private _cycleRunning = false;

  constructor(config: AgentConfig, wallet: AgenticWallet) {
    super();

    this.config = config;
    this.wallet = wallet;

    this.status = 'idle';
    this.startedAt = 0;
    this.uptime = 0;
    this.decisionHistory = [];

    // Adaptive learning initialization
    this.adaptiveWeights = { ...DEFAULT_WEIGHTS };
    this.weightHistory = [];
    this.currentRegime = 'quiet';
    this.confidenceBuckets = new Map();

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
    if (this._cycleRunning) return; // Skip if previous cycle still running
    this._cycleRunning = true;
    try {
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
        // ── Policy gate ───────────────────────────────────────────────────────
        if (this.policyEngine) {
          const txParams = this.estimateTransactionParams(decision);
          if (txParams) {
            const validation = this.policyEngine.validateTransaction(txParams);
            if (!validation.allowed) {
              decision.executed = false;
              this.decisionHistory.push(decision);
              this.emit('agent:decision', decision);
              return;
            }
          }
        }

        // ── Execute ────────────────────────────────────────────────────────────
        this.status = 'executing';
        action = await this.execute(decision);
        decision.executed = action !== null;

        // ── Record outcome in policy engine ────────────────────────────────────
        if (this.policyEngine && action !== null) {
          const amountSol = (action.details.amountSol as number) ?? 0;
          if (action.result?.status === 'confirmed') {
            this.policyEngine.recordTransaction(amountSol);
          } else {
            this.policyEngine.recordFailure();
          }
        }
      } else {
        decision.executed = false;
      }

      // ── Evaluate ──────────────────────────────────────────────────────────────
      await this.evaluate(action, decision);

      // ── Record & emit ─────────────────────────────────────────────────────────
      this.decisionHistory.push(decision);
      if (this.decisionHistory.length > MAX_DECISION_HISTORY) {
        this.decisionHistory.splice(0, this.decisionHistory.length - MAX_DECISION_HISTORY);
      }
      // Throttled adaptive state persistence
      if (this.decisionHistory.length % PERSIST_EVERY_N_DECISIONS === 0) {
        this.persistAdaptiveState();
      }
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
    } finally {
      this._cycleRunning = false;
    }
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
   * Start the OODA loop. Restores persisted adaptive state if available,
   * records the initial SOL balance for P&L tracking, sets startedAt, begins
   * executing runCycle on the configured cooldown interval, and emits
   * 'agent:started'.
   */
  start(): void {
    this.status = 'idle';
    this.startedAt = Date.now();

    // Restore adaptive learning state from disk (best-effort)
    this.restoreAdaptiveState();

    // Record initial balance for P&L tracking (best-effort, async)
    void this.wallet.getBalance().then(bal => { this.initialBalanceSol = bal; }).catch(() => {});

    this.cycleInterval = setInterval(
      () => void this.runCycle(),
      this.config.strategy.cooldownMs,
    );
    this.emit('agent:started', this.config.id);
  }

  /**
   * Stop the OODA loop permanently. Persists adaptive state to disk, clears
   * the interval, updates status to 'stopped', and emits 'agent:stopped'.
   * Call start() to begin a fresh run.
   */
  stop(): void {
    this.persistAdaptiveState();
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

  /** Return the agent type (trader, liquidity_provider, arbitrageur, portfolio_manager). */
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

  // ── Adaptive Learning Methods ──────────────────────────────────────────────

  /**
   * Detect the current market regime from price history using volatility ratio
   * and trend strength.
   */
  protected detectRegime(priceHistory: number[]): MarketRegime {
    if (priceHistory.length < 5) return 'quiet';

    const recent = priceHistory.slice(-20);
    const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
    if (mean === 0) return 'quiet';

    // Volatility: stddev / mean
    const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length;
    const stddev = Math.sqrt(variance);
    const volRatio = stddev / mean;

    // Trend strength: slope of linear regression
    const n = recent.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += recent[i];
      sumXY += i * recent[i];
      sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const normalizedSlope = Math.abs(slope / mean);

    // A strong trend with any level of volatility is still "trending"
    if (normalizedSlope > 0.005) return 'trending';
    if (volRatio > 0.03) return 'volatile';
    if (volRatio < 0.01 && normalizedSlope < 0.002) return 'quiet';
    return 'mean_reverting';
  }

  /**
   * EMA-based weight update: adjust the dominant factor's weight proportional
   * to its deviation strength. Larger signals get larger updates than the old
   * fixed ±0.02 nudge. Re-normalizes to sum=1, floors each weight at 0.05.
   */
  protected updateWeights(outcome: 'win' | 'loss', decision: AgentDecision): void {
    const mc = decision.marketConditions;
    const scores: Record<keyof AdaptiveWeights, number> = {
      trend: (mc.trendScore as number) ?? 0.5,
      momentum: (mc.momentumScore as number) ?? 0.5,
      volatility: (mc.volatilityScore as number) ?? 0.5,
      balance: (mc.balanceScore as number) ?? 0.5,
    };

    // Find the factor with the highest absolute deviation from 0.5
    let dominantFactor: keyof AdaptiveWeights = 'trend';
    let maxDeviation = 0;
    for (const key of Object.keys(scores) as (keyof AdaptiveWeights)[]) {
      const dev = Math.abs(scores[key] - 0.5);
      if (dev > maxDeviation) {
        maxDeviation = dev;
        dominantFactor = key;
      }
    }

    const oldWeights = { ...this.adaptiveWeights };
    const direction = outcome === 'win' ? 1 : -1;
    const adjustment = direction * WEIGHT_LEARNING_RATE * (1 + maxDeviation);
    this.adaptiveWeights[dominantFactor] = Math.max(0.05, this.adaptiveWeights[dominantFactor] + adjustment);

    // Normalize to sum=1
    const sum = Object.values(this.adaptiveWeights).reduce((s, v) => s + v, 0);
    for (const key of Object.keys(this.adaptiveWeights) as (keyof AdaptiveWeights)[]) {
      this.adaptiveWeights[key] /= sum;
    }

    const update: WeightUpdate = {
      timestamp: Date.now(),
      oldWeights,
      newWeights: { ...this.adaptiveWeights },
      trigger: `ema-update after ${outcome} (dominant: ${dominantFactor}, deviation: ${maxDeviation.toFixed(3)})`,
    };
    this.weightHistory.push(update);
    if (this.weightHistory.length > MAX_WEIGHT_HISTORY) {
      this.weightHistory.splice(0, this.weightHistory.length - MAX_WEIGHT_HISTORY);
    }
  }

  /**
   * Record a calibration data point: bucket the predicted confidence into
   * 0.1-wide bins and track accuracy.
   */
  protected recordCalibration(predictedConfidence: number, wasCorrect: boolean): void {
    const bucketStart = Math.floor(predictedConfidence * 10) / 10;
    const bucketKey = `${bucketStart.toFixed(1)}-${(bucketStart + 0.1).toFixed(1)}`;

    const entry = this.confidenceBuckets.get(bucketKey) ?? { total: 0, correct: 0 };
    entry.total += 1;
    if (wasCorrect) entry.correct += 1;
    this.confidenceBuckets.set(bucketKey, entry);
  }

  /** Return current adaptive weights. */
  getAdaptiveWeights(): AdaptiveWeights {
    return { ...this.adaptiveWeights };
  }

  /** Return the weight update history. */
  getWeightHistory(): WeightUpdate[] {
    return [...this.weightHistory];
  }

  /** Return the currently detected market regime. */
  getMarketRegime(): MarketRegime {
    return this.currentRegime;
  }

  /** Return confidence calibration data across all buckets. */
  getConfidenceCalibration(): ConfidenceCalibration[] {
    const result: ConfidenceCalibration[] = [];
    for (const [bucket, data] of this.confidenceBuckets.entries()) {
      result.push({
        predictedBucket: bucket,
        totalPredictions: data.total,
        correctPredictions: data.correct,
        accuracy: data.total > 0 ? data.correct / data.total : 0,
      });
    }
    return result.sort((a, b) => a.predictedBucket.localeCompare(b.predictedBucket));
  }

  // ── Adaptive Decision Methods ────────────────────────────────────────────

  /**
   * Scale confidence based on the current market regime.
   * Trending regimes boost buy/sell confidence; volatile regimes reduce it.
   * If market consensus disagrees with the local regime, an additional 10%
   * penalty is applied to reflect the uncertainty.
   */
  protected applyRegimeScaling(confidence: number, action: string): number {
    // If market consensus disagrees with local regime, reduce confidence
    if (this.marketConsensus && this.marketConsensus.regime !== this.currentRegime) {
      confidence = confidence * 0.90;
    }

    switch (this.currentRegime) {
      case 'trending':
        return action !== 'hold' ? confidence * 1.10 : confidence;
      case 'volatile':
        return confidence * 0.85;
      default:
        return confidence;
    }
  }

  /**
   * Adjust confidence based on historical calibration accuracy.
   * If the bucket for this confidence level has enough samples and the actual
   * accuracy differs from the predicted midpoint, scale accordingly.
   */
  protected getCalibrationAdjustment(confidence: number): number {
    const bucketStart = Math.floor(confidence * 10) / 10;
    const bucketKey = `${bucketStart.toFixed(1)}-${(bucketStart + 0.1).toFixed(1)}`;
    const entry = this.confidenceBuckets.get(bucketKey);

    if (!entry || entry.total < MIN_CALIBRATION_SAMPLES) {
      return confidence;
    }

    const actualAccuracy = entry.correct / entry.total;
    const bucketMidpoint = bucketStart + 0.05;
    return confidence * (actualAccuracy / bucketMidpoint);
  }

  /**
   * Process pending outcomes that have reached their evaluation horizon.
   * Decrements ticksRemaining for all pending outcomes; when an outcome
   * reaches 0, evaluates win/loss based on price change and updates weights.
   */
  protected processPendingOutcomes(currentPrice: number): void {
    const resolved: PendingOutcome[] = [];
    const remaining: PendingOutcome[] = [];

    for (const po of this.pendingOutcomes) {
      po.ticksRemaining -= 1;
      if (po.ticksRemaining <= 0) {
        resolved.push(po);
      } else {
        remaining.push(po);
      }
    }

    this.pendingOutcomes = remaining;

    for (const po of resolved) {
      const priceWentUp = currentPrice > po.entryPrice;
      const wasCorrect =
        (po.action === 'buy' && priceWentUp) ||
        (po.action === 'sell' && !priceWentUp) ||
        (po.action === 'arbitrage' && priceWentUp) ||
        (po.action === 'rebalance_to_tokens' && !priceWentUp) ||
        (po.action === 'rebalance_to_sol' && priceWentUp);

      const outcome = wasCorrect ? 'win' : 'loss';
      this.updateWeights(outcome, po.decision);
      this.recordCalibration(po.confidence, wasCorrect);
    }
  }

  /**
   * Queue a pending outcome for deferred evaluation after OUTCOME_EVAL_TICKS cycles.
   */
  protected queuePendingOutcome(decision: AgentDecision, entryPrice: number): void {
    this.pendingOutcomes.push({
      decisionId: decision.id,
      action: decision.action,
      entryPrice,
      confidence: decision.confidence,
      ticksRemaining: OUTCOME_EVAL_TICKS,
      decision,
    });
  }

  // ── Policy Engine ──────────────────────────────────────────────────────────

  /**
   * Attach a PolicyEngine to this agent. When set, every transaction is
   * validated against the policy chain before execution.
   */
  setPolicyEngine(engine: PolicyEngine): void {
    this.policyEngine = engine;
  }

  // ── Market Consensus ──────────────────────────────────────────────────────

  /**
   * Provide a cross-agent market consensus snapshot. When set, regime
   * disagreement will dampen confidence in applyRegimeScaling().
   */
  setMarketConsensus(consensus: MarketConsensus): void {
    this.marketConsensus = consensus;
  }

  // ── Persistent Adaptive State ─────────────────────────────────────────────

  /**
   * Persist current adaptive learning state to disk atomically. Writes to a
   * temp file first, then renames to ensure partial writes do not corrupt
   * saved state. Silently fails on any I/O error.
   */
  persistAdaptiveState(): void {
    try {
      const dir = path.resolve(ADAPTIVE_STATE_DIR);
      fs.mkdirSync(dir, { recursive: true });

      const bucketsObj: Record<string, { total: number; correct: number }> = {};
      for (const [k, v] of this.confidenceBuckets.entries()) {
        bucketsObj[k] = v;
      }

      const state: PersistedAdaptiveState = {
        version: 1,
        agentId: this.config.id,
        timestamp: Date.now(),
        adaptiveWeights: { ...this.adaptiveWeights },
        calibrationBuckets: bucketsObj,
        weightHistory: this.weightHistory.slice(-50),
        decisionCount: this.decisionHistory.length,
        currentRegime: this.currentRegime,
      };

      const tmpFile = path.join(dir, `${this.config.id}.json.tmp`);
      const finalFile = path.join(dir, `${this.config.id}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmpFile, finalFile);
    } catch {
      // Best-effort: silently ignore I/O errors
    }
  }

  /**
   * Restore adaptive learning state from disk. Validates version, agentId,
   * and that the weight sum is within 0.01 of 1.0 before applying. Returns
   * true on successful restore, false on any error or validation failure.
   */
  restoreAdaptiveState(): boolean {
    try {
      const filePath = path.resolve(ADAPTIVE_STATE_DIR, `${this.config.id}.json`);
      if (!fs.existsSync(filePath)) return false;

      const raw = fs.readFileSync(filePath, 'utf8');
      const state = JSON.parse(raw) as PersistedAdaptiveState;

      // Validate integrity
      if (state.version !== 1) return false;
      if (state.agentId !== this.config.id) return false;
      const weightSum = Object.values(state.adaptiveWeights).reduce((s, v) => s + v, 0);
      if (Math.abs(weightSum - 1.0) > 0.01) return false;

      // Restore state
      this.adaptiveWeights = { ...state.adaptiveWeights };
      this.weightHistory = state.weightHistory ?? [];
      this.currentRegime = state.currentRegime ?? 'quiet';

      this.confidenceBuckets = new Map();
      for (const [k, v] of Object.entries(state.calibrationBuckets ?? {})) {
        this.confidenceBuckets.set(k, v);
      }

      return true;
    } catch {
      return false;
    }
  }

  // ── P&L Tracking ─────────────────────────────────────────────────────────

  /**
   * Record a P&L entry for a completed trade. profitLoss is computed from the
   * entry/exit price spread scaled by amountSol, and accumulated into a
   * running cumulativePnL. History is capped at MAX_PNL_HISTORY entries.
   */
  protected recordPnL(action: string, amountSol: number, entryPrice: number, exitPrice: number): void {
    const profitLoss = action === 'sell'
      ? (exitPrice - entryPrice) * amountSol / Math.max(entryPrice, 0.0001)
      : (entryPrice - exitPrice) * amountSol / Math.max(exitPrice, 0.0001);

    const lastCumulative = this.pnlHistory.length > 0
      ? this.pnlHistory[this.pnlHistory.length - 1].cumulativePnL
      : 0;

    this.pnlHistory.push({
      timestamp: Date.now(),
      action,
      amountSol,
      entryPrice,
      exitPrice,
      profitLoss,
      cumulativePnL: lastCumulative + profitLoss,
    });

    if (this.pnlHistory.length > MAX_PNL_HISTORY) {
      this.pnlHistory.splice(0, this.pnlHistory.length - MAX_PNL_HISTORY);
    }
  }

  /**
   * Return a summary of all recorded P&L activity: total P&L, win/loss
   * counts, win rate, ROI relative to initial balance, and the full history
   * slice. Callers should populate currentBalanceSol after receiving the
   * summary if a live balance is needed.
   */
  getPnLSummary(): PnLSummary {
    const wins = this.pnlHistory.filter(e => e.profitLoss > 0);
    const losses = this.pnlHistory.filter(e => e.profitLoss <= 0);
    const totalPnL = this.pnlHistory.reduce((s, e) => s + e.profitLoss, 0);

    return {
      totalPnL,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: this.pnlHistory.length > 0 ? wins.length / this.pnlHistory.length : 0,
      currentBalanceSol: 0, // caller must update
      initialBalanceSol: this.initialBalanceSol,
      roiPercent: this.initialBalanceSol > 0 ? (totalPnL / this.initialBalanceSol) * 100 : 0,
      history: [...this.pnlHistory],
    };
  }

  // ── Protected Helpers ────────────────────────────────────────────────────────

  /**
   * Estimate the transaction parameters for a pending decision so the
   * policy engine can validate before execution. Subclasses should override
   * to provide accurate amountSol, programId, and destination.
   *
   * Return null to skip policy validation for this decision.
   */
  protected estimateTransactionParams(
    _decision: AgentDecision,
  ): TransactionValidationParams | null {
    return null;
  }

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
