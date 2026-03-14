// SentinelVault — PriceFeed
// Real SOL/USD price with priority: Pyth → Jupiter → CoinGecko → null.
// Uses @pythnetwork/price-service-client for on-chain Pyth prices via the
// Hermes REST service (no WebSocket, CJS-compatible).

import { PriceServiceConnection } from '@pythnetwork/price-service-client';
import { PriceData } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_PRICE_URL = `https://api.jup.ag/price/v2?ids=${SOL_MINT}`;
const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 30_000;

// Pyth Network — SOL/USD price feed ID (same on mainnet + devnet via Hermes)
const PYTH_HERMES_ENDPOINT = 'https://hermes.pyth.network';
const PYTH_SOL_USD_FEED_ID =
  '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

// ─── PriceFeed ────────────────────────────────────────────────────────────────

/**
 * Fetches real SOL/USD price from multiple sources with caching and graceful
 * fallback.
 *
 * Priority: Pyth (Hermes) → Jupiter Price API V2 → CoinGecko → null
 *
 * The Pyth integration uses @pythnetwork/price-service-client to query the
 * Hermes REST endpoint so no WebSocket or Solana RPC connection is required.
 */
export class PriceFeed {
  private cache: {
    price: number;
    source: PriceData['source'];
    timestamp: number;
    confidence?: number;
  } | null = null;

  private readonly pythConnection: PriceServiceConnection;

  constructor() {
    this.pythConnection = new PriceServiceConnection(PYTH_HERMES_ENDPOINT, {
      timeout: FETCH_TIMEOUT_MS,
    });
  }

  /**
   * Get the current SOL/USD price.
   * Returns null if all API calls fail — caller should fall back to a
   * simulated price.
   */
  async getSOLPrice(): Promise<PriceData | null> {
    // Return from cache if still fresh
    if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL_MS) {
      return {
        price: this.cache.price,
        source: 'cache',
        timestamp: this.cache.timestamp,
        confidence: this.cache.confidence,
      };
    }

    // 1. Try Pyth (primary)
    const pythResult = await this.getPythPrice();
    if (pythResult !== null) {
      this.cache = {
        price: pythResult.price,
        source: 'pyth',
        timestamp: Date.now(),
        confidence: pythResult.confidence,
      };
      return {
        price: pythResult.price,
        source: 'pyth',
        timestamp: Date.now(),
        confidence: pythResult.confidence,
      };
    }

    // 2. Fallback: Jupiter
    const jupiterPrice = await this.fetchJupiterPrice();
    if (jupiterPrice !== null) {
      this.cache = { price: jupiterPrice, source: 'jupiter', timestamp: Date.now(), confidence: undefined };
      return { price: jupiterPrice, source: 'jupiter', timestamp: Date.now(), confidence: undefined };
    }

    // 3. Fallback: CoinGecko
    const geckoPrice = await this.fetchCoinGeckoPrice();
    if (geckoPrice !== null) {
      this.cache = { price: geckoPrice, source: 'coingecko', timestamp: Date.now(), confidence: undefined };
      return { price: geckoPrice, source: 'coingecko', timestamp: Date.now(), confidence: undefined };
    }

    return null;
  }

  /** Clear the price cache. */
  clearCache(): void {
    this.cache = null;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Fetch SOL/USD from Pyth via the Hermes REST service.
   * Returns { price, confidence } on success, null on any failure.
   *
   * The SDK's getLatestPriceFeeds() does a single GET request; no WebSocket
   * is opened. getPriceUnchecked() is used instead of getPriceNoOlderThan()
   * so that the unit tests are not tied to wall-clock age checks.
   */
  async getPythPrice(): Promise<{ price: number; confidence: number } | null> {
    try {
      const feeds = await this.pythConnection.getLatestPriceFeeds([
        PYTH_SOL_USD_FEED_ID,
      ]);

      if (!feeds || feeds.length === 0) return null;

      const feed = feeds[0];
      const priceObj = feed.getPriceUnchecked();

      const price = priceObj.getPriceAsNumberUnchecked();
      const confidence = priceObj.getConfAsNumberUnchecked();

      if (!isFinite(price) || price <= 0) return null;

      return { price, confidence };
    } catch {
      return null;
    }
  }

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
