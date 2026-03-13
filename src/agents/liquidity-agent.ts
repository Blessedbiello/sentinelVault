// SentinelVault — LiquidityAgent
// Simulated LP pool manager. Runs the OODA loop to monitor pool health and
// rebalance, add, or remove liquidity based on configurable thresholds.

import { v4 as uuidv4 } from 'uuid';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { BaseAgent } from './base-agent';
import { AgentConfig, AgentDecision, AgentAction, TransactionValidationParams, AgentDecisionContext, AIDecisionResult } from '../types';
import { AgenticWallet } from '../core/wallet';
import { AIAdvisor } from '../integrations/ai-advisor';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Solana System Program address used as a safe placeholder destination for
 * simulated transfers that represent pool management operations.
 */
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';
const AMM_PROGRAM_ID = 'Frdq7Ro6txmf5YuWLiCuKyVrSiY1tmFDCtTU6CfxQub2';

/** SOL amount sent for operations that require an on-chain signal. */
const REBALANCE_TRANSFER_SOL = 0.005;
const ADD_LIQUIDITY_TRANSFER_SOL = 0.005;

// ─── Decision thresholds ──────────────────────────────────────────────────────

const IMBALANCE_REBALANCE_THRESHOLD = 0.15;
const IMBALANCE_REMOVE_THRESHOLD = 0.10;
const APY_ADD_THRESHOLD = 10;
const APY_REMOVE_THRESHOLD = 3;
const UTILIZATION_ADD_CAP = 80;

// ─── Pool Dynamics ────────────────────────────────────────────────────────────

/** Daily fee accrual rate applied each simulated observation cycle. */
const FEE_ACCRUAL_RATE = 0.0001;

// ─── PoolState ────────────────────────────────────────────────────────────────

interface PoolState {
  /** SOL-side reserves. */
  tokenABalance: number;
  /** Paired simulated-token-side reserves. */
  tokenBBalance: number;
  /** Current SOL-denominated price of token B. */
  price: number;
  /** Total value locked in SOL. */
  tvl: number;
  /** Annual percentage yield. */
  apy: number;
  /** Percentage of reserves actively utilized (0–100). */
  utilization: number;
  /** Fractional pool imbalance (0 = perfectly balanced, 1 = fully one-sided). */
  imbalance: number;
  /** Cumulative fees earned in SOL since agent creation. */
  feesEarned: number;
}

// ─── LiquidityAgent ───────────────────────────────────────────────────────────

/**
 * Autonomous liquidity provider agent.
 *
 * Maintains an in-process simulation of an LP pool and drives OODA cycles to
 * decide when to rebalance, add liquidity, or remove liquidity. Rebalancing
 * and liquidity additions are signalled via small SOL micro-transfers; removals
 * are purely simulated because they involve receiving tokens rather than
 * sending them.
 */
export class LiquidityAgent extends BaseAgent {
  private pool: PoolState;
  private targetAddress: string;
  private poolMint: string | null = null;
  private poolAuthority: string | null = null;
  private aiAdvisor: AIAdvisor;

  constructor(config: AgentConfig, wallet: AgenticWallet) {
    super(config, wallet);
    this.aiAdvisor = new AIAdvisor();

    // Resolve destination address from strategy params, falling back to System Program.
    const rawTarget = config.strategy.params.targetAddress;
    this.targetAddress =
      typeof rawTarget === 'string' && rawTarget.length > 0
        ? rawTarget
        : SYSTEM_PROGRAM_ADDRESS;

    this.pool = {
      tokenABalance: 10,
      tokenBBalance: 10_000,
      price: 1.0,
      tvl: 20.0,
      apy: 8.0,
      utilization: 65,
      imbalance: 0.05,
      feesEarned: 0,
    };
  }

  // ── Pool Simulation ──────────────────────────────────────────────────────────

  /**
   * Apply small random fluctuations to APY, utilization, and imbalance to
   * simulate a live pool environment. Clamps all values to their valid ranges
   * and derives TVL from the current reserve balances and price.
   */
  private simulatePoolDynamics(): void {
    const rand = (magnitude: number): number =>
      (Math.random() * 2 - 1) * magnitude;

    this.pool.apy = clamp(this.pool.apy + rand(0.5), 0, 50);
    this.pool.utilization = clamp(this.pool.utilization + rand(5), 0, 100);
    this.pool.imbalance = clamp(this.pool.imbalance + rand(0.03), 0, 1);

    // TVL = SOL reserves + token reserves converted to SOL at current price
    this.pool.tvl =
      this.pool.tokenABalance + this.pool.tokenBBalance * this.pool.price;

    // Accrue a small fee each cycle
    this.pool.feesEarned += this.pool.tvl * FEE_ACCRUAL_RATE;
  }

  // ── OODA: Observe ────────────────────────────────────────────────────────────

  /**
   * Advance pool simulation by one step and capture a full observation snapshot
   * that includes pool state, wallet SOL balance, and a timestamp.
   */
  protected async observe(): Promise<Record<string, unknown>> {
    // Try real on-chain pool state when pool is configured
    let usedOnChain = false;
    if (this.poolMint) {
      try {
        const onChainState = await this.wallet.getPoolState(
          this.poolMint,
          this.poolAuthority ?? undefined,
        );
        if (onChainState && onChainState.solReserve > 0) {
          const solReserveSol = onChainState.solReserve / LAMPORTS_PER_SOL;
          const tokenReserve = onChainState.tokenReserve;
          const poolPrice = tokenReserve > 0 ? solReserveSol / tokenReserve : 0;

          this.pool.tokenABalance = solReserveSol;
          this.pool.tokenBBalance = tokenReserve;
          this.pool.price = poolPrice;
          this.pool.tvl = solReserveSol * 2; // approximate for constant-product
          this.pool.imbalance = this.pool.tvl > 0
            ? Math.abs(solReserveSol - tokenReserve * poolPrice) / this.pool.tvl
            : 0;
          usedOnChain = true;
        }
      } catch {
        // Pool read failed — fall back to simulation
      }
    }

    if (!usedOnChain) {
      this.simulatePoolDynamics();
    }

    let walletBalanceSol = 0;
    try {
      walletBalanceSol = await this.wallet.getBalance();
    } catch {
      walletBalanceSol = this.wallet.getState()?.balanceSol ?? 0;
    }

    return {
      tokenABalance: this.pool.tokenABalance,
      tokenBBalance: this.pool.tokenBBalance,
      price: this.pool.price,
      tvl: this.pool.tvl,
      apy: this.pool.apy,
      utilization: this.pool.utilization,
      imbalance: this.pool.imbalance,
      feesEarned: this.pool.feesEarned,
      walletBalanceSol,
      onChainPool: usedOnChain,
      timestamp: Date.now(),
    };
  }

  // ── OODA: Analyze ────────────────────────────────────────────────────────────

  /**
   * Evaluate the observation snapshot against decision thresholds and return
   * a typed AgentDecision. Priority order:
   *
   *  1. High imbalance (> 15%)     → rebalance
   *  2. High APY + low utilization → add_liquidity
   *  3. Moderate imbalance + low APY → remove_liquidity
   *  4. Default                    → hold
   */
  protected async analyze(observations: Record<string, unknown>): Promise<AgentDecision> {
    const imbalance = observations.imbalance as number;
    const apy = observations.apy as number;
    const utilization = observations.utilization as number;

    let action: string;
    let confidence: number;
    let analysis: string;
    let reasoning: string;

    if (imbalance > IMBALANCE_REBALANCE_THRESHOLD) {
      action = 'rebalance';
      confidence = 0.8;
      analysis = 'Pool imbalance exceeds rebalance threshold';
      reasoning =
        `Pool imbalance of ${(imbalance * 100).toFixed(1)}% is above the ` +
        `${(IMBALANCE_REBALANCE_THRESHOLD * 100).toFixed(0)}% threshold. ` +
        `Rebalancing reserves will reduce slippage and protect LP position.`;
    } else if (apy > APY_ADD_THRESHOLD && utilization < UTILIZATION_ADD_CAP) {
      action = 'add_liquidity';
      confidence = 0.7;
      analysis = 'Favourable yield and utilization conditions for liquidity addition';
      reasoning =
        `APY of ${apy.toFixed(2)}% exceeds the ${APY_ADD_THRESHOLD}% target and ` +
        `utilization (${utilization.toFixed(1)}%) is below the ` +
        `${UTILIZATION_ADD_CAP}% cap. Adding liquidity now maximises fee income.`;
    } else if (imbalance > IMBALANCE_REMOVE_THRESHOLD && apy < APY_REMOVE_THRESHOLD) {
      action = 'remove_liquidity';
      confidence = 0.75;
      analysis = 'Poor yield combined with elevated imbalance warrants liquidity withdrawal';
      reasoning =
        `APY has fallen to ${apy.toFixed(2)}% (below the ${APY_REMOVE_THRESHOLD}% floor) ` +
        `while imbalance is ${(imbalance * 100).toFixed(1)}%. Removing liquidity ` +
        `reduces impermanent loss exposure until conditions improve.`;
    } else {
      action = 'hold';
      confidence = 0.4;
      analysis = 'No actionable signal detected — maintaining current position';
      reasoning =
        `APY: ${apy.toFixed(2)}%, utilization: ${utilization.toFixed(1)}%, ` +
        `imbalance: ${(imbalance * 100).toFixed(1)}%. ` +
        `All metrics are within acceptable bounds.`;
    }

    // ── AI Brain Integration ──────────────────────────────────────────────
    const reasoningChain: string[] = [
      `[Pool]       TVL: ${(observations.tvl as number).toFixed(4)} SOL | APY: ${apy.toFixed(2)}% | Util: ${utilization.toFixed(1)}%`,
      `[Imbalance]  ${(imbalance * 100).toFixed(1)}% (threshold: ${(IMBALANCE_REBALANCE_THRESHOLD * 100).toFixed(0)}%)`,
      `[Quant]      ${action} @ confidence ${confidence.toFixed(3)}`,
    ];

    let aiDecision: AIDecisionResult | null = null;
    try {
      const walletBalance = observations.walletBalanceSol as number;
      const ctx: AgentDecisionContext = {
        agentName: this.config.name,
        agentType: 'liquidity_provider',
        strategy: this.config.strategy.type,
        solPrice: (observations.price as number) || 1.0,
        priceSource: (observations.onChainPool as boolean) ? 'on-chain pool' : 'simulated',
        priceHistory: [],
        marketRegime: this.currentRegime,
        solBalance: walletBalance,
        tokenBalances: [],
        totalPortfolioValueSol: walletBalance + (observations.tvl as number),
        quantitativeSignal: {
          action,
          confidence,
          factors: { imbalance, apy, utilization },
        },
        poolState: {
          solReserve: observations.tokenABalance as number,
          tokenReserve: observations.tokenBBalance as number,
          price: (observations.price as number) || 0,
        },
        jupiterQuote: null,
        recentDecisions: this.getDecisionHistory().slice(-3).map(d => ({
          action: d.action,
          confidence: d.confidence,
        })),
        reasoningChain,
      };

      aiDecision = await this.aiAdvisor.getAgentDecision(ctx);

      if (aiDecision) {
        const validActions = new Set(['buy', 'sell', 'hold', 'rebalance', 'add_liquidity', 'remove_liquidity']);
        if (validActions.has(aiDecision.action)) {
          action = aiDecision.action;
        }
        confidence = aiDecision.confidence;
        reasoning = aiDecision.reasoning;
        reasoningChain.push(`[AI Brain]   Decision: ${aiDecision.action.toUpperCase()} (confidence: ${aiDecision.confidence.toFixed(3)})`);
        reasoningChain.push(`[AI Brain]   "${aiDecision.reasoning}"`);
        reasoningChain.push(`[AI Brain]   Risk: "${aiDecision.riskAssessment}"`);
        reasoningChain.push(`[AI Brain]   Outlook: "${aiDecision.marketOutlook}"`);
      }
    } catch {
      // AI advisor is optional — fall through to quantitative decision
    }

    return {
      id: uuidv4(),
      agentId: this.config.id,
      timestamp: Date.now(),
      marketConditions: {
        ...observations,
        reasoningChain,
        aiDecision: aiDecision ?? null,
      },
      analysis,
      action,
      confidence,
      reasoning,
      executed: false,
    };
  }

  // ── OODA: Execute ────────────────────────────────────────────────────────────

  /**
   * Carry out the action prescribed by the decision:
   *
   * - `rebalance`        — transfer 0.005 SOL as an on-chain signal, then
   *                        halve the imbalance in the pool model.
   * - `add_liquidity`    — transfer 0.005 SOL as an on-chain signal, then
   *                        increase the SOL-side (tokenA) reserve.
   * - `remove_liquidity` — purely simulated: reduce reserves proportionally
   *                        (no outbound transaction because we'd be receiving).
   * - `hold`             — no operation; returns null.
   *
   * All on-chain transfers are wrapped in try/catch. A transfer failure logs
   * the error and returns null rather than propagating the exception.
   */
  protected async execute(decision: AgentDecision): Promise<AgentAction | null> {
    const actionType = decision.action;

    try {
      switch (actionType) {
        case 'rebalance': {
          let signature: string;
          let swapType = 'rebalance';

          if (this.poolMint) {
            // Real AMM rebalance: if pool is SOL-heavy, swap SOL for tokens
            try {
              const lamports = Math.round(REBALANCE_TRANSFER_SOL * LAMPORTS_PER_SOL);
              signature = await this.wallet.swapSolForToken(
                this.poolMint,
                lamports,
                0,
                this.poolAuthority ?? undefined,
              );
              swapType = 'rebalance:swap_sol_for_token';
            } catch {
              // Fall back to transferSOL
              signature = await this.wallet.transferSOL(
                this.targetAddress,
                REBALANCE_TRANSFER_SOL,
              );
              this.pool.imbalance = this.pool.imbalance * 0.5;
            }
          } else {
            signature = await this.wallet.transferSOL(
              this.targetAddress,
              REBALANCE_TRANSFER_SOL,
            );
            this.pool.imbalance = this.pool.imbalance * 0.5;
          }

          return {
            id: uuidv4(),
            agentId: this.config.id,
            timestamp: Date.now(),
            type: swapType,
            details: {
              amountSol: REBALANCE_TRANSFER_SOL,
              destination: this.targetAddress,
              signature,
              newImbalance: this.pool.imbalance,
              tvl: this.pool.tvl,
              poolMint: this.poolMint,
            },
          };
        }

        case 'add_liquidity': {
          let signature: string;
          let liquidityType = 'add_liquidity';

          if (this.poolMint) {
            // Execute a swap (since addLiquidity is authority-only)
            try {
              const lamports = Math.round(ADD_LIQUIDITY_TRANSFER_SOL * LAMPORTS_PER_SOL);
              signature = await this.wallet.swapSolForToken(
                this.poolMint,
                lamports,
                0,
                this.poolAuthority ?? undefined,
              );
              liquidityType = 'market_buy:providing_liquidity'; // addLiquidity() is authority-only; market buy provides passive liquidity
            } catch {
              signature = await this.wallet.transferSOL(
                this.targetAddress,
                ADD_LIQUIDITY_TRANSFER_SOL,
              );
              this.pool.tokenABalance += ADD_LIQUIDITY_TRANSFER_SOL;
            }
          } else {
            signature = await this.wallet.transferSOL(
              this.targetAddress,
              ADD_LIQUIDITY_TRANSFER_SOL,
            );
            this.pool.tokenABalance += ADD_LIQUIDITY_TRANSFER_SOL;
          }

          return {
            id: uuidv4(),
            agentId: this.config.id,
            timestamp: Date.now(),
            type: liquidityType,
            details: {
              amountSol: ADD_LIQUIDITY_TRANSFER_SOL,
              destination: this.targetAddress,
              signature,
              newTokenABalance: this.pool.tokenABalance,
              tvl: this.pool.tvl,
              poolMint: this.poolMint,
            },
          };
        }

        case 'remove_liquidity': {
          // Withdrawal is simulated only — we receive tokens, so no outbound tx.
          const removedA = this.pool.tokenABalance * 0.1;
          const removedB = this.pool.tokenBBalance * 0.1;
          this.pool.tokenABalance -= removedA;
          this.pool.tokenBBalance -= removedB;

          return {
            id: uuidv4(),
            agentId: this.config.id,
            timestamp: Date.now(),
            type: 'remove_liquidity',
            details: {
              removedTokenA: removedA,
              removedTokenB: removedB,
              newTokenABalance: this.pool.tokenABalance,
              newTokenBBalance: this.pool.tokenBBalance,
              tvl: this.pool.tvl,
              simulated: true,
            },
          };
        }

        case 'hold':
        default:
          return null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[LiquidityAgent:${this.config.id}] execute failed for action "${actionType}": ${message}`,
      );
      return null;
    }
  }

  // ── OODA: Evaluate ───────────────────────────────────────────────────────────

  /**
   * Assess the outcome of the OODA cycle and update performance metrics.
   * An action being present indicates that something was executed; absence
   * (null) indicates either a 'hold' decision or a failed execution.
   */
  protected async evaluate(
    action: AgentAction | null,
    decision: AgentDecision,
  ): Promise<void> {
    if (action === null) {
      if (decision.action !== 'hold') {
        console.warn(
          `[LiquidityAgent:${this.config.id}] Decision "${decision.action}" ` +
          `(confidence: ${decision.confidence.toFixed(2)}) produced no action.`,
        );
      }
      // 'hold' decisions are expected and not counted as failures.
      // Transaction counters (successful/failed) are handled by
      // BaseAgent.wireWalletEvents() — do NOT increment here.
      return;
    }

    const isTransferAction =
      action.type === 'rebalance' || action.type === 'add_liquidity';

    const amountSol = isTransferAction
      ? (action.details.amountSol as number)
      : 0;

    // Only track volume here. Transaction counters are handled by
    // BaseAgent.wireWalletEvents() to avoid double-counting.
    this.updatePerformance({
      totalVolumeSol: this.performance.totalVolumeSol + amountSol,
    });

    console.log(
      `[LiquidityAgent:${this.config.id}] ${action.type} executed. ` +
      `Pool TVL: ${this.pool.tvl.toFixed(4)} SOL | ` +
      `Imbalance: ${(this.pool.imbalance * 100).toFixed(1)}% | ` +
      `APY: ${this.pool.apy.toFixed(2)}% | ` +
      `Fees earned: ${this.pool.feesEarned.toFixed(6)} SOL`,
    );
  }

  // ── Public Setters ──────────────────────────────────────────────────────────

  /** Update the destination address (e.g. for agent-to-agent wiring). */
  setTargetAddress(address: string): void {
    this.targetAddress = address;
  }

  /** Set the pool mint (and optional authority) for real AMM operations. */
  setPoolMint(mint: string, authority?: string): void {
    this.poolMint = mint;
    this.poolAuthority = authority ?? null;
  }

  /** Inject shared AI advisor from orchestrator. Avoids duplicate instances. */
  setAIAdvisor(aiAdvisor: AIAdvisor): void {
    this.aiAdvisor = aiAdvisor;
  }

  // ── Policy Engine Integration ──────────────────────────────────────────────

  /** Estimate transaction params so the policy engine can validate before execution. */
  protected estimateTransactionParams(
    decision: AgentDecision,
  ): TransactionValidationParams | null {
    if (decision.action === 'hold' || decision.action === 'remove_liquidity') return null;

    const amountSol = decision.action === 'rebalance'
      ? REBALANCE_TRANSFER_SOL
      : ADD_LIQUIDITY_TRANSFER_SOL;

    return {
      amountSol,
      programId: this.poolMint ? AMM_PROGRAM_ID : SYSTEM_PROGRAM_ADDRESS,
      destination: this.targetAddress,
    };
  }

  // ── Public Accessors ─────────────────────────────────────────────────────────

  /**
   * Return a snapshot of the current simulated pool state. Useful for
   * dashboard integrations and tests that inspect pool metrics directly.
   */
  getPoolState(): Readonly<PoolState> {
    return { ...this.pool };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Clamp `value` to the closed interval [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
