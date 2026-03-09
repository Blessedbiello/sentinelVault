// SentinelVault — AgenticWallet
// Wraps KeystoreManager and a Solana Connection to provide a secure,
// event-driven wallet interface for autonomous AI agents.

import EventEmitter from 'eventemitter3';
import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer as splTransfer,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { KeystoreManager } from './keystore';
import { PolicyEngine } from '../security/policy-engine';
import {
  WalletConfig,
  WalletState,
  WalletStatus,
  SolanaCluster,
  TokenBalance,
  TransactionValidationParams,
} from '../types';

/** Memo Program v2 address. */
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** System Program address for policy validation. */
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RPC_ENDPOINTS: Record<SolanaCluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

const AIRDROP_MAX_ATTEMPTS = 3;
const AIRDROP_BASE_DELAY_MS = 2_000;

// ─── Event Map ────────────────────────────────────────────────────────────────

interface WalletEvents {
  'wallet:created': [state: WalletState];
  'wallet:funded': [signature: string, amountSol: number];
  'wallet:locked': [];
  'wallet:unlocked': [];
  'transaction:submitted': [signature: string];
  'transaction:confirmed': [signature: string];
  'transaction:failed': [error: Error, context?: string];
}

// ─── AgenticWallet ────────────────────────────────────────────────────────────

/**
 * An event-driven, encrypted wallet designed for autonomous AI agents operating
 * on Solana. Keypair material is decrypted on demand and wiped from memory
 * immediately after use.
 */
export class AgenticWallet extends EventEmitter<WalletEvents> {
  private readonly config: WalletConfig;
  private readonly keystoreManager: KeystoreManager;
  private readonly password: string;

  private policyEngine: PolicyEngine | null = null;
  private state: WalletState | null = null;
  private keystoreId: string | null = null;
  private connection: Connection | null = null;
  private locked: boolean = false;

  constructor(config: WalletConfig) {
    super();
    this.config = config;
    this.password = config.password;
    this.keystoreManager = new KeystoreManager(config.keystorePath);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Generate a new encrypted wallet, establish a Solana connection, and emit
   * 'wallet:created'. Must be called before any transaction methods.
   */
  async initialize(): Promise<void> {
    const { publicKey, keystoreId } = await this.keystoreManager.createEncryptedWallet(
      this.password,
      this.config.label,
      this.config.cluster,
    );

    this.keystoreId = keystoreId;
    this.connection = this.buildConnection();

    const now = Date.now();
    this.state = {
      id: this.config.id,
      label: this.config.label,
      publicKey,
      cluster: this.config.cluster,
      balanceSol: 0,
      tokenBalances: [],
      createdAt: now,
      lastActivity: now,
      transactionCount: 0,
      status: 'active' as WalletStatus,
    };

    this.emit('wallet:created', this.state);
  }

  /**
   * Load an existing keystore by ID, establish a Solana connection, and
   * populate WalletState from the on-chain balance.
   */
  async initializeFromKeystore(keystoreId: string): Promise<void> {
    // Validate the password against the supplied keystore before proceeding.
    const valid = this.keystoreManager.verifyPassword(keystoreId, this.password);
    if (!valid) {
      throw new Error(`Invalid password for keystore: ${keystoreId}`);
    }

    this.keystoreId = keystoreId;
    this.connection = this.buildConnection();

    // Reconstruct the public key by briefly decrypting the keypair.
    const keypair = this.keystoreManager.decryptKeypair(keystoreId, this.password);
    const publicKey = keypair.publicKey.toBase58();
    keypair.secretKey.fill(0);

    const balanceSol = await this.fetchBalance(publicKey);
    const now = Date.now();

    this.state = {
      id: this.config.id,
      label: this.config.label,
      publicKey,
      cluster: this.config.cluster,
      balanceSol,
      tokenBalances: [],
      createdAt: now,
      lastActivity: now,
      transactionCount: 0,
      status: 'active' as WalletStatus,
    };
  }

  // ── Balance & Token Methods ─────────────────────────────────────────────────

  /** Return the current SOL balance. Refreshes from on-chain state. */
  async getBalance(): Promise<number> {
    this.assertReady();
    const balanceSol = await this.fetchBalance(this.state!.publicKey);
    this.state!.balanceSol = balanceSol;
    this.state!.lastActivity = Date.now();
    return balanceSol;
  }

  /**
   * Fetch all SPL token accounts owned by this wallet and return their balances.
   * Updates the internal wallet state with the latest token balances.
   */
  async getTokenBalances(): Promise<TokenBalance[]> {
    this.assertReady();

    const pubkey = new PublicKey(this.state!.publicKey);
    const response = await this.connection!.getParsedTokenAccountsByOwner(pubkey, {
      programId: TOKEN_PROGRAM_ID,
    });

    const balances: TokenBalance[] = response.value.map((account) => {
      const parsed = account.account.data.parsed.info;
      const mintAddress: string = parsed.mint;
      const tokenAmount = parsed.tokenAmount;

      return {
        mint: mintAddress,
        symbol: mintAddress.slice(0, 6),
        balance: Number(tokenAmount.amount),
        decimals: tokenAmount.decimals,
        uiBalance: tokenAmount.uiAmountString ?? '0',
      };
    });

    this.state!.tokenBalances = balances;
    this.state!.lastActivity = Date.now();
    return balances;
  }

  // ── Transaction Methods ─────────────────────────────────────────────────────

  /**
   * Transfer SOL to `destination`. Returns the transaction signature.
   * Amount is specified in SOL (not lamports).
   */
  async transferSOL(destination: string, amountSol: number): Promise<string> {
    this.assertReady();

    if (amountSol <= 0) {
      throw new Error(`Transfer amount must be positive, got ${amountSol}`);
    }

    // Policy gate: validate spending limits, rate limits, and allowlists
    this.enforcePolicy({
      amountSol,
      destination,
      programId: SYSTEM_PROGRAM_ADDRESS,
      type: 'transfer_sol',
    });

    const fromPubkey = new PublicKey(this.state!.publicKey);
    const toPubkey = new PublicKey(destination);
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

    const transaction = new Transaction().add(
      SystemProgram.transfer({ fromPubkey, toPubkey, lamports }),
    );

    const signature = await this.signAndSendTransaction(transaction);

    // Record the confirmed spend in the policy engine's rolling windows
    if (this.policyEngine) {
      this.policyEngine.recordTransaction(amountSol);
    }

    return signature;
  }

  /**
   * Transfer SPL tokens to a destination wallet. Automatically creates the
   * destination's associated token account if it does not exist.
   *
   * @param mint        - The token mint address.
   * @param destination - The destination wallet public key (not ATA).
   * @param amount      - Amount in raw token units (not UI amount).
   */
  async transferToken(
    mint: string,
    destination: string,
    amount: number,
  ): Promise<string> {
    this.assertReady();

    // Policy gate: validate the SPL Token program is allowlisted
    this.enforcePolicy({
      amountSol: 0, // SPL transfers don't spend SOL (beyond fees)
      destination,
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      type: 'transfer_spl',
    });

    const connection = this.connection!;
    const mintPubkey = new PublicKey(mint);
    const destPubkey = new PublicKey(destination);

    let keypair: Keypair | null = null;

    try {
      keypair = this.keystoreManager.decryptKeypair(this.keystoreId!, this.password);

      const senderATA = await getOrCreateAssociatedTokenAccount(
        connection, keypair, mintPubkey, keypair.publicKey,
      );

      const destATA = await getOrCreateAssociatedTokenAccount(
        connection, keypair, mintPubkey, destPubkey,
      );

      const signature = await splTransfer(
        connection, keypair, senderATA.address, destATA.address, keypair, amount,
      );

      this.state!.transactionCount += 1;
      this.state!.lastActivity = Date.now();
      this.emit('transaction:confirmed', signature);

      return signature;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('transaction:failed', error);
      throw error;
    } finally {
      if (keypair !== null) {
        keypair.secretKey.fill(0);
      }
    }
  }

  /**
   * Create a new SPL token mint. The wallet owner becomes both the mint
   * authority and freeze authority.
   *
   * @param decimals - Number of decimal places (default: 9).
   * @returns The mint address as a base58 string.
   */
  async createTokenMint(decimals: number = 9): Promise<string> {
    this.assertReady();

    const connection = this.connection!;
    let keypair: Keypair | null = null;

    try {
      keypair = this.keystoreManager.decryptKeypair(this.keystoreId!, this.password);

      const mint = await createMint(
        connection,
        keypair,
        keypair.publicKey,
        keypair.publicKey,
        decimals,
      );

      this.state!.transactionCount += 1;
      this.state!.lastActivity = Date.now();

      return mint.toBase58();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('transaction:failed', error);
      throw error;
    } finally {
      if (keypair !== null) {
        keypair.secretKey.fill(0);
      }
    }
  }

  /**
   * Mint new tokens to the wallet owner's associated token account.
   *
   * @param mintAddress - The token mint address.
   * @param amount      - Amount in raw token units to mint.
   * @returns The transaction signature.
   */
  async mintTokens(mintAddress: string, amount: number): Promise<string> {
    this.assertReady();

    const connection = this.connection!;
    const mintPubkey = new PublicKey(mintAddress);
    let keypair: Keypair | null = null;

    try {
      keypair = this.keystoreManager.decryptKeypair(this.keystoreId!, this.password);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection, keypair, mintPubkey, keypair.publicKey,
      );

      const signature = await mintTo(
        connection, keypair, mintPubkey, ata.address, keypair, amount,
      );

      this.state!.transactionCount += 1;
      this.state!.lastActivity = Date.now();
      this.emit('transaction:confirmed', signature);

      return signature;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('transaction:failed', error);
      throw error;
    } finally {
      if (keypair !== null) {
        keypair.secretKey.fill(0);
      }
    }
  }

  /**
   * Write a memo on-chain via the Memo Program v2.
   *
   * @param memoText - The text to store on-chain (max ~566 bytes).
   * @returns The transaction signature.
   */
  async sendMemo(memoText: string): Promise<string> {
    this.assertReady();

    const instruction = new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoText, 'utf-8'),
    });

    const transaction = new Transaction().add(instruction);
    return this.signAndSendTransaction(transaction);
  }

  /**
   * Sign and broadcast a transaction. This is the critical path for all
   * on-chain interactions:
   *  1. Verify the wallet is ready and unlocked.
   *  2. Decrypt the keypair.
   *  3. Attach a fresh blockhash and fee payer.
   *  4. Sign, send, and confirm.
   *  5. Wipe secret key bytes regardless of outcome.
   */
  async signAndSendTransaction(transaction: Transaction): Promise<string> {
    this.assertReady();

    const connection = this.connection!;
    const state = this.state!;

    let keypair: Keypair | null = null;
    let signature: string;

    try {
      keypair = this.keystoreManager.decryptKeypair(this.keystoreId!, this.password);

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      transaction.feePayer = keypair.publicKey;
      transaction.recentBlockhash = blockhash;

      transaction.sign(keypair);

      // Broadcast before confirmation so we can emit 'transaction:submitted'
      // as early as possible for monitoring purposes.
      const rawTx = transaction.serialize();
      signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      this.emit('transaction:submitted', signature);

      await connection.confirmTransaction(signature, 'confirmed');

      state.transactionCount += 1;
      state.lastActivity = Date.now();

      this.emit('transaction:confirmed', signature);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('transaction:failed', error);
      throw error;
    } finally {
      if (keypair !== null) {
        keypair.secretKey.fill(0);
      }
    }

    return signature;
  }

  /**
   * Submit a pre-built serialized transaction (e.g. from Jupiter swap API).
   * Deserializes, signs, and broadcasts via the standard pipeline.
   *
   * @param base64Tx - Base64-encoded serialized transaction.
   * @returns The transaction signature.
   */
  async submitSerializedTransaction(base64Tx: string): Promise<string> {
    this.assertReady();

    const buffer = Buffer.from(base64Tx, 'base64');
    const transaction = Transaction.from(buffer);

    return this.signAndSendTransaction(transaction);
  }

  /**
   * Sign a transaction without broadcasting it. Useful for constructing
   * multi-sig or offline flows. Secret key is wiped after signing.
   */
  async signTransaction(transaction: Transaction): Promise<Transaction> {
    this.assertReady();

    let keypair: Keypair | null = null;

    try {
      keypair = this.keystoreManager.decryptKeypair(this.keystoreId!, this.password);

      const { blockhash } = await this.connection!.getLatestBlockhash('confirmed');
      transaction.feePayer = keypair.publicKey;
      transaction.recentBlockhash = blockhash;

      transaction.sign(keypair);
    } finally {
      if (keypair !== null) {
        keypair.secretKey.fill(0);
      }
    }

    return transaction;
  }

  /**
   * Request a SOL airdrop (devnet / testnet only). Retries up to three times
   * with exponential backoff. Emits 'wallet:funded' on success.
   */
  async requestAirdrop(amountSol: number = 1): Promise<string> {
    this.assertReady();

    const connection = this.connection!;
    const pubkey = new PublicKey(this.state!.publicKey);
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= AIRDROP_MAX_ATTEMPTS; attempt++) {
      try {
        const signature = await connection.requestAirdrop(pubkey, lamports);
        await connection.confirmTransaction(signature, 'confirmed');

        this.state!.balanceSol += amountSol;
        this.state!.lastActivity = Date.now();

        this.emit('wallet:funded', signature, amountSol);
        return signature;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < AIRDROP_MAX_ATTEMPTS) {
          const delayMs = AIRDROP_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await sleep(delayMs);
        }
      }
    }

    throw new Error(
      `Airdrop failed after ${AIRDROP_MAX_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
    );
  }

  // ── Lock / Unlock ───────────────────────────────────────────────────────────

  /**
   * Lock the wallet. Transaction methods will throw until `unlock()` is called.
   * Emits 'wallet:locked'.
   */
  lock(): void {
    this.locked = true;
    if (this.state) {
      this.state.status = 'locked';
    }
    this.emit('wallet:locked');
  }

  /**
   * Unlock the wallet by verifying the supplied password against the keystore.
   * Throws if the password is incorrect. Emits 'wallet:unlocked' on success.
   */
  unlock(password: string): void {
    if (!this.keystoreId) {
      throw new Error('Wallet has not been initialized');
    }

    const valid = this.keystoreManager.verifyPassword(this.keystoreId, password);
    if (!valid) {
      throw new Error('Unlock failed: incorrect password');
    }

    this.locked = false;
    if (this.state) {
      this.state.status = 'active';
    }
    this.emit('wallet:unlocked');
  }

  // ── Policy Engine ──────────────────────────────────────────────────────────

  /**
   * Attach a PolicyEngine to enforce spending limits, rate limits, and
   * program allowlists at the wallet level. When set, every SOL and SPL
   * transfer is validated against the policy chain before signing.
   */
  setPolicyEngine(engine: PolicyEngine): void {
    this.policyEngine = engine;
  }

  /** Return the attached PolicyEngine, or null if none is set. */
  getPolicyEngine(): PolicyEngine | null {
    return this.policyEngine;
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  /**
   * Return true when the wallet is initialized and not locked.
   * Use this guard before submitting transactions.
   */
  isReady(): boolean {
    return this.state !== null && this.keystoreId !== null && !this.locked;
  }

  /** Return a snapshot of the current wallet state, or null if uninitialized. */
  getState(): WalletState | null {
    return this.state;
  }

  /** Return the base58-encoded public key. Throws if not initialized. */
  getPublicKey(): string {
    if (!this.state) {
      throw new Error('Wallet has not been initialized');
    }
    return this.state.publicKey;
  }

  /** Return the keystore UUID. Throws if not initialized. */
  getKeystoreId(): string {
    if (!this.keystoreId) {
      throw new Error('Wallet has not been initialized');
    }
    return this.keystoreId;
  }

  /** Return the underlying Solana Connection. Throws if not initialized. */
  getConnection(): Connection {
    if (!this.connection) {
      throw new Error('Wallet has not been initialized');
    }
    return this.connection;
  }

  /**
   * Build a Solana Explorer URL for either the wallet address or a specific
   * transaction signature.
   *
   * @param signature — If provided, returns a transaction URL; otherwise returns
   *                    the account URL for the wallet's public key.
   */
  getExplorerUrl(signature?: string): string {
    const cluster = this.config.cluster;
    const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;

    if (signature) {
      return `https://explorer.solana.com/tx/${signature}${clusterParam}`;
    }

    const publicKey = this.state?.publicKey ?? '';
    return `https://explorer.solana.com/address/${publicKey}${clusterParam}`;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Validate a prospective transaction against the attached PolicyEngine.
   * No-op when no policy engine is set. Throws on policy violation so that
   * callers never need to check a return value.
   */
  private enforcePolicy(params: TransactionValidationParams): void {
    if (!this.policyEngine) return;

    const result = this.policyEngine.validateTransaction(params);
    if (!result.allowed) {
      const error = new Error(`Policy violation: ${result.reason}`);
      this.emit('transaction:failed', error, 'policy_violation');
      throw error;
    }
  }

  /** Instantiate a Solana Connection using the config RPC endpoint or the
   *  cluster default. */
  private buildConnection(): Connection {
    const endpoint =
      this.config.rpcEndpoint ?? DEFAULT_RPC_ENDPOINTS[this.config.cluster];
    return new Connection(endpoint, 'confirmed');
  }

  /**
   * Fetch the on-chain SOL balance for `publicKey` and convert from lamports
   * to SOL.
   */
  private async fetchBalance(publicKey: string): Promise<number> {
    const lamports = await this.connection!.getBalance(
      new PublicKey(publicKey),
      'confirmed',
    );
    return lamports / LAMPORTS_PER_SOL;
  }

  /**
   * Guard used at the top of every method that requires the wallet to be
   * initialized and unlocked.
   */
  private assertReady(): void {
    if (!this.state || !this.keystoreId || !this.connection) {
      throw new Error(
        'Wallet is not initialized. Call initialize() or initializeFromKeystore() first.',
      );
    }
    if (this.locked) {
      throw new Error('Wallet is locked. Call unlock() before performing operations.');
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Convenience factory: create and initialize a new AgenticWallet in one call.
 * Returns a fully initialized wallet ready to accept transactions.
 */
export async function createAgenticWallet(config: WalletConfig): Promise<AgenticWallet> {
  const wallet = new AgenticWallet(config);
  await wallet.initialize();
  return wallet;
}
