// SentinelVault — TradingAgent
// Concrete OODA agent implementing three autonomous trading strategies over a
// simulated price feed: Dollar-Cost Averaging (dca), momentum, and
// mean_reversion. All real-money exposure is capped to 0.01 SOL per trade for
// devnet safety.

import { v4 as uuidv4 } from 'uuid';
import { BaseAgent } from './base-agent';
import { AgentConfig, AgentDecision, AgentAction, TransactionValidationParams } from '../types';
import { AgenticWallet } from '../core/wallet';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Solana System Program — a safe, always-valid devnet destination address. */
const DEVNET_FALLBACK_ADDRESS = '11111111111111111111111111111111';

const PRICE_HISTORY_MAX = 100;
const MAX_TRADE_AMOUNT_SOL = 0.01;
const MIN_TRADE_AMOUNT_SOL = 0.001;
const MAX_TRADE_BALANCE_FRACTION = 0.1; // never spend more than 10 % of balance

const SMA_SHORT_PERIOD = 20;
const SMA_LONG_PERIOD = 50;

const MEAN_REVERSION_BUY_THRESHOLD = 0.95; // buy when price < basePrice * 0.95
const MEAN_REVERSION_SELL_THRESHOLD = 1.05; // sell when price > basePrice * 1.05
const DCA_CONFIDENCE = 0.6;
const MOMENTUM_CONFIDENCE = 0.7;
const HOLD_CONFIDENCE = 0.3;

// ─── Strategy-type narrowing ──────────────────────────────────────────────────

type TradingStrategyType = 'dca' | 'momentum' | 'mean_reversion';

function isTradingStrategy(value: unknown): value is TradingStrategyType {
  return value === 'dca' || value === 'momentum' || value === 'mean_reversion';
}

// ─── Observation shape ────────────────────────────────────────────────────────

interface TradingObservations {
  price: number;
  priceHistory: number[];
  timestamp: number;
  balance: number;
}

// ─── TradingAgent ─────────────────────────────────────────────────────────────

/**
 * Autonomous trading agent for SentinelVault.
 *
 * The agent maintains a local simulated price feed (random walk with mean
 * reversion) and applies one of three strategies on each OODA cycle:
 *
 *  dca            — always buy a small fixed amount regardless of price
 *  momentum       — follow the trend using two SMAs (short vs long)
 *  mean_reversion — fade extreme moves; buy dips, sell rips
 *
 * Actual SOL transfers are submitted via the injected AgenticWallet. Trade
 * size is capped at the lower of MAX_TRADE_AMOUNT_SOL and 10 % of the current
 * wallet balance to protect devnet funds.
 */
export class TradingAgent extends BaseAgent {
  // ── Price simulation state ─────────────────────────────────────────────────

  private priceHistory: number[];
  private currentPrice: number;
  private readonly basePrice: number;

  // ── Strategy configuration ─────────────────────────────────────────────────

  private targetAddress: string;
  private readonly maxTradeAmount: number;
  private readonly strategyType: TradingStrategyType;

  // ─────────────────────────────────────────────────────────────────────────────

  constructor(config: AgentConfig, wallet: AgenticWallet) {
    super(config, wallet);

    this.priceHistory = [];
    this.currentPrice = 1.0;
    this.basePrice = 1.0;
    this.maxTradeAmount = MAX_TRADE_AMOUNT_SOL;

    // Resolve destination address from strategy params, falling back to a
    // well-known devnet address so the agent is always executable.
    const rawTarget = config.strategy.params.targetAddress;
    this.targetAddress =
      typeof rawTarget === 'string' && rawTarget.length > 0
        ? rawTarget
        : DEVNET_FALLBACK_ADDRESS;

    // Resolve and validate strategy type.
    const rawStrategy = config.strategy.type;
    if (isTradingStrategy(rawStrategy)) {
      this.strategyType = rawStrategy;
    } else {
      console.warn(
        `[${config.name}] Unknown strategy type "${String(rawStrategy)}", defaulting to "dca".`,
      );
      this.strategyType = 'dca';
    }
  }

  // ── Simulated Price Feed ───────────────────────────────────────────────────

  /**
   * Advance the simulated price by one tick using a random walk with mean
   * reversion toward basePrice.  The result is clamped to ±50 % of basePrice
   * and appended to the rolling priceHistory buffer.
   *
   * Formula:
   *   drift    = (basePrice - currentPrice) * 0.1   (pulls price toward base)
   *   noise    = (Math.random() - 0.5) * 0.04        (±2 % random shock)
   *   newPrice = currentPrice + drift + noise
   */
  private simulatePrice(): number {
    const drift = (this.basePrice - this.currentPrice) * 0.1;
    const noise = (Math.random() - 0.5) * 0.04;
    const raw = this.currentPrice + drift + noise;

    const lowerBound = this.basePrice * 0.5;
    const upperBound = this.basePrice * 1.5;
    const newPrice = Math.min(upperBound, Math.max(lowerBound, raw));

    if (this.priceHistory.length >= PRICE_HISTORY_MAX) {
      this.priceHistory.shift();
    }
    this.priceHistory.push(newPrice);

    this.currentPrice = newPrice;
    return newPrice;
  }

  // ── Statistical Helpers ────────────────────────────────────────────────────

  /**
   * Compute a simple moving average over the last `period` entries of
   * priceHistory. When fewer than `period` data points exist the entire
   * available history is used so the agent can operate from the first tick.
   */
  private sma(period: number): number {
    const window = this.priceHistory.slice(-period);
    if (window.length === 0) {
      return this.currentPrice;
    }
    return window.reduce((sum, p) => sum + p, 0) / window.length;
  }

  // ── OODA Phase 1 — Observe ─────────────────────────────────────────────────

  /**
   * Advance the price simulation by one tick, then snapshot the current
   * environment: price, price history, wall-clock time, and wallet balance.
   */
  protected async observe(): Promise<Record<string, unknown>> {
    const price = this.simulatePrice();
    const balance = await this.wallet.getBalance();

    const observations: TradingObservations = {
      price,
      priceHistory: [...this.priceHistory],
      timestamp: Date.now(),
      balance,
    };

    return observations as unknown as Record<string, unknown>;
  }

  // ── Statistical Helpers (Multi-factor) ────────────────────────────────────

  /**
   * Compute the standard deviation of a numeric array.
   * Returns 0 if the array has fewer than 2 elements.
   */
  private stddev(arr: number[]): number {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }

  // ── OODA Phase 2 — Analyze ────────────────────────────────────────────────

  /**
   * Multi-factor scoring system that produces a structured AgentDecision.
   *
   * Computes four independent factors:
   *   1. trendScore     — SMA crossover direction and magnitude (0-1)
   *   2. momentumScore  — rate of price change over recent periods (0-1)
   *   3. volatilityScore — inverse of stddev; penalizes high volatility (0-1)
   *   4. balanceScore   — penalizes when balance < 0.05 SOL (0-1)
   *
   * Weighted confidence = 0.4*trend + 0.3*momentum + 0.2*volatility + 0.1*balance
   * Each factor contributes to an explainable reasoning chain.
   */
  protected async analyze(observations: Record<string, unknown>): Promise<AgentDecision> {
    const obs = observations as unknown as TradingObservations;
    const { price, timestamp, balance } = obs;

    const sma20 = this.sma(SMA_SHORT_PERIOD);
    const sma50 = this.sma(SMA_LONG_PERIOD);

    // ── Factor 1: Trend Score ─────────────────────────────────────────────
    // Measures how strongly the short SMA has crossed above/below the long SMA.
    const smaDiff = (sma20 - sma50) / Math.max(sma50, 0.0001);
    const trendScore = Math.min(1, Math.max(0, 0.5 + smaDiff * 5));
    const trendDirection = trendScore > 0.55 ? 'bullish' : trendScore < 0.45 ? 'bearish' : 'neutral';

    // ── Factor 2: Momentum Score ──────────────────────────────────────────
    // Rate of price change over the most recent 5 ticks.
    const recentPrices = this.priceHistory.slice(-5);
    let momentumScore = 0.5;
    if (recentPrices.length >= 2) {
      const priceChange = (recentPrices[recentPrices.length - 1] - recentPrices[0]) / Math.max(recentPrices[0], 0.0001);
      momentumScore = Math.min(1, Math.max(0, 0.5 + priceChange * 10));
    }

    // ── Factor 3: Volatility Score ────────────────────────────────────────
    // Low volatility = high score (stable is better for entry).
    const recentWindow = this.priceHistory.slice(-20);
    const vol = this.stddev(recentWindow);
    const normalizedVol = vol / Math.max(price, 0.0001);
    const volatilityScore = Math.min(1, Math.max(0, 1 - normalizedVol * 20));

    // ── Factor 4: Balance Score ───────────────────────────────────────────
    // Penalize when balance is too low to trade safely.
    const balanceScore = balance >= 0.05 ? 1.0 : Math.max(0, balance / 0.05);

    // ── Weighted Confidence ───────────────────────────────────────────────
    const rawConfidence =
      0.4 * trendScore +
      0.3 * momentumScore +
      0.2 * volatilityScore +
      0.1 * balanceScore;

    // ── Reasoning Chain ───────────────────────────────────────────────────
    const reasoningChain: string[] = [
      `[Trend]      score=${trendScore.toFixed(3)} (${trendDirection}) — SMA${SMA_SHORT_PERIOD}=${sma20.toFixed(4)}, SMA${SMA_LONG_PERIOD}=${sma50.toFixed(4)}, diff=${(smaDiff * 100).toFixed(2)}%`,
      `[Momentum]   score=${momentumScore.toFixed(3)} — price change over last ${recentPrices.length} ticks`,
      `[Volatility] score=${volatilityScore.toFixed(3)} — stddev=${vol.toFixed(6)}, normalized=${(normalizedVol * 100).toFixed(2)}%`,
      `[Balance]    score=${balanceScore.toFixed(3)} — ${balance.toFixed(6)} SOL available`,
      `[Composite]  confidence=${rawConfidence.toFixed(3)} = 0.4×${trendScore.toFixed(3)} + 0.3×${momentumScore.toFixed(3)} + 0.2×${volatilityScore.toFixed(3)} + 0.1×${balanceScore.toFixed(3)}`,
    ];

    // ── Strategy-specific action decision ─────────────────────────────────
    let action: 'buy' | 'sell' | 'hold';
    let confidence: number;
    let reasoning: string;

    switch (this.strategyType) {
      case 'dca': {
        action = 'buy';
        confidence = Math.max(DCA_CONFIDENCE, rawConfidence);
        reasoning =
          `DCA strategy: accumulate regardless of direction. Price: ${price.toFixed(4)} SOL. ` +
          `Multi-factor confidence: ${rawConfidence.toFixed(3)}.`;
        reasoningChain.push(`[Decision]   DCA always buys — confidence boosted to ${confidence.toFixed(3)}`);
        break;
      }

      case 'momentum': {
        if (rawConfidence > 0.55 && trendDirection === 'bullish') {
          action = 'buy';
          confidence = rawConfidence;
          reasoning =
            `Momentum bullish: composite score ${rawConfidence.toFixed(3)} with uptrend. ` +
            `SMA${SMA_SHORT_PERIOD}=${sma20.toFixed(4)} > SMA${SMA_LONG_PERIOD}=${sma50.toFixed(4)}.`;
          reasoningChain.push(`[Decision]   BUY — bullish trend with confidence ${confidence.toFixed(3)}`);
        } else if (rawConfidence < 0.45 && trendDirection === 'bearish') {
          action = 'sell';
          confidence = 1 - rawConfidence; // invert: low composite → high sell confidence
          reasoning =
            `Momentum bearish: composite score ${rawConfidence.toFixed(3)} with downtrend. ` +
            `SMA${SMA_SHORT_PERIOD}=${sma20.toFixed(4)} < SMA${SMA_LONG_PERIOD}=${sma50.toFixed(4)}.`;
          reasoningChain.push(`[Decision]   SELL — bearish trend with confidence ${confidence.toFixed(3)}`);
        } else {
          action = 'hold';
          confidence = HOLD_CONFIDENCE;
          reasoning =
            `Momentum indeterminate: composite ${rawConfidence.toFixed(3)}, trend ${trendDirection}. Holding.`;
          reasoningChain.push(`[Decision]   HOLD — no clear signal`);
        }
        break;
      }

      case 'mean_reversion': {
        const buyLevel = this.basePrice * MEAN_REVERSION_BUY_THRESHOLD;
        const sellLevel = this.basePrice * MEAN_REVERSION_SELL_THRESHOLD;

        if (price < buyLevel) {
          const deviation = (buyLevel - price) / this.basePrice;
          confidence = Math.min(0.95, rawConfidence + deviation * 5);
          action = 'buy';
          reasoning =
            `Mean reversion: price ${price.toFixed(4)} below buy threshold ${buyLevel.toFixed(4)} ` +
            `(deviation ${(deviation * 100).toFixed(2)}%). Composite: ${rawConfidence.toFixed(3)}.`;
          reasoningChain.push(`[Decision]   BUY — price below mean reversion threshold, confidence ${confidence.toFixed(3)}`);
        } else if (price > sellLevel) {
          const deviation = (price - sellLevel) / this.basePrice;
          confidence = Math.min(0.95, (1 - rawConfidence) + deviation * 5);
          action = 'sell';
          reasoning =
            `Mean reversion: price ${price.toFixed(4)} above sell threshold ${sellLevel.toFixed(4)} ` +
            `(deviation ${(deviation * 100).toFixed(2)}%). Composite: ${rawConfidence.toFixed(3)}.`;
          reasoningChain.push(`[Decision]   SELL — price above mean reversion threshold, confidence ${confidence.toFixed(3)}`);
        } else {
          action = 'hold';
          confidence = HOLD_CONFIDENCE;
          reasoning =
            `Mean reversion: price ${price.toFixed(4)} in neutral zone [${buyLevel.toFixed(4)}, ${sellLevel.toFixed(4)}]. Holding.`;
          reasoningChain.push(`[Decision]   HOLD — price in neutral zone`);
        }
        break;
      }
    }

    const decision: AgentDecision = {
      id: uuidv4(),
      agentId: this.config.id,
      timestamp,
      marketConditions: {
        price,
        sma20,
        sma50,
        balance,
        strategyType: this.strategyType,
        priceHistoryLength: this.priceHistory.length,
        trendScore,
        momentumScore,
        volatilityScore,
        balanceScore,
        compositeConfidence: rawConfidence,
        reasoningChain,
      },
      analysis: `Strategy: ${this.strategyType} | Price: ${price.toFixed(4)} | ` +
        `SMA20: ${sma20.toFixed(4)} | SMA50: ${sma50.toFixed(4)} | ` +
        `Composite: ${rawConfidence.toFixed(3)} | Balance: ${balance.toFixed(6)} SOL`,
      action,
      confidence,
      reasoning,
      executed: false,
    };

    return decision;
  }

  // ── OODA Phase 3 — Execute ────────────────────────────────────────────────

  /**
   * Submit a SOL transfer when the decision calls for 'buy' or 'sell'.
   *
   * Trade size is the minimum of:
   *  - maxTradeAmount (hard cap, 0.01 SOL)
   *  - 10 % of the current wallet balance
   *
   * Returns null — without throwing — when:
   *  - The action is 'hold'
   *  - The computed trade amount is below MIN_TRADE_AMOUNT_SOL
   *  - The wallet transfer throws (error is logged)
   */
  protected async execute(decision: AgentDecision): Promise<AgentAction | null> {
    if (decision.action === 'hold') {
      return null;
    }

    const balance = decision.marketConditions.balance as number;
    const amount = Math.min(this.maxTradeAmount, balance * MAX_TRADE_BALANCE_FRACTION);

    if (amount < MIN_TRADE_AMOUNT_SOL) {
      console.warn(
        `[${this.config.name}] Skipping ${decision.action}: ` +
        `computed amount ${amount.toFixed(6)} SOL is below minimum ` +
        `${MIN_TRADE_AMOUNT_SOL} SOL. Balance: ${balance.toFixed(6)} SOL.`,
      );
      return null;
    }

    let signature: string;

    try {
      signature = await this.wallet.transferSOL(this.targetAddress, amount);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[${this.config.name}] Transfer failed for decision ${decision.id}: ${message}`,
      );
      return null;
    }

    const action: AgentAction = {
      id: uuidv4(),
      agentId: this.config.id,
      timestamp: Date.now(),
      type: decision.action === 'buy' ? 'transfer_sol:buy' : 'transfer_sol:sell',
      details: {
        strategy: this.strategyType,
        decisionId: decision.id,
        destination: this.targetAddress,
        amountSol: amount,
        price: decision.marketConditions.price,
        confidence: decision.confidence,
      },
      result: {
        id: uuidv4(),
        signature,
        status: 'confirmed',
        slot: 0,
        blockTime: null,
        fee: 0,
        error: null,
        logs: [],
        duration: 0,
      },
    };

    return action;
  }

  // ── Public Setters ──────────────────────────────────────────────────────────

  /** Update the destination address for trades (e.g. for agent-to-agent wiring). */
  setTargetAddress(address: string): void {
    this.targetAddress = address;
  }

  // ── Policy Engine Integration ──────────────────────────────────────────────

  /** Estimate transaction params so the policy engine can validate before execution. */
  protected estimateTransactionParams(
    decision: AgentDecision,
  ): TransactionValidationParams | null {
    if (decision.action === 'hold') return null;

    const balance = (decision.marketConditions.balance as number) ?? 0;
    const amount = Math.min(this.maxTradeAmount, balance * MAX_TRADE_BALANCE_FRACTION);

    return {
      amountSol: amount,
      programId: DEVNET_FALLBACK_ADDRESS, // System Program (SOL transfer)
      destination: this.targetAddress,
    };
  }

  // ── OODA Phase 4 — Evaluate ───────────────────────────────────────────────

  /**
   * Update performance metrics based on the executed action outcome.
   * Volume is accumulated from confirmed transfers; successful/failed
   * transaction counters are incremented accordingly.
   */
  protected async evaluate(
    action: AgentAction | null,
    decision: AgentDecision,
  ): Promise<void> {
    if (action === null) {
      // Nothing was executed — log the skipped decision and return early.
      console.log(
        `[${this.config.name}] Decision ${decision.id} not executed. ` +
        `Action: ${decision.action}, Confidence: ${decision.confidence.toFixed(2)}.`,
      );
      return;
    }

    const amountSol = action.details.amountSol as number;
    const confirmed = action.result?.status === 'confirmed';

    // Accumulate trade volume. Transaction counters (successful/failed) are
    // handled by BaseAgent.wireWalletEvents() — do NOT increment here to
    // avoid double-counting.
    this.performance.totalVolumeSol += amountSol;

    console.log(
      `[${this.config.name}] Decision ${decision.id} evaluated. ` +
      `Action: ${decision.action}, Amount: ${amountSol.toFixed(6)} SOL, ` +
      `Confirmed: ${confirmed}, ` +
      `Signature: ${action.result?.signature ?? 'N/A'}, ` +
      `Total volume: ${this.performance.totalVolumeSol.toFixed(6)} SOL.`,
    );
  }
}
