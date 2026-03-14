// SentinelVault — DexScreenerClient Test Suite
// Tests cache behaviour, network error handling, response parsing, and
// pair selection/sorting logic. All tests mock global.fetch.

import { DexScreenerClient } from '../src/integrations/dexscreener-client';

// ── Mock global.fetch ────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePair(overrides: Partial<{
  chainId: string;
  dexId: string;
  pairAddress: string;
  priceUsd: string;
  liquidityUsd: number;
  quoteSymbol: string;
}> = {}) {
  return {
    chainId: overrides.chainId ?? 'solana',
    dexId: overrides.dexId ?? 'raydium',
    pairAddress: overrides.pairAddress ?? 'PairAddr111111111111111111111111111111111111',
    priceUsd: overrides.priceUsd ?? '155.50',
    liquidity: { usd: overrides.liquidityUsd ?? 50_000 },
    quoteToken: { symbol: overrides.quoteSymbol ?? 'USDC' },
  };
}

function fetchOk(pairs: unknown[]) {
  return Promise.resolve({
    ok: true,
    json: async () => ({ pairs }),
  });
}

function fetchHttpError(status = 500) {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({}),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DexScreenerClient', () => {
  let client: DexScreenerClient;

  beforeEach(() => {
    client = new DexScreenerClient();
    mockFetch.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Successful fetch ───────────────────────────────────────────────────────

  it('returns a DexScreenerPrice on a successful fetch', async () => {
    mockFetch.mockReturnValueOnce(fetchOk([makePair({ priceUsd: '160.00', dexId: 'raydium' })]));

    const result = await client.getSOLPrice();

    expect(result).not.toBeNull();
    expect(result!.price).toBe(160.0);
    expect(result!.source).toBe('dexscreener:raydium');
    expect(result!.dexId).toBe('raydium');
    expect(result!.pairAddress).toBeTruthy();
    expect(result!.liquidity).toBeGreaterThan(0);
  });

  // ── Cache hit ─────────────────────────────────────────────────────────────

  it('returns the cached price without fetching again within TTL', async () => {
    mockFetch.mockReturnValueOnce(fetchOk([makePair({ priceUsd: '155.00' })]));

    await client.getSOLPrice(); // populate cache
    const result = await client.getSOLPrice(); // should use cache

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result!.price).toBe(155.0);
  });

  // ── Cache miss after TTL ──────────────────────────────────────────────────

  it('re-fetches after the 30-second TTL expires', async () => {
    mockFetch
      .mockReturnValueOnce(fetchOk([makePair({ priceUsd: '155.00' })]))
      .mockReturnValueOnce(fetchOk([makePair({ priceUsd: '162.00' })]));

    await client.getSOLPrice();

    // Advance time past TTL
    jest.advanceTimersByTime(31_000);

    const result = await client.getSOLPrice();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result!.price).toBe(162.0);
  });

  // ── Network error ─────────────────────────────────────────────────────────

  it('returns null when fetch throws a network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network failure'));

    const result = await client.getSOLPrice();

    expect(result).toBeNull();
  });

  // ── HTTP error status ─────────────────────────────────────────────────────

  it('returns null when the response is not ok', async () => {
    mockFetch.mockReturnValueOnce(fetchHttpError(503));

    const result = await client.getSOLPrice();

    expect(result).toBeNull();
  });

  // ── Invalid JSON (no pairs key) ───────────────────────────────────────────

  it('returns null when JSON has no pairs field', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({ ok: true, json: async () => ({ other: 'data' }) })
    );

    const result = await client.getSOLPrice();

    expect(result).toBeNull();
  });

  // ── No matching pairs after filtering ────────────────────────────────────

  it('returns null when no pairs pass the chain/quote/liquidity filter', async () => {
    const pairs = [
      makePair({ chainId: 'ethereum', quoteSymbol: 'USDC' }), // wrong chain
      makePair({ chainId: 'solana', quoteSymbol: 'USDT' }),   // wrong quote
      makePair({ chainId: 'solana', quoteSymbol: 'USDC', liquidityUsd: 5_000 }), // below liquidity
    ];
    mockFetch.mockReturnValueOnce(fetchOk(pairs));

    const result = await client.getSOLPrice();

    expect(result).toBeNull();
  });

  // ── NaN price ─────────────────────────────────────────────────────────────

  it('returns null when the best pair has a non-numeric priceUsd', async () => {
    mockFetch.mockReturnValueOnce(fetchOk([makePair({ priceUsd: 'not-a-number' })]));

    const result = await client.getSOLPrice();

    expect(result).toBeNull();
  });

  // ── Zero price guard ──────────────────────────────────────────────────────

  it('returns null when priceUsd parses to zero', async () => {
    mockFetch.mockReturnValueOnce(fetchOk([makePair({ priceUsd: '0' })]));

    const result = await client.getSOLPrice();

    expect(result).toBeNull();
  });

  // ── Liquidity filter ──────────────────────────────────────────────────────

  it('excludes pairs below the 10 000 USD liquidity minimum', async () => {
    const pairs = [
      makePair({ priceUsd: '200.00', liquidityUsd: 5_000 }),  // filtered out
      makePair({ priceUsd: '155.00', liquidityUsd: 20_000 }), // passes
    ];
    mockFetch.mockReturnValueOnce(fetchOk(pairs));

    const result = await client.getSOLPrice();

    expect(result).not.toBeNull();
    expect(result!.price).toBe(155.0);
  });

  // ── Pair sorting (highest liquidity wins) ─────────────────────────────────

  it('selects the pair with the highest liquidity', async () => {
    const pairs = [
      makePair({ priceUsd: '150.00', liquidityUsd: 30_000, dexId: 'orca' }),
      makePair({ priceUsd: '158.00', liquidityUsd: 100_000, dexId: 'raydium' }),
      makePair({ priceUsd: '155.00', liquidityUsd: 50_000, dexId: 'meteora' }),
    ];
    mockFetch.mockReturnValueOnce(fetchOk(pairs));

    const result = await client.getSOLPrice();

    expect(result!.price).toBe(158.0);
    expect(result!.dexId).toBe('raydium');
    expect(result!.liquidity).toBe(100_000);
  });

  // ── isAvailable ───────────────────────────────────────────────────────────

  it('isAvailable returns false before any fetch and true after a successful fetch', async () => {
    expect(client.isAvailable()).toBe(false);

    mockFetch.mockReturnValueOnce(fetchOk([makePair()]));
    await client.getSOLPrice();

    expect(client.isAvailable()).toBe(true);
  });

  // ── isAvailable after TTL ─────────────────────────────────────────────────

  it('isAvailable returns false after the cache TTL expires', async () => {
    mockFetch.mockReturnValueOnce(fetchOk([makePair()]));
    await client.getSOLPrice();

    jest.advanceTimersByTime(31_000);

    expect(client.isAvailable()).toBe(false);
  });

  // ── clearCache ────────────────────────────────────────────────────────────

  it('clearCache invalidates the cache so the next call fetches fresh data', async () => {
    mockFetch
      .mockReturnValueOnce(fetchOk([makePair({ priceUsd: '155.00' })]))
      .mockReturnValueOnce(fetchOk([makePair({ priceUsd: '170.00' })]));

    await client.getSOLPrice();
    expect(client.isAvailable()).toBe(true);

    client.clearCache();
    expect(client.isAvailable()).toBe(false);

    const result = await client.getSOLPrice();
    expect(result!.price).toBe(170.0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ── getCachedPrice ────────────────────────────────────────────────────────

  it('getCachedPrice returns null before any fetch', () => {
    expect(client.getCachedPrice()).toBeNull();
  });

  it('getCachedPrice returns the last fetched price within TTL', async () => {
    mockFetch.mockReturnValueOnce(fetchOk([makePair({ priceUsd: '162.50' })]));
    await client.getSOLPrice();

    const cached = client.getCachedPrice();
    expect(cached).not.toBeNull();
    expect(cached!.price).toBe(162.5);
  });
});
