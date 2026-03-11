// SentinelVault — PortfolioAgent
// Multi-asset portfolio rebalancing agent. Tracks a target allocation
// (default 60% SOL, 40% tokens) and rebalances when drift exceeds a
// configurable threshold via micro-transfers and on-chain memo signals.

import { v4 as uuidv4 } from 'uuid';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { BaseAgent } from './base-agent';
import { AgentConfig, AgentDecision, AgentAction, TransactionValidationParams } from '../types';
import { AgenticWallet } from '../core/wallet';
import { PriceFeed } from '../integrations/price-feed';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';
const REBALANCE_THRESHOLD = 0.10;
const REBALANCE_TRANSFER_SOL = 0.005;
const PRICE_HISTORY_MAX = 100;

interface TargetAllocation {
  sol: number;
  tokens: number;
}

const DEFAULT_TARGET_ALLOCATION: TargetAllocation = { sol: 0.6, tokens: 0.4 };

// ─── PortfolioAgent ──────────────────────────────────────────────────────────

/**
 * Autonomous portfolio rebalancing agent.
 *
 * Tracks a target allocation (e.g. 60% SOL, 40% tokens) and monitors the
 * current portfolio composition. When the drift between current and target
 * allocation exceeds a threshold, executes a rebalance signal via micro-transfer
 * and records the intent on-chain via memo.
 */
export class PortfolioAgent extends BaseAgent {
  private priceHistory: number[] = [];
  private currentPrice: number = 0;
  private targetAllocation: TargetAllocation;
  private currentAllocation: TargetAllocation = { sol: 1.0, tokens: 0.0 };
  private drift: number = 0;
  private totalValueSol: number = 0;
  private rebalanceCount: number = 0;
  private targetAddress: string;

  // AMM pool integration
  private poolMint: string | null = null;
  private poolAuthority: string | null = null;

  private readonly priceFeed: PriceFeed;

  constructor(config: AgentConfig, wallet: AgenticWallet) {
    super(config, wallet);

    const rawTarget = config.strategy.params.targetAddress;
    this.targetAddress =
      typeof rawTarget === 'string' && rawTarget.length > 0
        ? rawTarget
        : SYSTEM_PROGRAM_ADDRESS;

    // Allow custom target allocation from strategy params
    const rawAlloc = config.strategy.params.targetAllocation;
    if (rawAlloc && typeof rawAlloc === 'object' && 'sol' in (rawAlloc as object)) {
      this.targetAllocation = rawAlloc as TargetAllocation;
    } else {
      this.targetAllocation = { ...DEFAULT_TARGET_ALLOCATION };
    }

    this.priceFeed = new PriceFeed();
  }

  // ── OODA: Observe ──────────────────────────────────────────────────────────

  protected async observe(): Promise<Record<string, unknown>> {
    // Fetch price for regime detection
    let price: number;
    const realPrice = await this.priceFeed.getSOLPrice();
    if (realPrice) {
      price = realPrice.price;
    } else {
      price = 150 + (Math.random() - 0.5) * 10;
    }

    if (this.priceHistory.length >= PRICE_HISTORY_MAX) {
      this.priceHistory.shift();
    }
    this.priceHistory.push(price);
    this.currentPrice = price;

    // Detect market regime
    this.currentRegime = this.detectRegime(this.priceHistory);

    // Process deferred outcomes
    this.processPendingOutcomes(price);

    // Fetch wallet SOL balance
    let solBalance: number;
    try {
      solBalance = await this.wallet.getBalance();
    } catch {
      solBalance = this.wallet.getState()?.balanceSol ?? 0;
    }

    // Fetch token balances
    let tokenValueSol = 0;
    try {
      const tokenBalances = await this.wallet.getTokenBalances();
      // Estimate token value in SOL terms (simplified: sum of raw balances as SOL equivalent)
      for (const tb of tokenBalances) {
        tokenValueSol += tb.balance * 0.001; // Simplified conversion
      }
    } catch {
      // No tokens or method unavailable
    }

    // Compute total portfolio value and allocation
    this.totalValueSol = solBalance + tokenValueSol;
    if (this.totalValueSol > 0) {
      this.currentAllocation = {
        sol: solBalance / this.totalValueSol,
        tokens: tokenValueSol / this.totalValueSol,
      };
    } else {
      this.currentAllocation = { sol: 1.0, tokens: 0.0 };
    }

    // Compute drift
    this.drift = Math.abs(this.currentAllocation.sol - this.targetAllocation.sol);

    return {
      solBalance,
      tokenValueSol,
      totalValueSol: this.totalValueSol,
      currentAllocation: { ...this.currentAllocation },
      targetAllocation: { ...this.targetAllocation },
      drift: this.drift,
      price,
      timestamp: Date.now(),
    };
  }

  // ── OODA: Analyze ──────────────────────────────────────────────────────────

  protected async analyze(observations: Record<string, unknown>): Promise<AgentDecision> {
    const drift = observations.drift as number;
    const currentAlloc = observations.currentAllocation as TargetAllocation;
    const targetAlloc = observations.targetAllocation as TargetAllocation;
    const solBalance = observations.solBalance as number;

    const reasoningChain: string[] = [
      `[Portfolio]  SOL=${(currentAlloc.sol * 100).toFixed(1)}% Tokens=${(currentAlloc.tokens * 100).toFixed(1)}%`,
      `[Target]     SOL=${(targetAlloc.sol * 100).toFixed(1)}% Tokens=${(targetAlloc.tokens * 100).toFixed(1)}%`,
      `[Drift]      ${(drift * 100).toFixed(1)}% (threshold: ${(REBALANCE_THRESHOLD * 100).toFixed(1)}%)`,
    ];

    let action: string;
    let confidence: number;
    let reasoning: string;

    if (drift > REBALANCE_THRESHOLD) {
      const rawConfidence = Math.min(0.95, 0.5 + drift * 3);

      // Apply regime scaling and calibration
      const regimeScaled = this.applyRegimeScaling(rawConfidence, 'rebalance');
      confidence = this.getCalibrationAdjustment(regimeScaled);

      if (currentAlloc.sol > targetAlloc.sol) {
        action = 'rebalance_to_tokens';
        reasoning = `SOL overweight: current ${(currentAlloc.sol * 100).toFixed(1)}% vs target ${(targetAlloc.sol * 100).toFixed(1)}%. Drift ${(drift * 100).toFixed(1)}% exceeds ${(REBALANCE_THRESHOLD * 100).toFixed(1)}% threshold.`;
        reasoningChain.push(`[Action]     Rebalance to tokens — SOL overweight`);
      } else {
        action = 'rebalance_to_sol';
        reasoning = `Tokens overweight: current SOL ${(currentAlloc.sol * 100).toFixed(1)}% vs target ${(targetAlloc.sol * 100).toFixed(1)}%. Drift ${(drift * 100).toFixed(1)}% exceeds ${(REBALANCE_THRESHOLD * 100).toFixed(1)}% threshold.`;
        reasoningChain.push(`[Action]     Rebalance to SOL — tokens overweight`);
      }

      reasoningChain.push(`[Regime Adj] ${this.currentRegime} → confidence ${rawConfidence.toFixed(3)} → ${regimeScaled.toFixed(3)}`);
      reasoningChain.push(`[Calibrated] ${confidence.toFixed(3)}`);
    } else {
      action = 'hold';
      confidence = 0.3;
      reasoning = `Portfolio within tolerance: drift ${(drift * 100).toFixed(1)}% below ${(REBALANCE_THRESHOLD * 100).toFixed(1)}% threshold.`;
      reasoningChain.push(`[Decision]   HOLD — drift within tolerance`);
    }

    return {
      id: uuidv4(),
      agentId: this.config.id,
      timestamp: Date.now(),
      marketConditions: {
        ...observations,
        trendScore: 0.5,
        momentumScore: 0.5,
        volatilityScore: 0.5,
        balanceScore: solBalance >= 0.05 ? 1.0 : Math.max(0, solBalance / 0.05),
        reasoningChain,
      },
      analysis: `Portfolio: SOL ${(currentAlloc.sol * 100).toFixed(1)}%/${(targetAlloc.sol * 100).toFixed(1)}% target, drift ${(drift * 100).toFixed(1)}%`,
      action,
      confidence,
      reasoning,
      executed: false,
    };
  }

  // ── OODA: Execute ──────────────────────────────────────────────────────────

  protected async execute(decision: AgentDecision): Promise<AgentAction | null> {
    if (decision.action === 'hold') return null;

    const currentAlloc = decision.marketConditions.currentAllocation as TargetAllocation;
    const targetAlloc = decision.marketConditions.targetAllocation as TargetAllocation;
    const drift = decision.marketConditions.drift as number;

    let signature: string;
    let actionType = decision.action;

    // Use AMM swaps for rebalancing when pool is configured
    if (this.poolMint && decision.action === 'rebalance_to_tokens') {
      try {
        const lamports = Math.round(REBALANCE_TRANSFER_SOL * LAMPORTS_PER_SOL);
        signature = await this.wallet.swapSolForToken(
          this.poolMint,
          lamports,
          0,
          this.poolAuthority ?? undefined,
        );
        actionType = 'rebalance:swap_sol_for_token';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[PortfolioAgent:${this.config.id}] AMM swap failed, falling back: ${message}`);
        try {
          signature = await this.wallet.transferSOL(this.targetAddress, REBALANCE_TRANSFER_SOL);
        } catch (err2) {
          const message2 = err2 instanceof Error ? err2.message : String(err2);
          console.error(`[PortfolioAgent:${this.config.id}] Transfer also failed: ${message2}`);
          return null;
        }
      }
    } else if (this.poolMint && decision.action === 'rebalance_to_sol') {
      try {
        const tokenBalances = await this.wallet.getTokenBalances();
        const tokenBalance = tokenBalances.find(tb => tb.mint === this.poolMint);
        const tokenAmount = tokenBalance ? Math.floor(tokenBalance.balance * 0.05) : 0;

        if (tokenAmount > 0) {
          signature = await this.wallet.swapTokenForSol(
            this.poolMint,
            tokenAmount,
            0,
            this.poolAuthority ?? undefined,
          );
          actionType = 'rebalance:swap_token_for_sol';
        } else {
          signature = await this.wallet.transferSOL(this.targetAddress, REBALANCE_TRANSFER_SOL);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[PortfolioAgent:${this.config.id}] AMM swap failed, falling back: ${message}`);
        try {
          signature = await this.wallet.transferSOL(this.targetAddress, REBALANCE_TRANSFER_SOL);
        } catch (err2) {
          const message2 = err2 instanceof Error ? err2.message : String(err2);
          console.error(`[PortfolioAgent:${this.config.id}] Transfer also failed: ${message2}`);
          return null;
        }
      }
    } else {
      try {
        signature = await this.wallet.transferSOL(this.targetAddress, REBALANCE_TRANSFER_SOL);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[PortfolioAgent:${this.config.id}] Transfer failed: ${message}`);
        return null;
      }
    }

    // Record rebalance memo
    const memo = `REBAL: drift ${(drift * 100).toFixed(1)}%, swapping to target ${(targetAlloc.sol * 100).toFixed(0)}/${(targetAlloc.tokens * 100).toFixed(0)}`;
    try {
      await this.wallet.sendMemo(memo);
    } catch {
      // Memo is best-effort
    }

    this.rebalanceCount++;

    return {
      id: uuidv4(),
      agentId: this.config.id,
      timestamp: Date.now(),
      type: actionType,
      details: {
        amountSol: REBALANCE_TRANSFER_SOL,
        destination: this.targetAddress,
        signature,
        currentAllocation: currentAlloc,
        targetAllocation: targetAlloc,
        drift,
        rebalanceCount: this.rebalanceCount,
        poolMint: this.poolMint,
        decisionId: decision.id,
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
  }

  // ── OODA: Evaluate ─────────────────────────────────────────────────────────

  protected async evaluate(
    action: AgentAction | null,
    decision: AgentDecision,
  ): Promise<void> {
    if (action === null) return;

    const amountSol = action.details.amountSol as number;
    this.performance.totalVolumeSol += amountSol;

    // Queue pending outcome for deferred evaluation
    this.queuePendingOutcome(decision, this.currentPrice);
  }

  // ── Policy Engine ──────────────────────────────────────────────────────────

  protected estimateTransactionParams(
    decision: AgentDecision,
  ): TransactionValidationParams | null {
    if (decision.action === 'hold') return null;
    return {
      amountSol: REBALANCE_TRANSFER_SOL,
      programId: SYSTEM_PROGRAM_ADDRESS,
      destination: this.targetAddress,
    };
  }

  // ── Public Setters ─────────────────────────────────────────────────────────

  setTargetAddress(address: string): void {
    this.targetAddress = address;
  }

  /** Set the pool mint for AMM swap-based rebalancing. */
  setPoolMint(mint: string, authority?: string): void {
    this.poolMint = mint;
    this.poolAuthority = authority ?? null;
  }

  /** Return current portfolio state for dashboard use. */
  getPortfolioState(): { targetAllocation: TargetAllocation; currentAllocation: TargetAllocation; drift: number; totalValueSol: number; rebalanceCount: number } {
    return {
      targetAllocation: { ...this.targetAllocation },
      currentAllocation: { ...this.currentAllocation },
      drift: this.drift,
      totalValueSol: this.totalValueSol,
      rebalanceCount: this.rebalanceCount,
    };
  }
}
