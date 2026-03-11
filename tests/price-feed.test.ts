// SentinelVault — PriceFeed Test Suite
// Tests real price fetching with mocked global.fetch and mocked Pyth SDK,
// cache behaviour, and graceful fallback across all three sources.

import { PriceFeed } from '../src/integrations/price-feed';

// ── Mock @pythnetwork/price-service-client ────────────────────────────────────
// The factory must be hoisting-safe (no references to outer-scope variables
// that are not yet initialised when jest.mock() runs at module-load time).

const mockGetLatestPriceFeeds = jest.fn();

jest.mock('@pythnetwork/price-service-client', () => {
  return {
    PriceServiceConnection: jest.fn().mockImplementation(() => ({
      getLatestPriceFeeds: mockGetLatestPriceFeeds,
    })),
  };
});

// ── Mock global.fetch ────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ── Response Helpers ─────────────────────────────────────────────────────────

function jupiterResponse(price: string) {
  return {
    ok: true,
    json: async () => ({
      data: { 'So11111111111111111111111111111111111111112': { price } },
    }),
  };
}

function coingeckoResponse(price: number) {
  return {
    ok: true,
    json: async () => ({ solana: { usd: price } }),
  };
}

function failedResponse() {
  return { ok: false, json: async () => ({}) };
}

/** Build a minimal Pyth PriceFeed-like object the mock will return. */
function pythFeed(price: number, conf: number) {
  return {
    getPriceUnchecked: () => ({
      getPriceAsNumberUnchecked: () => price,
      getConfAsNumberUnchecked: () => conf,
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PriceFeed', () => {
  let priceFeed: PriceFeed;

  beforeEach(() => {
    priceFeed = new PriceFeed();
    mockFetch.mockReset();
    mockGetLatestPriceFeeds.mockReset();
  });

  // ── Pyth (primary source) ──────────────────────────────────────────────────

  describe('Pyth source', () => {
    it('returns Pyth price as primary source when available', async () => {
      mockGetLatestPriceFeeds.mockResolvedValueOnce([pythFeed(185.50, 0.12)]);

      const result = await priceFeed.getSOLPrice();

      expect(result).not.toBeNull();
      expect(result!.price).toBe(185.50);
      expect(result!.source).toBe('pyth');
      expect(result!.confidence).toBe(0.12);
    });

    it('includes confidence interval in Pyth result', async () => {
      mockGetLatestPriceFeeds.mockResolvedValueOnce([pythFeed(190.00, 0.25)]);

      const result = await priceFeed.getSOLPrice();

      expect(result!.confidence).toBe(0.25);
    });

    it('falls back to Jupiter when Pyth returns empty feed array', async () => {
      mockGetLatestPriceFeeds.mockResolvedValueOnce([]);
      mockFetch.mockResolvedValueOnce(jupiterResponse('172.45'));

      const result = await priceFeed.getSOLPrice();

      expect(result).not.toBeNull();
      expect(result!.price).toBe(172.45);
      expect(result!.source).toBe('jupiter');
    });

    it('falls back to Jupiter when Pyth SDK throws', async () => {
      mockGetLatestPriceFeeds.mockRejectedValueOnce(new Error('Hermes timeout'));
      mockFetch.mockResolvedValueOnce(jupiterResponse('170.00'));

      const result = await priceFeed.getSOLPrice();

      expect(result).not.toBeNull();
      expect(result!.source).toBe('jupiter');
      expect(result!.price).toBe(170.00);
    });

    it('falls back to CoinGecko when both Pyth and Jupiter fail', async () => {
      mockGetLatestPriceFeeds.mockRejectedValueOnce(new Error('Hermes down'));
      mockFetch.mockResolvedValueOnce(failedResponse());
      mockFetch.mockResolvedValueOnce(coingeckoResponse(168.75));

      const result = await priceFeed.getSOLPrice();

      expect(result).not.toBeNull();
      expect(result!.source).toBe('coingecko');
      expect(result!.price).toBe(168.75);
    });

    it('rejects Pyth prices that are zero or negative', async () => {
      mockGetLatestPriceFeeds.mockResolvedValueOnce([pythFeed(0, 0)]);
      mockFetch.mockResolvedValueOnce(jupiterResponse('169.00'));

      const result = await priceFeed.getSOLPrice();

      // Should not have used the invalid Pyth price; fell back to Jupiter
      expect(result!.source).toBe('jupiter');
      expect(result!.price).toBe(169.00);
    });

    it('getPythPrice returns null when feed list is null', async () => {
      mockGetLatestPriceFeeds.mockResolvedValueOnce(null);

      const result = await (priceFeed as any).getPythPrice();

      expect(result).toBeNull();
    });

    it('getPythPrice returns price and confidence on valid feed', async () => {
      mockGetLatestPriceFeeds.mockResolvedValueOnce([pythFeed(200.00, 0.50)]);

      const result = await (priceFeed as any).getPythPrice();

      expect(result).not.toBeNull();
      expect(result.price).toBe(200.00);
      expect(result.confidence).toBe(0.50);
    });
  });

  // ── Cache ──────────────────────────────────────────────────────────────────

  describe('Cache behaviour', () => {
    it('returns Pyth price on first call, cache on second', async () => {
      mockGetLatestPriceFeeds.mockResolvedValueOnce([pythFeed(185.50, 0.12)]);

      const first = await priceFeed.getSOLPrice();
      expect(first!.source).toBe('pyth');

      // Second call — no mocks needed; should hit cache
      const second = await priceFeed.getSOLPrice();
      expect(second!.source).toBe('cache');
      expect(second!.price).toBe(185.50);
      expect(second!.confidence).toBe(0.12);

      // Pyth SDK and fetch should only have been called once total
      expect(mockGetLatestPriceFeeds).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns cached price within TTL', async () => {
      mockFetch.mockResolvedValueOnce(jupiterResponse('172.45'));
      // Pyth fails so we land on Jupiter
      mockGetLatestPriceFeeds.mockRejectedValueOnce(new Error('down'));

      const result1 = await priceFeed.getSOLPrice();
      expect(result1!.source).toBe('jupiter');

      const result2 = await priceFeed.getSOLPrice();
      expect(result2!.source).toBe('cache');
      expect(result2!.price).toBe(172.45);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('clearCache forces fresh fetch', async () => {
      mockGetLatestPriceFeeds
        .mockResolvedValueOnce([pythFeed(185.00, 0.10)])
        .mockResolvedValueOnce([pythFeed(186.00, 0.11)]);

      await priceFeed.getSOLPrice();
      priceFeed.clearCache();

      const result = await priceFeed.getSOLPrice();
      expect(result!.source).toBe('pyth');
      expect(result!.price).toBe(186.00);
      expect(mockGetLatestPriceFeeds).toHaveBeenCalledTimes(2);
    });
  });

  // ── Jupiter fallback (pre-existing behaviour preserved) ───────────────────

  describe('Jupiter fallback', () => {
    it('returns Jupiter price when Pyth is unavailable', async () => {
      mockGetLatestPriceFeeds.mockRejectedValueOnce(new Error('unavailable'));
      mockFetch.mockResolvedValueOnce(jupiterResponse('172.45'));

      const result = await priceFeed.getSOLPrice();

      expect(result).not.toBeNull();
      expect(result!.price).toBe(172.45);
      expect(result!.source).toBe('jupiter');
    });

    it('falls back to CoinGecko when Jupiter also fails', async () => {
      mockGetLatestPriceFeeds.mockRejectedValueOnce(new Error('down'));
      mockFetch.mockResolvedValueOnce(failedResponse());
      mockFetch.mockResolvedValueOnce(coingeckoResponse(170.50));

      const result = await priceFeed.getSOLPrice();

      expect(result).not.toBeNull();
      expect(result!.price).toBe(170.50);
      expect(result!.source).toBe('coingecko');
    });

    it('returns null when all three sources fail', async () => {
      mockGetLatestPriceFeeds.mockRejectedValueOnce(new Error('down'));
      mockFetch.mockResolvedValueOnce(failedResponse());
      mockFetch.mockResolvedValueOnce(failedResponse());

      const result = await priceFeed.getSOLPrice();

      expect(result).toBeNull();
    });

    it('handles network errors gracefully', async () => {
      mockGetLatestPriceFeeds.mockRejectedValueOnce(new Error('Network error'));
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await priceFeed.getSOLPrice();

      expect(result).toBeNull();
    });

    it('rejects zero or negative prices from Jupiter and CoinGecko', async () => {
      mockGetLatestPriceFeeds.mockRejectedValueOnce(new Error('down'));
      mockFetch.mockResolvedValueOnce(jupiterResponse('0'));
      mockFetch.mockResolvedValueOnce(coingeckoResponse(-5));

      const result = await priceFeed.getSOLPrice();

      expect(result).toBeNull();
    });
  });
});
