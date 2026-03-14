// SentinelVault — DexScreenerClient
// Fetches real Raydium/Orca pool prices from DexScreener's public API.
// No API key needed. 30-second cache TTL matching PriceFeed.

import { DexScreenerPrice } from '../types';

const CACHE_TTL_MS = 30_000;
const SOL_TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112';
const DEXSCREENER_API = `https://api.dexscreener.com/latest/dex/tokens/${SOL_TOKEN_ADDRESS}`;
const FETCH_TIMEOUT_MS = 5_000;
const MIN_LIQUIDITY_USD = 10_000;

export class DexScreenerClient {
  private cache: { price: DexScreenerPrice; fetchedAt: number } | null = null;

  async getSOLPrice(): Promise<DexScreenerPrice | null> {
    // Check cache
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.price;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(DEXSCREENER_API, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const json = await response.json() as { pairs?: Array<{
        chainId: string;
        dexId: string;
        pairAddress: string;
        priceUsd: string;
        liquidity: { usd: number };
        quoteToken: { symbol: string };
      }> };

      if (!json.pairs || !Array.isArray(json.pairs)) return null;

      // Filter: Solana chain, USDC quote, minimum liquidity
      const validPairs = json.pairs.filter(
        (p) =>
          p.chainId === 'solana' &&
          p.quoteToken?.symbol === 'USDC' &&
          p.liquidity?.usd > MIN_LIQUIDITY_USD
      );

      if (validPairs.length === 0) return null;

      // Sort by liquidity descending
      validPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

      const best = validPairs[0];
      const price = parseFloat(best.priceUsd);
      if (isNaN(price) || price <= 0) return null;

      const result: DexScreenerPrice = {
        price,
        source: `dexscreener:${best.dexId}`,
        pairAddress: best.pairAddress,
        dexId: best.dexId,
        liquidity: best.liquidity.usd,
      };

      this.cache = { price: result, fetchedAt: Date.now() };
      return result;
    } catch {
      return null;
    }
  }

  isAvailable(): boolean {
    return this.cache !== null && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  /** Return the currently cached price without triggering a network fetch, or null if none. */
  getCachedPrice(): DexScreenerPrice | null {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.price;
    }
    return null;
  }

  clearCache(): void {
    this.cache = null;
  }
}
