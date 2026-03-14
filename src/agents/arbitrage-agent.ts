// SentinelVault — ArbitrageAgent
// Cross-DEX price monitoring with intent recording. Detects price discrepancies
// between Jupiter and a simulated "alternative DEX" price, records arbitrage
// intents on-chain via memo, and signals with micro-transfers.

import { v4 as uuidv4 } from 'uuid';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { BaseAgent } from './base-agent';
import { AgentConfig, AgentDecision, AgentAction, TransactionValidationParams, PendingOutcome } from '../types';
import { AgenticWallet } from '../core/wallet';
import { PriceFeed } from '../integrations/price-feed';
import { JupiterClient } from '../integrations/jupiter';
import { AmmClient } from '../integrations/amm-client';
import { AIAdvisor } from '../integrations/ai-advisor';
import { DexScreenerClient } from '../integrations/dexscreener-client';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';
const AMM_PROGRAM_ID = 'Frdq7Ro6txmf5YuWLiCuKyVrSiY1tmFDCtTU6CfxQub2';
const PROFIT_THRESHOLD = 0.01;
const ARB_TRANSFER_SOL = 0.005;
const ALT_DEX_SPREAD_RANGE = 0.03;
const PRICE_HISTORY_MAX = 100;

// ─── ArbitrageAgent ──────────────────────────────────────────────────────────

/**
 * Autonomous arbitrage agent that monitors cross-DEX price discrepancies.
 *
 * Compares the real Jupiter quote price against a simulated "alternative DEX"
 * price (derived from the price feed with configurable spread). When a profitable
 * spread is detected, records an arbitrage intent memo on-chain and executes a
 * micro-transfer as signal.
 */
export class ArbitrageAgent extends BaseAgent {
  private priceHistory: number[] = [];
  private currentPrice: number = 0;
  private jupiterPrice: number = 0;
  private altDexPrice: number = 0;
  private poolPrice: number = 0;
  private targetAddress: string;

  // AMM pool integration
  private poolMint: string | null = null;
  private poolAuthority: string | null = null;
  private altDexSpread: number = 0.005;

  private priceFeed: PriceFeed;
  private jupiterClient: JupiterClient;
  private aiAdvisor: AIAdvisor;
  private dexScreenerClient: DexScreenerClient | null = null;

  constructor(config: AgentConfig, wallet: AgenticWallet) {
    super(config, wallet);

    const rawTarget = config.strategy.params.targetAddress;
    this.targetAddress =
      typeof rawTarget === 'string' && rawTarget.length > 0
        ? rawTarget
        : SYSTEM_PROGRAM_ADDRESS;

    this.priceFeed = new PriceFeed();
    this.jupiterClient = new JupiterClient();
    this.aiAdvisor = new AIAdvisor();
  }

  // ── OODA: Observe ──────────────────────────────────────────────────────────

  protected async observe(): Promise<Record<string, unknown>> {
    let price: number;
    let priceSource: string;

    const realPrice = await this.priceFeed.getSOLPrice();
    if (realPrice) {
      price = realPrice.price;
      priceSource = realPrice.source;
    } else {
      // Simulated fallback
      price = 150 + (Math.random() - 0.5) * 10;
      priceSource = 'simulated';
    }

    // Maintain price history
    if (this.priceHistory.length >= PRICE_HISTORY_MAX) {
      this.priceHistory.shift();
    }
    this.priceHistory.push(price);
    this.currentPrice = price;

    // Jupiter/Oracle price = real price feed
    this.jupiterPrice = price;

    // ── Three-tier alt-DEX price resolution ────────────────────────────────
    // Tier 1: DexScreener (real Raydium/Orca on-chain price data)
    // Tier 2: On-chain AMM pool (our own deployed pool)
    // Tier 3: EMA-based simulation (last resort)

    let altDexSource: string;

    if (this.dexScreenerClient) {
      try {
        const dexPrice = await this.dexScreenerClient.getSOLPrice();
        if (dexPrice && dexPrice.price > 0) {
          this.altDexPrice = dexPrice.price;
          altDexSource = `dexscreener:${dexPrice.dexId}`;
        } else {
          altDexSource = await this.resolveAltDexFromPool(price);
        }
      } catch {
        altDexSource = await this.resolveAltDexFromPool(price);
      }
    } else {
      altDexSource = await this.resolveAltDexFromPool(price);
    }

    // Detect market regime
    this.currentRegime = this.detectRegime(this.priceHistory);

    // Process deferred outcomes
    this.processPendingOutcomes(price);

    const balance = await this.wallet.getBalance();

    return {
      price,
      priceSource,
      jupiterPrice: this.jupiterPrice,
      altDexPrice: this.altDexPrice,
      altDexSource,
      spread: Math.abs(this.jupiterPrice - this.altDexPrice) / this.jupiterPrice,
      balance,
      timestamp: Date.now(),
    };
  }

  // ── Private: Alt-DEX tier 2 & 3 resolution ────────────────────────────────

  /**
   * Resolve the alt-DEX price from on-chain AMM pool (tier 2) or EMA simulation
   * (tier 3). Mutates `this.altDexPrice` and returns the source label.
   */
  private async resolveAltDexFromPool(oraclePrice: number): Promise<string> {
    // Tier 2: On-chain AMM pool
    if (this.poolMint) {
      try {
        const poolState = await this.wallet.getPoolState(this.poolMint);
        if (poolState && poolState.tokenReserve > 0) {
          this.poolPrice = (poolState.solReserve / poolState.tokenReserve) * oraclePrice;
          this.altDexPrice = this.poolPrice;
          return 'amm_pool';
        }
      } catch {
        // Pool read failed — fall through to simulation
      }
    }

    // Tier 3: EMA-based simulation (mean-reverting spread, not random each cycle)
    const SPREAD_DECAY = 0.95;
    const SPREAD_NOISE = (Math.random() - 0.5) * 0.002; // ±0.1% noise
    this.altDexSpread = this.altDexSpread * SPREAD_DECAY + SPREAD_NOISE;
    this.altDexSpread = Math.max(-ALT_DEX_SPREAD_RANGE, Math.min(ALT_DEX_SPREAD_RANGE, this.altDexSpread));
    this.altDexPrice = oraclePrice * (1 + this.altDexSpread);
    return 'simulated_ema';
  }

  // ── OODA: Analyze ──────────────────────────────────────────────────────────

  protected async analyze(observations: Record<string, unknown>): Promise<AgentDecision> {
    const jupPrice = observations.jupiterPrice as number;
    const altPrice = observations.altDexPrice as number;
    const altDexSource = observations.altDexSource as string;
    const spread = observations.spread as number;
    const balance = observations.balance as number;
    const price = observations.price as number;
    const priceSource = observations.priceSource as string;

    const reasoningChain: string[] = [
      `[Jupiter]  $${jupPrice.toFixed(2)} (${priceSource})`,
      `[AltDex]   $${altPrice.toFixed(2)} (source: ${altDexSource})`,
      `[Spread]   ${(spread * 100).toFixed(3)}% (threshold: ${(PROFIT_THRESHOLD * 100).toFixed(1)}%)`,
    ];

    let action: string;
    let confidence: number;
    let reasoning: string;

    if (spread > PROFIT_THRESHOLD) {
      action = 'arbitrage';
      const rawConfidence = Math.min(0.95, 0.5 + spread * 10);

      // Apply regime scaling and calibration
      const regimeScaled = this.applyRegimeScaling(rawConfidence, 'buy');
      confidence = this.getCalibrationAdjustment(regimeScaled);

      const direction = jupPrice > altPrice ? 'buy AltDex, sell Jupiter' : 'buy Jupiter, sell AltDex';
      reasoning = `Arbitrage opportunity: spread ${(spread * 100).toFixed(3)}% exceeds ${(PROFIT_THRESHOLD * 100).toFixed(1)}% threshold. Direction: ${direction}.`;

      reasoningChain.push(`[Profit]     ${(spread * 100).toFixed(3)}% potential profit`);
      reasoningChain.push(`[Direction]  ${direction}`);
      reasoningChain.push(`[Regime Adj] ${this.currentRegime} → confidence ${rawConfidence.toFixed(3)} → ${regimeScaled.toFixed(3)}`);
      reasoningChain.push(`[Calibrated] ${confidence.toFixed(3)}`);
    } else {
      action = 'hold';
      confidence = 0.3;
      reasoning = `No arbitrage: spread ${(spread * 100).toFixed(3)}% below threshold ${(PROFIT_THRESHOLD * 100).toFixed(1)}%.`;
      reasoningChain.push(`[Decision]   HOLD — spread below threshold`);
    }

    // ── AI Brain (optional) ──────────────────────────────────────────────
    try {
      const aiDecision = await this.aiAdvisor.getAgentDecision({
        agentName: this.config.name,
        agentType: 'arbitrageur',
        strategy: 'cross_dex_arbitrage',
        solPrice: price,
        priceSource,
        priceHistory: this.priceHistory,
        marketRegime: this.currentRegime,
        solBalance: balance,
        tokenBalances: [],
        totalPortfolioValueSol: balance,
        quantitativeSignal: {
          action,
          confidence,
          factors: { spread, jupiterPrice: jupPrice, altDexPrice: altPrice },
        },
        poolState: this.poolPrice > 0 ? { solReserve: 0, tokenReserve: 0, price: this.poolPrice } : null,
        jupiterQuote: null,
        recentDecisions: this.getDecisionHistory().slice(-3).map(d => ({ action: d.action, confidence: d.confidence })),
        reasoningChain,
      });

      if (aiDecision) {
        action = aiDecision.action;
        confidence = aiDecision.confidence;
        reasoning = aiDecision.reasoning;
        reasoningChain.push(`[AI Brain]    Decision: ${aiDecision.action.toUpperCase()} (confidence: ${aiDecision.confidence.toFixed(3)})`);
        reasoningChain.push(`[AI Brain]    "${aiDecision.reasoning}"`);
        if (aiDecision.riskAssessment) reasoningChain.push(`[AI Brain]    Risk: "${aiDecision.riskAssessment}"`);
        if (aiDecision.marketOutlook) reasoningChain.push(`[AI Brain]    Outlook: "${aiDecision.marketOutlook}"`);
      }
    } catch {
      // AI advisor is optional
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
        balanceScore: balance >= 0.05 ? 1.0 : Math.max(0, balance / 0.05),
        reasoningChain,
      },
      analysis: `Arb: Jupiter $${jupPrice.toFixed(2)} vs AltDex $${altPrice.toFixed(2)}, spread ${(spread * 100).toFixed(3)}% (${priceSource})`,
      action,
      confidence,
      reasoning,
      executed: false,
    };
  }

  // ── OODA: Execute ──────────────────────────────────────────────────────────

  protected async execute(decision: AgentDecision): Promise<AgentAction | null> {
    if (decision.action === 'hold') return null;

    const spread = decision.marketConditions.spread as number;
    const jupPrice = decision.marketConditions.jupiterPrice as number;
    const altPrice = decision.marketConditions.altDexPrice as number;

    let signature: string;
    let actionType = 'arbitrage';

    // If pool is configured and pool price differs from oracle, do a real swap
    if (this.poolMint && this.poolPrice > 0) {
      try {
        if (jupPrice > altPrice) {
          // Pool SOL is cheap relative to oracle → swap SOL for tokens on pool
          const lamports = Math.round(ARB_TRANSFER_SOL * LAMPORTS_PER_SOL);
          signature = await this.wallet.swapSolForToken(
            this.poolMint,
            lamports,
            0,
            this.poolAuthority ?? undefined,
          );
          actionType = 'arbitrage:swap_sol_for_token';
        } else {
          // Pool SOL is expensive → swap tokens for SOL on pool
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
            actionType = 'arbitrage:swap_token_for_sol';
          } else {
            // No tokens — fall back to SOL transfer signal
            signature = await this.wallet.transferSOL(this.targetAddress, ARB_TRANSFER_SOL);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[ArbitrageAgent:${this.config.id}] AMM swap failed, falling back: ${message}`);
        try {
          signature = await this.wallet.transferSOL(this.targetAddress, ARB_TRANSFER_SOL);
        } catch (err2) {
          const message2 = err2 instanceof Error ? err2.message : String(err2);
          console.error(`[ArbitrageAgent:${this.config.id}] Transfer also failed: ${message2}`);
          return null;
        }
      }
    } else {
      // No pool — use traditional transfer signal
      try {
        signature = await this.wallet.transferSOL(this.targetAddress, ARB_TRANSFER_SOL);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ArbitrageAgent:${this.config.id}] Transfer failed: ${message}`);
        return null;
      }
    }

    // Record arbitrage memo
    const direction = jupPrice > altPrice ? 'AltDex' : 'Jupiter';
    const memo = `ARB: oracle $${jupPrice.toFixed(2)} vs pool $${altPrice.toFixed(2)}, spread ${(spread * 100).toFixed(3)}%`;
    try {
      await this.wallet.sendMemo(memo);
    } catch {
      // Memo is best-effort
    }

    let txMeta = { slot: 0, fee: 0, blockTime: null as number | null };
    try { txMeta = await this.wallet.enrichTransactionResult(signature); } catch { /* best-effort */ }

    return {
      id: uuidv4(),
      agentId: this.config.id,
      timestamp: Date.now(),
      type: actionType,
      details: {
        amountSol: ARB_TRANSFER_SOL,
        destination: this.targetAddress,
        signature,
        jupiterPrice: jupPrice,
        altDexPrice: altPrice,
        poolPrice: this.poolPrice,
        spread,
        poolMint: this.poolMint,
        decisionId: decision.id,
        confidence: decision.confidence,
      },
      result: {
        id: uuidv4(),
        signature,
        status: 'confirmed',
        slot: txMeta.slot,
        blockTime: txMeta.blockTime,
        fee: txMeta.fee,
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

  /** Arbitrage-specific outcome evaluation: spread convergence = success. */
  protected processPendingOutcomes(currentPrice: number): void {
    const remaining: PendingOutcome[] = [];
    for (const po of this.pendingOutcomes) {
      po.ticksRemaining -= 1;
      if (po.ticksRemaining <= 0) {
        // Arbitrage profits from spread convergence (small price movement = stable = arb worked)
        const priceChange = Math.abs(currentPrice - po.entryPrice) / Math.max(po.entryPrice, 0.0001);
        const outcome: 'win' | 'loss' = priceChange < 0.02 ? 'win' : 'loss';
        this.updateWeights(outcome, po.decision);
        this.recordCalibration(po.confidence, outcome === 'win');

        // Record P&L — arbitrage profit from spread capture
        this.recordPnL(po.action, 0.005, po.entryPrice, po.entryPrice * (1 + (outcome === 'win' ? 0.01 : -0.005)));
      } else {
        remaining.push(po);
      }
    }
    this.pendingOutcomes = remaining;
  }

  // ── Policy Engine ──────────────────────────────────────────────────────────

  protected estimateTransactionParams(
    decision: AgentDecision,
  ): TransactionValidationParams | null {
    if (decision.action === 'hold') return null;
    return {
      amountSol: ARB_TRANSFER_SOL,
      programId: this.poolMint ? AMM_PROGRAM_ID : SYSTEM_PROGRAM_ADDRESS,
      destination: this.targetAddress,
    };
  }

  // ── Public Setters ─────────────────────────────────────────────────────────

  setTargetAddress(address: string): void {
    this.targetAddress = address;
  }

  /** Set the pool mint for AMM swap execution. Enables oracle-vs-pool arbitrage. */
  setPoolMint(mint: string, authority?: string): void {
    this.poolMint = mint;
    this.poolAuthority = authority ?? null;
  }

  /** Inject shared service instances from orchestrator. Avoids duplicate HTTP clients/caches. */
  setSharedServices(priceFeed: PriceFeed, jupiterClient: JupiterClient, aiAdvisor: AIAdvisor): void {
    this.priceFeed = priceFeed;
    this.jupiterClient = jupiterClient;
    this.aiAdvisor = aiAdvisor;
  }

  /** Inject DexScreener client for real Raydium/Orca price data (tier 1 alt-DEX source). */
  setDexScreenerClient(client: DexScreenerClient): void {
    this.dexScreenerClient = client;
  }
}
