// SentinelVault — PriceFeed
// Real SOL/USD price from Jupiter Price API V2 with CoinGecko fallback.
// Uses Node 18 global fetch — no additional dependencies required.

import { PriceData } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_PRICE_URL = `https://api.jup.ag/price/v2?ids=${SOL_MINT}`;
const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;

// ─── PriceFeed ────────────────────────────────────────────────────────────────

/**
 * Fetches real SOL/USD price from public APIs with caching and graceful fallback.
 *
 * Priority: Jupiter Price API V2 → CoinGecko → null (caller uses simulated price).
 */
export class PriceFeed {
  private cache: { price: number; source: PriceData['source']; timestamp: number } | null = null;

  /**
   * Get the current SOL/USD price.
   * Returns null if all API calls fail — caller should fall back to simulated price.
   */
  async getSOLPrice(): Promise<PriceData | null> {
    // Check cache
    if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL_MS) {
      return { price: this.cache.price, source: 'cache', timestamp: this.cache.timestamp };
    }

    // Try Jupiter
    const jupiterPrice = await this.fetchJupiterPrice();
    if (jupiterPrice !== null) {
      this.cache = { price: jupiterPrice, source: 'jupiter', timestamp: Date.now() };
      return { price: jupiterPrice, source: 'jupiter', timestamp: Date.now() };
    }

    // Fallback: CoinGecko
    const geckoPrice = await this.fetchCoinGeckoPrice();
    if (geckoPrice !== null) {
      this.cache = { price: geckoPrice, source: 'coingecko', timestamp: Date.now() };
      return { price: geckoPrice, source: 'coingecko', timestamp: Date.now() };
    }

    return null;
  }

  /** Clear the price cache. */
  clearCache(): void {
    this.cache = null;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private async fetchJupiterPrice(): Promise<number | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(JUPITER_PRICE_URL, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const json = await res.json() as { data?: Record<string, { price?: string }> };
      const priceStr = json.data?.[SOL_MINT]?.price;
      if (!priceStr) return null;

      const price = parseFloat(priceStr);
      return isFinite(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  private async fetchCoinGeckoPrice(): Promise<number | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(COINGECKO_PRICE_URL, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const json = await res.json() as { solana?: { usd?: number } };
      const price = json.solana?.usd;
      return typeof price === 'number' && isFinite(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
  }
}
