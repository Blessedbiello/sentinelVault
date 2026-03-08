// SentinelVault — TradingAgent
// Concrete OODA agent implementing three autonomous trading strategies over a
// simulated price feed: Dollar-Cost Averaging (dca), momentum, and
// mean_reversion. All real-money exposure is capped to 0.01 SOL per trade for
// devnet safety.

import { v4 as uuidv4 } from 'uuid';
import { BaseAgent } from './base-agent';
import { AgentConfig, AgentDecision, AgentAction } from '../types';
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

  private readonly targetAddress: string;
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

  // ── OODA Phase 2 — Analyze ────────────────────────────────────────────────

  /**
   * Apply the configured strategy to the latest observations and produce a
   * structured AgentDecision.  Short-circuit: if priceHistory is empty the
   * decision defaults to 'hold' with minimal confidence.
   */
  protected async analyze(observations: Record<string, unknown>): Promise<AgentDecision> {
    const obs = observations as unknown as TradingObservations;
    const { price, timestamp, balance } = obs;

    const sma20 = this.sma(SMA_SHORT_PERIOD);
    const sma50 = this.sma(SMA_LONG_PERIOD);

    let action: 'buy' | 'sell' | 'hold';
    let confidence: number;
    let reasoning: string;

    switch (this.strategyType) {
      case 'dca': {
        // Dollar-Cost Averaging: buy unconditionally on every cycle.
        action = 'buy';
        confidence = DCA_CONFIDENCE;
        reasoning =
          `DCA strategy: accumulate regardless of market direction. ` +
          `Current price: ${price.toFixed(4)} SOL.`;
        break;
      }

      case 'momentum': {
        // Trend-following: compare short SMA to long SMA.
        if (sma20 > sma50 && price > sma20) {
          action = 'buy';
          confidence = MOMENTUM_CONFIDENCE;
          reasoning =
            `Momentum bullish: SMA${SMA_SHORT_PERIOD} (${sma20.toFixed(4)}) > ` +
            `SMA${SMA_LONG_PERIOD} (${sma50.toFixed(4)}) and price (${price.toFixed(4)}) ` +
            `is above the short-term average. Trend continuation expected.`;
        } else if (sma20 < sma50 && price < sma20) {
          action = 'sell';
          confidence = MOMENTUM_CONFIDENCE;
          reasoning =
            `Momentum bearish: SMA${SMA_SHORT_PERIOD} (${sma20.toFixed(4)}) < ` +
            `SMA${SMA_LONG_PERIOD} (${sma50.toFixed(4)}) and price (${price.toFixed(4)}) ` +
            `is below the short-term average. Downtrend continuation expected.`;
        } else {
          action = 'hold';
          confidence = HOLD_CONFIDENCE;
          reasoning =
            `Momentum indeterminate: SMAs are converging or price is between averages. ` +
            `SMA${SMA_SHORT_PERIOD}=${sma20.toFixed(4)}, SMA${SMA_LONG_PERIOD}=${sma50.toFixed(4)}, ` +
            `price=${price.toFixed(4)}. Holding position.`;
        }
        break;
      }

      case 'mean_reversion': {
        const buyLevel = this.basePrice * MEAN_REVERSION_BUY_THRESHOLD;
        const sellLevel = this.basePrice * MEAN_REVERSION_SELL_THRESHOLD;

        if (price < buyLevel) {
          // Confidence scales with how far below the buy level price has fallen.
          const deviation = (buyLevel - price) / this.basePrice;
          confidence = Math.min(0.95, 0.6 + deviation * 10);
          action = 'buy';
          reasoning =
            `Mean reversion: price (${price.toFixed(4)}) is ${(deviation * 100).toFixed(2)} % ` +
            `below the buy threshold (${buyLevel.toFixed(4)}). ` +
            `Expecting reversion toward base price ${this.basePrice.toFixed(4)}.`;
        } else if (price > sellLevel) {
          // Confidence scales with how far above the sell level price has risen.
          const deviation = (price - sellLevel) / this.basePrice;
          confidence = Math.min(0.95, 0.6 + deviation * 10);
          action = 'sell';
          reasoning =
            `Mean reversion: price (${price.toFixed(4)}) is ${(deviation * 100).toFixed(2)} % ` +
            `above the sell threshold (${sellLevel.toFixed(4)}). ` +
            `Expecting reversion toward base price ${this.basePrice.toFixed(4)}.`;
        } else {
          action = 'hold';
          confidence = HOLD_CONFIDENCE;
          reasoning =
            `Mean reversion: price (${price.toFixed(4)}) is within the neutral zone ` +
            `[${buyLevel.toFixed(4)}, ${sellLevel.toFixed(4)}]. No edge present — holding.`;
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
      },
      analysis: `Strategy: ${this.strategyType} | Price: ${price.toFixed(4)} | ` +
        `SMA20: ${sma20.toFixed(4)} | SMA50: ${sma50.toFixed(4)} | ` +
        `Balance: ${balance.toFixed(6)} SOL`,
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

    // Accumulate trade volume regardless of confirmation status.
    this.performance.totalVolumeSol += amountSol;

    if (confirmed) {
      this.performance.successfulTransactions += 1;
    } else {
      this.performance.failedTransactions += 1;
    }

    // Recompute win rate from updated counters.
    const totalSettled =
      this.performance.successfulTransactions + this.performance.failedTransactions;
    this.performance.winRate =
      totalSettled > 0
        ? this.performance.successfulTransactions / totalSettled
        : 0;

    console.log(
      `[${this.config.name}] Decision ${decision.id} evaluated. ` +
      `Action: ${decision.action}, Amount: ${amountSol.toFixed(6)} SOL, ` +
      `Confirmed: ${confirmed}, ` +
      `Signature: ${action.result?.signature ?? 'N/A'}, ` +
      `Total volume: ${this.performance.totalVolumeSol.toFixed(6)} SOL, ` +
      `Win rate: ${(this.performance.winRate * 100).toFixed(1)} %.`,
    );
  }
}
