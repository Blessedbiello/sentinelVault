// SentinelVault — JupiterClient Test Suite
// Tests Jupiter V6 quote API parsing, error handling, and swap transaction
// building with mocked global.fetch.

import { JupiterClient } from '../src/integrations/jupiter';

// ── Mock global.fetch ────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ── Helpers ──────────────────────────────────────────────────────────────────

function quoteResponse() {
  return {
    ok: true,
    json: async () => ({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inAmount: '10000000',
      outAmount: '1724500',
      priceImpactPct: '0.01',
      routePlan: [{ swapInfo: { label: 'Raydium' } }],
      otherAmountThreshold: '1720000',
    }),
  };
}

function swapResponse() {
  return {
    ok: true,
    json: async () => ({
      swapTransaction: 'base64encodedtx==',
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('JupiterClient', () => {
  let client: JupiterClient;

  beforeEach(() => {
    client = new JupiterClient();
    mockFetch.mockReset();
  });

  describe('getQuote', () => {
    it('returns parsed quote on success', async () => {
      mockFetch.mockResolvedValueOnce(quoteResponse());

      const quote = await client.getQuote({ amount: 10_000_000 });

      expect(quote).not.toBeNull();
      expect(quote!.inputMint).toBe('So11111111111111111111111111111111111111112');
      expect(quote!.outputMint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      expect(quote!.inAmount).toBe('10000000');
      expect(quote!.outAmount).toBe('1724500');
      expect(quote!.routePlan).toHaveLength(1);
      expect(quote!.routePlan[0].swapInfo.label).toBe('Raydium');
    });

    it('returns null on API failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });

      const quote = await client.getQuote({ amount: 10_000_000 });

      expect(quote).toBeNull();
    });

    it('returns null on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const quote = await client.getQuote({ amount: 10_000_000 });

      expect(quote).toBeNull();
    });

    it('returns null when response lacks required fields', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ inputMint: 'test' }), // missing outputMint, amounts
      });

      const quote = await client.getQuote({ amount: 10_000_000 });

      expect(quote).toBeNull();
    });

    it('uses default SOL and USDC mints', async () => {
      mockFetch.mockResolvedValueOnce(quoteResponse());

      await client.getQuote({ amount: 10_000_000 });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('inputMint=So111');
      expect(url).toContain('outputMint=EPjFW');
    });
  });

  describe('getSwapTransaction', () => {
    it('returns serialized transaction on success', async () => {
      mockFetch.mockResolvedValueOnce(swapResponse());

      const quote = {
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: '10000000',
        outAmount: '1724500',
        priceImpactPct: '0.01',
        routePlan: [{ swapInfo: { label: 'Raydium' } }],
        otherAmountThreshold: '1720000',
      };

      const tx = await client.getSwapTransaction(quote, 'testPublicKey123');

      expect(tx).toBe('base64encodedtx==');
    });

    it('returns null on failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });

      const tx = await client.getSwapTransaction({
        inputMint: '', outputMint: '', inAmount: '', outAmount: '',
        priceImpactPct: '', routePlan: [], otherAmountThreshold: '',
      }, 'test');

      expect(tx).toBeNull();
    });
  });
});
