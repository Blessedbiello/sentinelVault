// SentinelVault — PriceFeed Test Suite
// Tests real price fetching with mocked global.fetch, cache behavior, and
// graceful fallback.

import { PriceFeed } from '../src/integrations/price-feed';

// ── Mock global.fetch ────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PriceFeed', () => {
  let priceFeed: PriceFeed;

  beforeEach(() => {
    priceFeed = new PriceFeed();
    mockFetch.mockReset();
  });

  it('returns Jupiter price when available', async () => {
    mockFetch.mockResolvedValueOnce(jupiterResponse('172.45'));

    const result = await priceFeed.getSOLPrice();

    expect(result).not.toBeNull();
    expect(result!.price).toBe(172.45);
    expect(result!.source).toBe('jupiter');
  });

  it('falls back to CoinGecko when Jupiter fails', async () => {
    mockFetch.mockResolvedValueOnce(failedResponse());
    mockFetch.mockResolvedValueOnce(coingeckoResponse(170.50));

    const result = await priceFeed.getSOLPrice();

    expect(result).not.toBeNull();
    expect(result!.price).toBe(170.50);
    expect(result!.source).toBe('coingecko');
  });

  it('returns null when both APIs fail', async () => {
    mockFetch.mockResolvedValueOnce(failedResponse());
    mockFetch.mockResolvedValueOnce(failedResponse());

    const result = await priceFeed.getSOLPrice();

    expect(result).toBeNull();
  });

  it('returns cached price within TTL', async () => {
    mockFetch.mockResolvedValueOnce(jupiterResponse('172.45'));

    const result1 = await priceFeed.getSOLPrice();
    expect(result1!.source).toBe('jupiter');

    // Second call should use cache
    const result2 = await priceFeed.getSOLPrice();
    expect(result2!.source).toBe('cache');
    expect(result2!.price).toBe(172.45);

    // fetch should only have been called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('clearCache forces fresh fetch', async () => {
    mockFetch.mockResolvedValue(jupiterResponse('172.45'));

    await priceFeed.getSOLPrice();
    priceFeed.clearCache();

    const result = await priceFeed.getSOLPrice();
    expect(result!.source).toBe('jupiter');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await priceFeed.getSOLPrice();

    expect(result).toBeNull();
  });

  it('rejects zero or negative prices', async () => {
    mockFetch.mockResolvedValueOnce(jupiterResponse('0'));
    mockFetch.mockResolvedValueOnce(coingeckoResponse(-5));

    const result = await priceFeed.getSOLPrice();

    expect(result).toBeNull();
  });
});
