// SentinelVault — KoraClient Test Suite
// Tests gasless transaction support, JSON-RPC call construction, auth headers,
// and all 9 API methods with mocked global.fetch.

import { KoraClient } from '../src/integrations/kora-client';

// ── Mock global.fetch ────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_RPC = 'https://test.kora.com';
const TEST_TX = 'base64encodedtransaction==';

function makeSignResult() {
  return {
    signature: 'sig123abc',
    signed_transaction: 'signedTxBase64==',
    signer_pubkey: 'KoraPubkey111111111111111111111111111111111',
  };
}

function rpcResponse(result: unknown) {
  return {
    ok: true,
    json: async () => ({ result }),
  };
}

function errorResponse(message = 'rpc error') {
  return {
    ok: true,
    json: async () => ({ error: { message } }),
  };
}

function httpErrorResponse(status = 500) {
  return {
    ok: false,
    status,
    json: async () => ({}),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('KoraClient', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    mockFetch.mockReset();
    savedEnv = process.env.KORA_RPC_URL;
    delete process.env.KORA_RPC_URL;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.KORA_RPC_URL = savedEnv;
    } else {
      delete process.env.KORA_RPC_URL;
    }
  });

  // ── Availability ────────────────────────────────────────────────────────────

  describe('isAvailable', () => {
    it('returns false when no rpcUrl is provided and KORA_RPC_URL is not set', () => {
      const client = new KoraClient();
      expect(client.isAvailable()).toBe(false);
    });

    it('returns true when rpcUrl is provided in config', () => {
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      expect(client.isAvailable()).toBe(true);
    });

    it('returns true when KORA_RPC_URL env var is set', () => {
      process.env.KORA_RPC_URL = TEST_RPC;
      const client = new KoraClient();
      expect(client.isAvailable()).toBe(true);
    });

    it('returns false when rpcUrl is an empty string', () => {
      const client = new KoraClient({ rpcUrl: '' });
      expect(client.isAvailable()).toBe(false);
    });

    it('config rpcUrl takes precedence over KORA_RPC_URL env var', () => {
      process.env.KORA_RPC_URL = 'https://env.kora.com';
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      expect(client.getRpcUrl()).toBe(TEST_RPC);
    });
  });

  // ── getRpcUrl ───────────────────────────────────────────────────────────────

  describe('getRpcUrl', () => {
    it('returns the configured URL when provided in config', () => {
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      expect(client.getRpcUrl()).toBe(TEST_RPC);
    });

    it('returns the URL from KORA_RPC_URL env var', () => {
      process.env.KORA_RPC_URL = TEST_RPC;
      const client = new KoraClient();
      expect(client.getRpcUrl()).toBe(TEST_RPC);
    });

    it('returns null when not configured', () => {
      const client = new KoraClient();
      expect(client.getRpcUrl()).toBeNull();
    });
  });

  // ── Auth Headers ────────────────────────────────────────────────────────────

  describe('auth headers', () => {
    it('sends Authorization header when apiKey is configured', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(makeSignResult()));
      const client = new KoraClient({ rpcUrl: TEST_RPC, apiKey: 'test-key-123' });

      await client.signAndSendTransaction({ transaction: TEST_TX });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key-123');
    });

    it('does not send Authorization header when apiKey is not set', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(makeSignResult()));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      await client.signAndSendTransaction({ transaction: TEST_TX });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  // ── signAndSendTransaction ──────────────────────────────────────────────────

  describe('signAndSendTransaction', () => {
    it('returns null when client is disabled', async () => {
      const client = new KoraClient();
      const result = await client.signAndSendTransaction({ transaction: TEST_TX });
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('calls Kora JSON-RPC with correct method and params', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(makeSignResult()));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      const result = await client.signAndSendTransaction({ transaction: TEST_TX });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(TEST_RPC);
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body as string);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('signAndSendTransaction');
      expect(body.params.transaction).toBe(TEST_TX);

      expect(result).not.toBeNull();
      expect(result!.signature).toBe('sig123abc');
      expect(result!.signedTransaction).toBe('signedTxBase64==');
      expect(result!.signerPubkey).toBe('KoraPubkey111111111111111111111111111111111');
    });

    it('passes signer_key and sig_verify params when provided', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(makeSignResult()));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      await client.signAndSendTransaction({
        transaction: TEST_TX,
        signer_key: 'myKey',
        sig_verify: true,
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.params.signer_key).toBe('myKey');
      expect(body.params.sig_verify).toBe(true);
    });

    it('returns null on HTTP error (non-2xx status)', async () => {
      mockFetch.mockResolvedValueOnce(httpErrorResponse(500));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.signAndSendTransaction({ transaction: TEST_TX });
      expect(result).toBeNull();
    });

    it('returns null when JSON-RPC response contains an error field', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse('insufficient funds'));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.signAndSendTransaction({ transaction: TEST_TX });
      expect(result).toBeNull();
    });

    it('returns null when JSON-RPC response has no result field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1 }),
      });
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.signAndSendTransaction({ transaction: TEST_TX });
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.signAndSendTransaction({ transaction: TEST_TX });
      expect(result).toBeNull();
    });
  });

  // ── signTransaction ─────────────────────────────────────────────────────────

  describe('signTransaction', () => {
    it('returns null when client is disabled', async () => {
      const client = new KoraClient();
      const result = await client.signTransaction({ transaction: TEST_TX });
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('calls Kora JSON-RPC with method signTransaction', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(makeSignResult()));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      await client.signTransaction({ transaction: TEST_TX });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.method).toBe('signTransaction');
    });

    it('returns mapped result on success', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse(makeSignResult()));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.signTransaction({ transaction: TEST_TX });
      expect(result).not.toBeNull();
      expect(result!.signature).toBe('sig123abc');
    });

    it('returns null on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(httpErrorResponse(503));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.signTransaction({ transaction: TEST_TX });
      expect(result).toBeNull();
    });

    it('returns null on JSON-RPC error', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse('signing failed'));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.signTransaction({ transaction: TEST_TX });
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('connection refused'));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.signTransaction({ transaction: TEST_TX });
      expect(result).toBeNull();
    });
  });

  // ── transferTransaction ───────────────────────────────────────────────────

  describe('transferTransaction', () => {
    const baseParams = {
      source: 'SenderPubkey111111111111111111111111111111',
      destination: 'RecipientPubkey11111111111111111111111111',
      amount: 1_000_000,
    };

    it('returns null when client is disabled', async () => {
      const client = new KoraClient();
      const result = await client.transferTransaction(baseParams);
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns the base64 transaction string on success', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse({ transaction: TEST_TX }));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.transferTransaction(baseParams);
      expect(result).toBe(TEST_TX);
    });

    it('calls Kora JSON-RPC with method transferTransaction and correct params', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse({ transaction: TEST_TX }));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      await client.transferTransaction(baseParams);

      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(TEST_RPC);
      const body = JSON.parse(options.body as string);
      expect(body.method).toBe('transferTransaction');
      expect(body.params.source).toBe(baseParams.source);
      expect(body.params.destination).toBe(baseParams.destination);
      expect(body.params.amount).toBe(1_000_000);
    });

    it('includes token param in the request when provided', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse({ transaction: TEST_TX }));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const token = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

      await client.transferTransaction({ ...baseParams, token });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.params.token).toBe(token);
    });

    it('returns null on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(httpErrorResponse(400));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.transferTransaction(baseParams);
      expect(result).toBeNull();
    });

    it('returns null when result is missing the transaction field', async () => {
      mockFetch.mockResolvedValueOnce(rpcResponse({}));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.transferTransaction(baseParams);
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      const result = await client.transferTransaction(baseParams);
      expect(result).toBeNull();
    });
  });

  // ── getConfig ──────────────────────────────────────────────────────────────

  describe('getConfig', () => {
    it('returns null when client is disabled', async () => {
      const client = new KoraClient();
      expect(await client.getConfig()).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns config object on success', async () => {
      const config = { network: 'devnet', version: '0.2.0' };
      mockFetch.mockResolvedValueOnce(rpcResponse(config));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      const result = await client.getConfig();
      expect(result).toEqual(config);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.method).toBe('getConfig');
    });

    it('returns null on error', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse());
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      expect(await client.getConfig()).toBeNull();
    });
  });

  // ── getPayerSigner ─────────────────────────────────────────────────────────

  describe('getPayerSigner', () => {
    it('returns null when client is disabled', async () => {
      const client = new KoraClient();
      expect(await client.getPayerSigner()).toBeNull();
    });

    it('returns payer signer info on success', async () => {
      const payer = {
        signer_address: 'SignerPubkey1111111111111111111111111111111',
        payment_address: 'PaymentPubkey111111111111111111111111111111',
      };
      mockFetch.mockResolvedValueOnce(rpcResponse(payer));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      const result = await client.getPayerSigner();
      expect(result).toEqual(payer);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.method).toBe('getPayerSigner');
    });

    it('returns null on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network'));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      expect(await client.getPayerSigner()).toBeNull();
    });
  });

  // ── getBlockhash ───────────────────────────────────────────────────────────

  describe('getBlockhash', () => {
    it('returns null when client is disabled', async () => {
      const client = new KoraClient();
      expect(await client.getBlockhash()).toBeNull();
    });

    it('returns blockhash on success', async () => {
      const bh = { blockhash: 'GHtXQBsoZHVnNFa9YevAyEGnkRr7x6pkXjT2jMBFSWiq' };
      mockFetch.mockResolvedValueOnce(rpcResponse(bh));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      const result = await client.getBlockhash();
      expect(result).toEqual(bh);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.method).toBe('getBlockhash');
    });

    it('returns null on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(httpErrorResponse(502));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      expect(await client.getBlockhash()).toBeNull();
    });
  });

  // ── getSupportedTokens ─────────────────────────────────────────────────────

  describe('getSupportedTokens', () => {
    it('returns null when client is disabled', async () => {
      const client = new KoraClient();
      expect(await client.getSupportedTokens()).toBeNull();
    });

    it('returns supported tokens list on success', async () => {
      const tokens = { tokens: ['USDC', 'USDT', 'SOL'] };
      mockFetch.mockResolvedValueOnce(rpcResponse(tokens));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      const result = await client.getSupportedTokens();
      expect(result).toEqual(tokens);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.method).toBe('getSupportedTokens');
    });

    it('returns null on error', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse());
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      expect(await client.getSupportedTokens()).toBeNull();
    });
  });

  // ── estimateTransactionFee ─────────────────────────────────────────────────

  describe('estimateTransactionFee', () => {
    it('returns null when client is disabled', async () => {
      const client = new KoraClient();
      expect(await client.estimateTransactionFee({ transaction: TEST_TX })).toBeNull();
    });

    it('returns fee estimate on success', async () => {
      const fee = { fee_in_lamports: 5000, fee_in_token: 100, token: 'USDC' };
      mockFetch.mockResolvedValueOnce(rpcResponse(fee));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      const result = await client.estimateTransactionFee({ transaction: TEST_TX });
      expect(result).toEqual(fee);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.method).toBe('estimateTransactionFee');
      expect(body.params.transaction).toBe(TEST_TX);
    });

    it('passes token param when provided', async () => {
      const fee = { fee_in_lamports: 5000, fee_in_token: 50, token: 'USDT' };
      mockFetch.mockResolvedValueOnce(rpcResponse(fee));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      await client.estimateTransactionFee({ transaction: TEST_TX, token: 'USDT' });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.params.token).toBe('USDT');
    });

    it('returns null on error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      expect(await client.estimateTransactionFee({ transaction: TEST_TX })).toBeNull();
    });
  });

  // ── getPaymentInstruction ──────────────────────────────────────────────────

  describe('getPaymentInstruction', () => {
    const params = { token: 'USDC', amount: 1000, payer: 'PayerPubkey1111' };

    it('returns null when client is disabled', async () => {
      const client = new KoraClient();
      expect(await client.getPaymentInstruction(params)).toBeNull();
    });

    it('returns payment instruction on success', async () => {
      const instruction = { programId: 'KoraProgram111', data: 'base64data==' };
      mockFetch.mockResolvedValueOnce(rpcResponse(instruction));
      const client = new KoraClient({ rpcUrl: TEST_RPC });

      const result = await client.getPaymentInstruction(params);
      expect(result).toEqual(instruction);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.method).toBe('getPaymentInstruction');
      expect(body.params.token).toBe('USDC');
      expect(body.params.amount).toBe(1000);
      expect(body.params.payer).toBe('PayerPubkey1111');
    });

    it('returns null on error', async () => {
      mockFetch.mockResolvedValueOnce(httpErrorResponse(500));
      const client = new KoraClient({ rpcUrl: TEST_RPC });
      expect(await client.getPaymentInstruction(params)).toBeNull();
    });
  });
});
