// SentinelVault — JupiterClient
// Jupiter V6 Quote API client for real DEX swap quotes.
// Quotes work for mainnet tokens — used to demonstrate the agent CAN interact
// with Jupiter. On devnet, execution falls back to SOL transfers since Jupiter
// AMM pools don't exist on devnet.

import { JupiterQuote } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap';
const FETCH_TIMEOUT_MS = 5_000;

/** SOL native mint address. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** USDC mint address (mainnet). */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ─── JupiterClient ────────────────────────────────────────────────────────────

/**
 * Client for the Jupiter V6 Quote and Swap APIs.
 *
 * Provides real DEX swap quotes (mainnet liquidity) that agents use to
 * demonstrate protocol interaction awareness. On devnet, actual execution
 * falls back to SOL transfers since Jupiter pools are mainnet-only.
 */
export class JupiterClient {
  /**
   * Get a swap quote from Jupiter.
   *
   * @param params.inputMint  - Input token mint (default: SOL)
   * @param params.outputMint - Output token mint (default: USDC)
   * @param params.amount     - Amount in smallest unit (lamports for SOL)
   * @param params.slippageBps - Slippage tolerance in basis points (default: 50 = 0.5%)
   * @returns JupiterQuote or null on failure
   */
  async getQuote(params: {
    inputMint?: string;
    outputMint?: string;
    amount: number;
    slippageBps?: number;
  }): Promise<JupiterQuote | null> {
    try {
      const inputMint = params.inputMint ?? SOL_MINT;
      const outputMint = params.outputMint ?? USDC_MINT;
      const slippageBps = params.slippageBps ?? 50;

      const url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${params.amount}&slippageBps=${slippageBps}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const json = await res.json() as Record<string, unknown>;

      // Validate essential fields
      if (!json.inputMint || !json.outputMint || !json.inAmount || !json.outAmount) {
        return null;
      }

      return {
        inputMint: String(json.inputMint),
        outputMint: String(json.outputMint),
        inAmount: String(json.inAmount),
        outAmount: String(json.outAmount),
        priceImpactPct: String(json.priceImpactPct ?? '0'),
        routePlan: Array.isArray(json.routePlan)
          ? (json.routePlan as { swapInfo?: { label?: string } }[]).map(r => ({
              swapInfo: { label: r.swapInfo?.label ?? 'unknown' },
            }))
          : [],
        otherAmountThreshold: String(json.otherAmountThreshold ?? '0'),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get a serialized swap transaction from Jupiter (for future mainnet use).
   *
   * @param quoteResponse - Quote response from getQuote()
   * @param userPublicKey - The user's wallet public key
   * @returns Base64-encoded serialized transaction or null on failure
   */
  async getSwapTransaction(quoteResponse: JupiterQuote, userPublicKey: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(JUPITER_SWAP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey,
          wrapAndUnwrapSol: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const json = await res.json() as { swapTransaction?: string };
      return json.swapTransaction ?? null;
    } catch {
      return null;
    }
  }
}
