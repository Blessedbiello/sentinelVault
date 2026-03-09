import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { AgenticWallet } from '../src/core/wallet';
import { WalletConfig } from '../src/types';

// ── Mock KeystoreManager ────────────────────────────────────────────────────

const testKeypair = Keypair.generate();
const TEST_PUBLIC_KEY = testKeypair.publicKey.toBase58();

const mockCreateEncryptedWallet = jest.fn().mockResolvedValue({
  publicKey: TEST_PUBLIC_KEY,
  keystoreId: 'test-ks-id',
  path: '/tmp/test',
});
const mockDecryptKeypair = jest.fn().mockReturnValue(testKeypair);
const mockVerifyPassword = jest.fn().mockReturnValue(true);

jest.mock('../src/core/keystore', () => ({
  KeystoreManager: jest.fn().mockImplementation(() => ({
    createEncryptedWallet: mockCreateEncryptedWallet,
    decryptKeypair: mockDecryptKeypair,
    verifyPassword: mockVerifyPassword,
  })),
}));

// ── Mock @solana/web3.js Connection ─────────────────────────────────────────

const MOCK_SIGNATURE = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQU';

const mockGetBalance = jest.fn().mockResolvedValue(2 * LAMPORTS_PER_SOL);
const mockGetLatestBlockhash = jest.fn().mockResolvedValue({
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
  lastValidBlockHeight: 100,
});
const mockSendRawTransaction = jest.fn().mockResolvedValue(MOCK_SIGNATURE);
const mockConfirmTransaction = jest.fn().mockResolvedValue({ value: {} });
const mockRequestAirdrop = jest.fn().mockResolvedValue(MOCK_SIGNATURE);
const mockGetParsedTokenAccountsByOwner = jest.fn().mockResolvedValue({ value: [] });

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getBalance: mockGetBalance,
      getLatestBlockhash: mockGetLatestBlockhash,
      sendRawTransaction: mockSendRawTransaction,
      confirmTransaction: mockConfirmTransaction,
      requestAirdrop: mockRequestAirdrop,
      getParsedTokenAccountsByOwner: mockGetParsedTokenAccountsByOwner,
    })),
  };
});

// ── Mock @solana/spl-token ─────────────────────────────────────────────────

// jest.mock is hoisted, so we generate mock addresses inside the factory
// and then import them via require() in tests that need the values.
jest.mock('@solana/spl-token', () => {
  const { Keypair: KP, PublicKey: PK } = jest.requireActual('@solana/web3.js');
  const mintPk = KP.generate().publicKey;
  const ataPk = KP.generate().publicKey;
  return {
    __mockMintAddress: mintPk,
    __mockAtaAddress: ataPk,
    createMint: jest.fn().mockResolvedValue(mintPk),
    getOrCreateAssociatedTokenAccount: jest.fn().mockResolvedValue({
      address: ataPk,
      mint: mintPk,
      owner: KP.generate().publicKey,
    }),
    mintTo: jest.fn().mockResolvedValue(
      '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQU',
    ),
    transfer: jest.fn().mockResolvedValue(
      '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQU',
    ),
    getAccount: jest.fn(),
    TOKEN_PROGRAM_ID: new PK('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: WalletConfig = {
  id: 'wallet-ops-1',
  label: 'Test Wallet Ops',
  password: 'test-passw0rd!',
  cluster: 'devnet',
};

async function createInitializedWallet(overrides: Partial<WalletConfig> = {}): Promise<AgenticWallet> {
  const wallet = new AgenticWallet({ ...DEFAULT_CONFIG, ...overrides });
  await wallet.initialize();
  return wallet;
}

// Access mock addresses via the mocked module
function getMockMintAddress(): PublicKey {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@solana/spl-token').__mockMintAddress;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgenticWallet — Transaction Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── transferSOL ──────────────────────────────────────────────────────────

  describe('transferSOL', () => {
    it('sends SOL and returns a transaction signature', async () => {
      const wallet = await createInitializedWallet();
      const destination = Keypair.generate().publicKey.toBase58();

      const sig = await wallet.transferSOL(destination, 0.5);

      expect(sig).toBe(MOCK_SIGNATURE);
      expect(mockSendRawTransaction).toHaveBeenCalledTimes(1);
      expect(mockConfirmTransaction).toHaveBeenCalledWith(MOCK_SIGNATURE, 'confirmed');
    });

    it('increments transactionCount after successful transfer', async () => {
      const wallet = await createInitializedWallet();
      const destination = Keypair.generate().publicKey.toBase58();

      await wallet.transferSOL(destination, 0.1);

      expect(wallet.getState()!.transactionCount).toBe(1);
    });

    it('emits transaction:submitted and transaction:confirmed events', async () => {
      const wallet = await createInitializedWallet();
      const destination = Keypair.generate().publicKey.toBase58();

      const submitted = jest.fn();
      const confirmed = jest.fn();
      wallet.on('transaction:submitted', submitted);
      wallet.on('transaction:confirmed', confirmed);

      await wallet.transferSOL(destination, 0.1);

      expect(submitted).toHaveBeenCalledWith(MOCK_SIGNATURE);
      expect(confirmed).toHaveBeenCalledWith(MOCK_SIGNATURE);
    });

    it('throws for non-positive amounts', async () => {
      const wallet = await createInitializedWallet();
      const destination = Keypair.generate().publicKey.toBase58();

      await expect(wallet.transferSOL(destination, 0)).rejects.toThrow('positive');
      await expect(wallet.transferSOL(destination, -1)).rejects.toThrow('positive');
    });

    it('throws when wallet is not initialized', async () => {
      const wallet = new AgenticWallet(DEFAULT_CONFIG);

      await expect(
        wallet.transferSOL(Keypair.generate().publicKey.toBase58(), 0.1),
      ).rejects.toThrow('not initialized');
    });

    it('throws when wallet is locked', async () => {
      const wallet = await createInitializedWallet();
      wallet.lock();

      await expect(
        wallet.transferSOL(Keypair.generate().publicKey.toBase58(), 0.1),
      ).rejects.toThrow('locked');
    });

    it('emits transaction:failed on network error', async () => {
      mockSendRawTransaction.mockRejectedValueOnce(new Error('network error'));

      const wallet = await createInitializedWallet();
      const failHandler = jest.fn();
      wallet.on('transaction:failed', failHandler);

      await expect(
        wallet.transferSOL(Keypair.generate().publicKey.toBase58(), 0.1),
      ).rejects.toThrow('network error');

      expect(failHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ── signAndSendTransaction ───────────────────────────────────────────────

  describe('signAndSendTransaction', () => {
    it('signs, sends, and confirms a transaction', async () => {
      const wallet = await createInitializedWallet();

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: testKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000,
        }),
      );

      const sig = await wallet.signAndSendTransaction(tx);

      expect(sig).toBe(MOCK_SIGNATURE);
      expect(mockGetLatestBlockhash).toHaveBeenCalled();
      expect(mockSendRawTransaction).toHaveBeenCalled();
      expect(mockConfirmTransaction).toHaveBeenCalledWith(MOCK_SIGNATURE, 'confirmed');
    });

    it('emits transaction:failed on error', async () => {
      mockSendRawTransaction.mockRejectedValueOnce(new Error('tx failed'));
      const wallet = await createInitializedWallet();

      const failHandler = jest.fn();
      wallet.on('transaction:failed', failHandler);

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: testKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000,
        }),
      );

      await expect(wallet.signAndSendTransaction(tx)).rejects.toThrow('tx failed');
      expect(failHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ── sendMemo ─────────────────────────────────────────────────────────────

  describe('sendMemo', () => {
    it('sends a memo and returns a transaction signature', async () => {
      const wallet = await createInitializedWallet();

      const sig = await wallet.sendMemo('Hello from SentinelVault agent');

      expect(sig).toBe(MOCK_SIGNATURE);
      expect(mockSendRawTransaction).toHaveBeenCalledTimes(1);
    });

    it('increments transactionCount', async () => {
      const wallet = await createInitializedWallet();

      await wallet.sendMemo('test memo');

      expect(wallet.getState()!.transactionCount).toBe(1);
    });
  });

  // ── requestAirdrop ───────────────────────────────────────────────────────

  describe('requestAirdrop', () => {
    it('requests and confirms an airdrop', async () => {
      const wallet = await createInitializedWallet();

      const sig = await wallet.requestAirdrop(1);

      expect(sig).toBe(MOCK_SIGNATURE);
      expect(mockRequestAirdrop).toHaveBeenCalledTimes(1);
      expect(wallet.getState()!.balanceSol).toBe(1);
    });

    it('emits wallet:funded on success', async () => {
      const wallet = await createInitializedWallet();
      const handler = jest.fn();
      wallet.on('wallet:funded', handler);

      await wallet.requestAirdrop(2);

      expect(handler).toHaveBeenCalledWith(MOCK_SIGNATURE, 2);
    });

    it('retries on failure with exponential backoff', async () => {
      mockRequestAirdrop
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValueOnce(MOCK_SIGNATURE);

      const wallet = await createInitializedWallet();
      const sig = await wallet.requestAirdrop(1);

      expect(sig).toBe(MOCK_SIGNATURE);
      expect(mockRequestAirdrop).toHaveBeenCalledTimes(2);
    }, 15000);

    it('throws after all retry attempts fail', async () => {
      mockRequestAirdrop.mockRejectedValue(new Error('rate limited'));

      const wallet = await createInitializedWallet();

      await expect(wallet.requestAirdrop(1)).rejects.toThrow('Airdrop failed after');
      expect(mockRequestAirdrop).toHaveBeenCalledTimes(3);
    }, 30000);
  });

  // ── createTokenMint ──────────────────────────────────────────────────────

  describe('createTokenMint', () => {
    it('creates a mint and returns its address', async () => {
      const wallet = await createInitializedWallet();

      const { createMint } = require('@solana/spl-token');

      const mintAddr = await wallet.createTokenMint(9);

      expect(mintAddr).toBe(getMockMintAddress().toBase58());
      expect(createMint).toHaveBeenCalledTimes(1);
      expect(wallet.getState()!.transactionCount).toBe(1);
    });

    it('emits transaction:failed on error', async () => {
      const { createMint } = require('@solana/spl-token');
      createMint.mockRejectedValueOnce(new Error('mint failed'));

      const wallet = await createInitializedWallet();
      const failHandler = jest.fn();
      wallet.on('transaction:failed', failHandler);

      await expect(wallet.createTokenMint(6)).rejects.toThrow('mint failed');
      expect(failHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ── mintTokens ───────────────────────────────────────────────────────────

  describe('mintTokens', () => {
    it('mints tokens and returns the transaction signature', async () => {
      const wallet = await createInitializedWallet();

      const { mintTo } = require('@solana/spl-token');

      const sig = await wallet.mintTokens(getMockMintAddress().toBase58(), 1_000_000);

      expect(sig).toBe(MOCK_SIGNATURE);
      expect(mintTo).toHaveBeenCalledTimes(1);
      expect(wallet.getState()!.transactionCount).toBe(1);
    });
  });

  // ── transferToken ────────────────────────────────────────────────────────

  describe('transferToken', () => {
    it('transfers tokens and returns the transaction signature', async () => {
      const wallet = await createInitializedWallet();
      const destination = Keypair.generate().publicKey.toBase58();

      const { transfer: splTransfer } = require('@solana/spl-token');

      const sig = await wallet.transferToken(getMockMintAddress().toBase58(), destination, 500_000);

      expect(sig).toBe(MOCK_SIGNATURE);
      expect(splTransfer).toHaveBeenCalledTimes(1);
      expect(wallet.getState()!.transactionCount).toBe(1);
    });

    it('emits transaction:confirmed event', async () => {
      const wallet = await createInitializedWallet();
      const destination = Keypair.generate().publicKey.toBase58();

      const handler = jest.fn();
      wallet.on('transaction:confirmed', handler);

      await wallet.transferToken(getMockMintAddress().toBase58(), destination, 100);

      expect(handler).toHaveBeenCalledWith(MOCK_SIGNATURE);
    });

    it('emits transaction:failed on error', async () => {
      const { transfer: splTransfer } = require('@solana/spl-token');
      splTransfer.mockRejectedValueOnce(new Error('insufficient funds'));

      const wallet = await createInitializedWallet();
      const failHandler = jest.fn();
      wallet.on('transaction:failed', failHandler);

      await expect(
        wallet.transferToken(getMockMintAddress().toBase58(), Keypair.generate().publicKey.toBase58(), 100),
      ).rejects.toThrow('insufficient funds');

      expect(failHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ── getTokenBalances ─────────────────────────────────────────────────────

  describe('getTokenBalances', () => {
    it('returns empty array when no token accounts exist', async () => {
      const wallet = await createInitializedWallet();

      const balances = await wallet.getTokenBalances();

      expect(balances).toEqual([]);
    });

    it('parses token accounts into TokenBalance objects', async () => {
      mockGetParsedTokenAccountsByOwner.mockResolvedValueOnce({
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    mint: getMockMintAddress().toBase58(),
                    tokenAmount: {
                      amount: '1000000000',
                      decimals: 9,
                      uiAmountString: '1.0',
                    },
                  },
                },
              },
            },
          },
        ],
      });

      const wallet = await createInitializedWallet();
      const balances = await wallet.getTokenBalances();

      expect(balances).toHaveLength(1);
      expect(balances[0].mint).toBe(getMockMintAddress().toBase58());
      expect(balances[0].decimals).toBe(9);
      expect(balances[0].uiBalance).toBe('1.0');
      expect(balances[0].balance).toBe(1000000000);
    });
  });

  // ── submitSerializedTransaction ──────────────────────────────────────────

  describe('submitSerializedTransaction', () => {
    it('deserializes, signs, and sends a base64-encoded transaction', async () => {
      const wallet = await createInitializedWallet();

      // Build a transaction, serialize it to base64
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: testKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000,
        }),
      );
      tx.feePayer = testKeypair.publicKey;
      tx.recentBlockhash = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

      const base64Tx = tx.serialize({ requireAllSignatures: false }).toString('base64');

      const sig = await wallet.submitSerializedTransaction(base64Tx);

      expect(sig).toBe(MOCK_SIGNATURE);
      expect(mockSendRawTransaction).toHaveBeenCalled();
    });
  });

  // ── signTransaction ──────────────────────────────────────────────────────

  describe('signTransaction', () => {
    it('signs without broadcasting', async () => {
      const wallet = await createInitializedWallet();

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: testKeypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000,
        }),
      );

      const signed = await wallet.signTransaction(tx);

      expect(signed.signature).not.toBeNull();
      expect(mockSendRawTransaction).not.toHaveBeenCalled();
    });
  });

  // ── Policy Enforcement at Wallet Level ─────────────────────────────────

  describe('policy enforcement', () => {
    it('blocks transferSOL when policy rejects the transaction', async () => {
      const { PolicyEngine } = require('../src/security/policy-engine');
      const policyEngine = new PolicyEngine('test-agent', {
        spendingLimits: { perTransaction: 0.05, hourly: 5, daily: 20, weekly: 100, monthly: 500 },
        allowedPrograms: ['11111111111111111111111111111111'],
        blockedAddresses: [],
        requireSimulation: false,
        maxTransactionsPerMinute: 10,
        maxTransactionsPerHour: 60,
        maxTransactionsPerDay: 500,
        alertThresholds: [],
      });

      const wallet = await createInitializedWallet();
      wallet.setPolicyEngine(policyEngine);

      // 0.1 SOL exceeds per-transaction limit of 0.05
      await expect(
        wallet.transferSOL(Keypair.generate().publicKey.toBase58(), 0.1),
      ).rejects.toThrow('Policy violation');
    });

    it('allows transferSOL when policy approves', async () => {
      const { PolicyEngine } = require('../src/security/policy-engine');
      const policyEngine = new PolicyEngine('test-agent', {
        spendingLimits: { perTransaction: 1, hourly: 5, daily: 20, weekly: 100, monthly: 500 },
        allowedPrograms: ['11111111111111111111111111111111'],
        blockedAddresses: [],
        requireSimulation: false,
        maxTransactionsPerMinute: 10,
        maxTransactionsPerHour: 60,
        maxTransactionsPerDay: 500,
        alertThresholds: [],
      });

      const wallet = await createInitializedWallet();
      wallet.setPolicyEngine(policyEngine);

      const sig = await wallet.transferSOL(Keypair.generate().publicKey.toBase58(), 0.1);
      expect(sig).toBe(MOCK_SIGNATURE);
    });

    it('blocks transferSOL to a blocked address', async () => {
      const blockedAddr = Keypair.generate().publicKey.toBase58();

      const { PolicyEngine } = require('../src/security/policy-engine');
      const policyEngine = new PolicyEngine('test-agent', {
        spendingLimits: { perTransaction: 1, hourly: 5, daily: 20, weekly: 100, monthly: 500 },
        allowedPrograms: ['11111111111111111111111111111111'],
        blockedAddresses: [blockedAddr],
        requireSimulation: false,
        maxTransactionsPerMinute: 10,
        maxTransactionsPerHour: 60,
        maxTransactionsPerDay: 500,
        alertThresholds: [],
      });

      const wallet = await createInitializedWallet();
      wallet.setPolicyEngine(policyEngine);

      await expect(
        wallet.transferSOL(blockedAddr, 0.01),
      ).rejects.toThrow('Policy violation');
    });

    it('records confirmed transactions in the policy engine spending windows', async () => {
      const { PolicyEngine } = require('../src/security/policy-engine');
      const policyEngine = new PolicyEngine('test-agent', {
        spendingLimits: { perTransaction: 1, hourly: 5, daily: 20, weekly: 100, monthly: 500 },
        allowedPrograms: ['11111111111111111111111111111111'],
        blockedAddresses: [],
        requireSimulation: false,
        maxTransactionsPerMinute: 10,
        maxTransactionsPerHour: 60,
        maxTransactionsPerDay: 500,
        alertThresholds: [],
      });

      const wallet = await createInitializedWallet();
      wallet.setPolicyEngine(policyEngine);

      await wallet.transferSOL(Keypair.generate().publicKey.toBase58(), 0.5);

      const summary = policyEngine.getSpendingSummary();
      expect(summary.hourly.amount).toBe(0.5);
      expect(summary.daily.amount).toBe(0.5);
    });

    it('works without a policy engine (no-op)', async () => {
      const wallet = await createInitializedWallet();

      // No setPolicyEngine called — should work normally
      const sig = await wallet.transferSOL(Keypair.generate().publicKey.toBase58(), 0.1);
      expect(sig).toBe(MOCK_SIGNATURE);
    });
  });
});
