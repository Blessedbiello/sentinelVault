// SentinelVault — KoraClient
// Gasless transaction support via Kora fee abstraction layer (Solana Foundation).
// API-compatible with @solana/kora v0.2.0. Uses direct fetch to avoid runtime
// conflicts between @solana/kit (Kora SDK dep) and @solana/web3.js.

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_KORA_RPC = 'https://kora.solana.com';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface KoraClientOptions {
  rpcUrl?: string;
  apiKey?: string;
  hmacSecret?: string;
}

export interface KoraSignResult {
  signature: string;
  signedTransaction: string;
  signerPubkey: string;
}

export interface KoraPayerSigner {
  signer_address: string;
  payment_address: string;
}

export interface KoraFeeEstimate {
  fee_in_lamports: number;
  fee_in_token: number;
  token: string;
}

// ─── KoraClient ───────────────────────────────────────────────────────────────

/**
 * Client for the Kora gasless transaction paymaster service.
 *
 * API-compatible with `@solana/kora` v0.2.0 (Solana Foundation). We use a
 * direct fetch implementation to avoid runtime conflicts between Kora SDK's
 * `@solana/kit` dependency and our `@solana/web3.js` stack.
 *
 * Supports all 9 methods from the Kora JSON-RPC API:
 *   - signAndSendTransaction
 *   - signTransaction
 *   - transferTransaction
 *   - getConfig
 *   - getPayerSigner
 *   - getBlockhash
 *   - getSupportedTokens
 *   - estimateTransactionFee
 *   - getPaymentInstruction
 *
 * If no endpoint is configured, all methods return null immediately so callers
 * can fall back to standard fee-paying submission without special-casing.
 */
export class KoraClient {
  private readonly rpcUrl: string | null;
  private readonly enabled: boolean;
  private readonly apiKey: string | null;
  private readonly hmacSecret: string | null;

  constructor(config?: KoraClientOptions) {
    const rpcUrl = config?.rpcUrl ?? process.env.KORA_RPC_URL ?? null;
    this.rpcUrl = rpcUrl !== null && rpcUrl.length > 0 ? rpcUrl : null;
    this.enabled = this.rpcUrl !== null;
    this.apiKey = config?.apiKey ?? null;
    this.hmacSecret = config?.hmacSecret ?? null;
  }

  /** Returns true if a Kora endpoint is configured and available. */
  isAvailable(): boolean {
    return this.enabled;
  }

  /** Returns the configured Kora RPC URL, or null if not configured. */
  getRpcUrl(): string | null {
    return this.rpcUrl;
  }

  // ── Core RPC Helper ──────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request to the Kora endpoint.
   * Returns the parsed `result` field, or null on any failure.
   */
  private async rpcRequest<T>(method: string, params?: Record<string, unknown>): Promise<T | null> {
    if (!this.enabled || !this.rpcUrl) return null;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: params ?? {},
        }),
      });

      if (!res.ok) return null;

      const json = await res.json() as {
        result?: T;
        error?: { message: string };
      };

      if (json.error || !json.result) return null;

      return json.result;
    } catch {
      return null;
    }
  }

  // ── Transaction Methods ──────────────────────────────────────────────────────

  /**
   * Sign and send a transaction through Kora's paymaster.
   * The Kora server handles fee payment, so the agent wallet does not need
   * SOL for transaction fees.
   */
  async signAndSendTransaction(params: {
    transaction: string;
    signer_key?: string;
    sig_verify?: boolean;
  }): Promise<KoraSignResult | null> {
    const result = await this.rpcRequest<{
      signature: string;
      signed_transaction: string;
      signer_pubkey: string;
    }>('signAndSendTransaction', params);

    if (!result) return null;

    return {
      signature: result.signature,
      signedTransaction: result.signed_transaction,
      signerPubkey: result.signer_pubkey,
    };
  }

  /**
   * Sign a transaction without sending (useful for multi-sig flows).
   */
  async signTransaction(params: {
    transaction: string;
    signer_key?: string;
    sig_verify?: boolean;
  }): Promise<KoraSignResult | null> {
    const result = await this.rpcRequest<{
      signature: string;
      signed_transaction: string;
      signer_pubkey: string;
    }>('signTransaction', params);

    if (!result) return null;

    return {
      signature: result.signature,
      signedTransaction: result.signed_transaction,
      signerPubkey: result.signer_pubkey,
    };
  }

  /**
   * Request a pre-built transfer transaction from Kora.
   * Kora constructs the transaction server-side, incorporating fee
   * sponsorship accounts.
   */
  async transferTransaction(params: {
    source: string;
    destination: string;
    amount: number;
    token?: string;
  }): Promise<string | null> {
    const result = await this.rpcRequest<{ transaction: string }>('transferTransaction', params);
    return result?.transaction ?? null;
  }

  // ── Query Methods ────────────────────────────────────────────────────────────

  /**
   * Get the Kora server configuration.
   */
  async getConfig(): Promise<Record<string, unknown> | null> {
    return this.rpcRequest<Record<string, unknown>>('getConfig');
  }

  /**
   * Get the payer signer address and payment address.
   */
  async getPayerSigner(): Promise<KoraPayerSigner | null> {
    return this.rpcRequest<KoraPayerSigner>('getPayerSigner');
  }

  /**
   * Get a recent blockhash from the Kora server.
   */
  async getBlockhash(): Promise<{ blockhash: string } | null> {
    return this.rpcRequest<{ blockhash: string }>('getBlockhash');
  }

  /**
   * Get the list of SPL tokens supported for fee payment.
   */
  async getSupportedTokens(): Promise<{ tokens: string[] } | null> {
    return this.rpcRequest<{ tokens: string[] }>('getSupportedTokens');
  }

  /**
   * Estimate the transaction fee in both lamports and the fee token.
   */
  async estimateTransactionFee(params: {
    transaction: string;
    token?: string;
  }): Promise<KoraFeeEstimate | null> {
    return this.rpcRequest<KoraFeeEstimate>('estimateTransactionFee', params);
  }

  /**
   * Get a payment instruction for including fee payment in a transaction.
   */
  async getPaymentInstruction(params: {
    token: string;
    amount: number;
    payer: string;
  }): Promise<Record<string, unknown> | null> {
    return this.rpcRequest<Record<string, unknown>>('getPaymentInstruction', params);
  }
}
