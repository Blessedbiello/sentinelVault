// SentinelVault — AIAdvisor
// Optional LLM integration for trade recommendations. Uses Claude API via raw
// fetch (no SDK dependency). Graceful no-op if no API key is configured.

// ─── Constants ────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const FETCH_TIMEOUT_MS = 8_000;

import { AgentDecisionContext, AIDecisionResult } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TradeContext {
  solPrice: number;
  priceSource: string;
  priceHistory: number[];
  balance: number;
  strategy: string;
  quantitativeSignal: { action: string; confidence: number };
}

interface AIRecommendation {
  action: string;
  confidence: number;
  reasoning: string;
}

// ─── AIAdvisor ────────────────────────────────────────────────────────────────

/**
 * Optional LLM-powered trade advisor.
 *
 * Detects ANTHROPIC_API_KEY or OPENAI_API_KEY from environment variables.
 * When available, sends market context to the LLM and parses a structured
 * recommendation. When unavailable, all methods return null — the trading
 * agent falls back to pure quantitative scoring with zero impact on behavior.
 */
export class AIAdvisor {
  private readonly apiKey: string | null;
  private readonly provider: 'anthropic' | 'openai' | null;
  private recentDecisions: { action: string; confidence: number; outcome?: string }[] = [];

  constructor() {
    const anthropicKey = process.env.ANTHROPIC_API_KEY ?? null;
    const openaiKey = process.env.OPENAI_API_KEY ?? null;

    if (anthropicKey) {
      this.apiKey = anthropicKey;
      this.provider = 'anthropic';
    } else if (openaiKey) {
      this.apiKey = openaiKey;
      this.provider = 'openai';
    } else {
      this.apiKey = null;
      this.provider = null;
    }
  }

  /** Whether an LLM API key is configured. */
  isAvailable(): boolean {
    return this.apiKey !== null;
  }

  /** Which provider is active, or null if none. */
  getProvider(): string | null {
    return this.provider;
  }

  /**
   * Record the outcome of a previous recommendation so subsequent prompts
   * include decision history context for in-session learning.
   */
  recordOutcome(outcome: string): void {
    if (this.recentDecisions.length > 0) {
      const last = this.recentDecisions[this.recentDecisions.length - 1];
      if (!last.outcome) {
        last.outcome = outcome;
      }
    }
  }

  /**
   * Get a trade recommendation from the LLM.
   * Returns null if no API key is set or if the request fails.
   */
  async getTradeRecommendation(context: TradeContext): Promise<AIRecommendation | null> {
    if (!this.apiKey || !this.provider) return null;

    const prompt = this.buildPrompt(context);

    try {
      let result: AIRecommendation | null;
      if (this.provider === 'anthropic') {
        result = await this.callAnthropic(prompt);
      } else {
        result = await this.callOpenAI(prompt);
      }

      // Track this recommendation for future context
      if (result) {
        this.recentDecisions.push({ action: result.action, confidence: result.confidence });
        if (this.recentDecisions.length > 10) {
          this.recentDecisions.splice(0, this.recentDecisions.length - 10);
        }
      }

      return result;
    } catch {
      return null;
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private buildPrompt(ctx: TradeContext): string {
    const recentPrices = ctx.priceHistory.slice(-10).map(p => p.toFixed(2)).join(', ');
    const lines = [
      `You are a quantitative trading advisor for a Solana DeFi agent.`,
      `Current SOL/USD price: $${ctx.solPrice.toFixed(2)} (source: ${ctx.priceSource})`,
      `Recent price history (last 10): [${recentPrices}]`,
      `Wallet balance: ${ctx.balance.toFixed(4)} SOL`,
      `Strategy: ${ctx.strategy}`,
      `Quantitative signal: ${ctx.quantitativeSignal.action} (confidence: ${ctx.quantitativeSignal.confidence.toFixed(3)})`,
    ];

    // Include recent decision history for in-session learning
    const withOutcomes = this.recentDecisions.slice(-3).filter(d => d.outcome);
    if (withOutcomes.length > 0) {
      lines.push('');
      lines.push('Your last recommendations and their outcomes:');
      for (const d of withOutcomes) {
        lines.push(`  - ${d.action} (confidence: ${d.confidence.toFixed(2)}) -> ${d.outcome}`);
      }
    }

    lines.push('');
    lines.push(`Based on this context, provide your recommendation as JSON:`);
    lines.push(`{"action": "buy"|"sell"|"hold", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`);
    lines.push(`Respond with ONLY the JSON object, no other text.`);

    return lines.join('\n');
  }

  private async callAnthropic(prompt: string): Promise<AIRecommendation | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const json = await res.json() as { content?: { type: string; text: string }[] };
    const text = json.content?.find(c => c.type === 'text')?.text;
    if (!text) return null;

    return this.parseRecommendation(text);
  }

  private async callOpenAI(prompt: string): Promise<AIRecommendation | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey!}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content;
    if (!text) return null;

    return this.parseRecommendation(text);
  }

  private parseRecommendation(text: string): AIRecommendation | null {
    try {
      // Extract JSON from response (handles markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const action = String(parsed.action ?? '').toLowerCase();
      const confidence = Number(parsed.confidence ?? 0);
      const reasoning = String(parsed.reasoning ?? '');

      if (!['buy', 'sell', 'hold'].includes(action)) return null;
      if (!isFinite(confidence) || confidence < 0 || confidence > 1) return null;

      return { action, confidence, reasoning };
    } catch {
      return null;
    }
  }

  // ── Rich-Context Decision ────────────────────────────────────────────────────

  /**
   * Get a rich, context-aware decision from the LLM using the full agent state.
   * Returns null if no API key is set or if the request fails.
   */
  async getAgentDecision(ctx: AgentDecisionContext): Promise<AIDecisionResult | null> {
    if (!this.apiKey || !this.provider) return null;

    const prompt = this.buildAgentPrompt(ctx);

    try {
      let result: AIDecisionResult | null;
      if (this.provider === 'anthropic') {
        result = await this.callAnthropicDecision(prompt);
      } else {
        result = await this.callOpenAIDecision(prompt);
      }

      // Track this decision for future context
      if (result) {
        this.recentDecisions.push({ action: result.action, confidence: result.confidence });
        if (this.recentDecisions.length > 10) {
          this.recentDecisions.splice(0, this.recentDecisions.length - 10);
        }
      }

      return result;
    } catch {
      return null;
    }
  }

  private buildAgentPrompt(ctx: AgentDecisionContext): string {
    const recentPrices = ctx.priceHistory.slice(-10).map(p => p.toFixed(2)).join(', ');

    const tokenHoldingsStr = ctx.tokenBalances.length > 0
      ? ctx.tokenBalances.map(t => `${t.symbol} (${t.mint.slice(0, 8)}…): ${t.balance.toFixed(6)}`).join(', ')
      : 'none';

    const poolStr = ctx.poolState
      ? `solReserve=${ctx.poolState.solReserve.toFixed(4)}, tokenReserve=${ctx.poolState.tokenReserve.toFixed(4)}, price=${ctx.poolState.price.toFixed(6)} SOL/token`
      : 'not configured';

    const jupiterStr = ctx.jupiterQuote
      ? `outAmount=${ctx.jupiterQuote.outAmount}, priceImpact=${ctx.jupiterQuote.priceImpactPct}%, route=${ctx.jupiterQuote.route}`
      : 'unavailable';

    const factorsStr = Object.entries(ctx.quantitativeSignal.factors)
      .map(([k, v]) => `${k}=${v.toFixed(4)}`)
      .join(', ');

    const recentDecisionsStr = ctx.recentDecisions.slice(-3)
      .map(d => `${d.action} (conf=${d.confidence.toFixed(2)}${d.outcome ? `, outcome=${d.outcome}` : ''})`)
      .join('; ');

    const reasoningStr = ctx.reasoningChain.join('\n');

    const lines = [
      `You are an autonomous AI agent managing a Solana DeFi wallet.`,
      `Agent: ${ctx.agentName} | Type: ${ctx.agentType} | Strategy: ${ctx.strategy}`,
      ``,
      `MARKET DATA:`,
      `- SOL/USD: $${ctx.solPrice.toFixed(2)} (${ctx.priceSource})`,
      `- 10-tick history: [${recentPrices}]`,
      `- Market regime: ${ctx.marketRegime}`,
      ``,
      `PORTFOLIO:`,
      `- SOL balance: ${ctx.solBalance.toFixed(4)}`,
      `- Token holdings: [${tokenHoldingsStr}]`,
      `- Total value: ${ctx.totalPortfolioValueSol.toFixed(4)} SOL`,
      ``,
      `ON-CHAIN STATE:`,
      `- AMM Pool: ${poolStr}`,
      `- Jupiter: ${jupiterStr}`,
      ``,
      `QUANTITATIVE MODEL (reference only):`,
      `- Signal: ${ctx.quantitativeSignal.action} at ${ctx.quantitativeSignal.confidence.toFixed(3)} confidence`,
      `- Factors: ${factorsStr}`,
      ``,
      `RECENT HISTORY:`,
      `- Last 3 decisions: [${recentDecisionsStr || 'none'}]`,
      ``,
      `CURRENT REASONING:`,
      reasoningStr,
      ``,
      `Based on all context, decide the next action. Output ONLY valid JSON:`,
      `{"action": "buy"|"sell"|"hold"|"arbitrage"|"rebalance_to_tokens"|"rebalance_to_sol", "confidence": 0.0-1.0, "reasoning": "2-3 sentence explanation", "riskAssessment": "one-line risk note", "marketOutlook": "brief forward-looking statement"}`,
    ];

    return lines.join('\n');
  }

  private async callAnthropicDecision(prompt: string): Promise<AIDecisionResult | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const json = await res.json() as { content?: { type: string; text: string }[] };
    const text = json.content?.find(c => c.type === 'text')?.text;
    if (!text) return null;

    return this.parseDecisionResult(text);
  }

  private async callOpenAIDecision(prompt: string): Promise<AIDecisionResult | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey!}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content;
    if (!text) return null;

    return this.parseDecisionResult(text);
  }

  private parseDecisionResult(text: string): AIDecisionResult | null {
    const VALID_ACTIONS = new Set([
      'buy', 'sell', 'hold', 'arbitrage', 'rebalance_to_tokens', 'rebalance_to_sol',
      'rebalance', 'add_liquidity', 'remove_liquidity',
    ]);

    try {
      // Extract JSON from response (handles markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      const action = String(parsed.action ?? '').toLowerCase();
      const confidence = Number(parsed.confidence ?? 0);
      const reasoning = String(parsed.reasoning ?? '');
      const riskAssessment = String(parsed.riskAssessment ?? '');
      const marketOutlook = String(parsed.marketOutlook ?? '');

      if (!VALID_ACTIONS.has(action)) return null;
      if (!isFinite(confidence) || confidence < 0 || confidence > 1) return null;
      if (!reasoning || !riskAssessment || !marketOutlook) return null;

      return { action, confidence, reasoning, riskAssessment, marketOutlook };
    } catch {
      return null;
    }
  }
}
