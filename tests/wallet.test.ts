import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
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
const mockListKeystores = jest.fn().mockReturnValue([]);

jest.mock('../src/core/keystore', () => ({
  KeystoreManager: jest.fn().mockImplementation(() => ({
    createEncryptedWallet: mockCreateEncryptedWallet,
    decryptKeypair: mockDecryptKeypair,
    verifyPassword: mockVerifyPassword,
    listKeystores: mockListKeystores,
  })),
}));

// ── Mock @solana/web3.js Connection ─────────────────────────────────────────

const mockGetBalance = jest.fn().mockResolvedValue(2 * LAMPORTS_PER_SOL);
const mockGetTransaction = jest.fn().mockResolvedValue(null);
const mockGetLatestBlockhash = jest.fn().mockResolvedValue({
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
  lastValidBlockHeight: 100,
});
const mockSendRawTransaction = jest.fn().mockResolvedValue(
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQU',
);
const mockConfirmTransaction = jest.fn().mockResolvedValue({ value: {} });

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getBalance: mockGetBalance,
      getTransaction: mockGetTransaction,
      getLatestBlockhash: mockGetLatestBlockhash,
      sendRawTransaction: mockSendRawTransaction,
      confirmTransaction: mockConfirmTransaction,
    })),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: WalletConfig = {
  id: 'wallet-1',
  label: 'Test Wallet',
  password: 'test-passw0rd!',
  cluster: 'devnet',
};

function createWallet(overrides: Partial<WalletConfig> = {}): AgenticWallet {
  return new AgenticWallet({ ...DEFAULT_CONFIG, ...overrides });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgenticWallet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── initialize ──────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('creates valid wallet state with address and cluster', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      const state = wallet.getState();
      expect(state).not.toBeNull();
      expect(state!.publicKey).toBe(TEST_PUBLIC_KEY);
      expect(state!.cluster).toBe('devnet');
      expect(state!.status).toBe('active');
      expect(state!.balanceSol).toBe(0);
      expect(state!.id).toBe('wallet-1');
      expect(state!.label).toBe('Test Wallet');
    });

    it('emits wallet:created event with state', async () => {
      const wallet = createWallet();
      const handler = jest.fn();
      wallet.on('wallet:created', handler);

      await wallet.initialize();

      expect(handler).toHaveBeenCalledTimes(1);
      const emittedState = handler.mock.calls[0][0];
      expect(emittedState.publicKey).toBe(TEST_PUBLIC_KEY);
      expect(emittedState.cluster).toBe('devnet');
    });
  });

  // ── getBalance ──────────────────────────────────────────────────────────

  describe('getBalance', () => {
    it('returns correct SOL amount from lamports', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      const balance = await wallet.getBalance();
      expect(balance).toBe(2.0);
      expect(mockGetBalance).toHaveBeenCalledTimes(1);
    });
  });

  // ── lock / unlock ───────────────────────────────────────────────────────

  describe('lock', () => {
    it('sets status to locked and isReady returns false', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      wallet.lock();

      expect(wallet.isReady()).toBe(false);
      expect(wallet.getState()!.status).toBe('locked');
    });

    it('emits wallet:locked event', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      const handler = jest.fn();
      wallet.on('wallet:locked', handler);
      wallet.lock();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('unlock', () => {
    it('restores ready state with correct password', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      wallet.lock();
      expect(wallet.isReady()).toBe(false);

      wallet.unlock('test-passw0rd!');

      expect(wallet.isReady()).toBe(true);
      expect(wallet.getState()!.status).toBe('active');
    });

    it('emits wallet:unlocked event', async () => {
      const wallet = createWallet();
      await wallet.initialize();
      wallet.lock();

      const handler = jest.fn();
      wallet.on('wallet:unlocked', handler);
      wallet.unlock('test-passw0rd!');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('throws when password is incorrect', async () => {
      mockVerifyPassword.mockReturnValueOnce(false);
      const wallet = createWallet();
      await wallet.initialize();
      wallet.lock();

      expect(() => wallet.unlock('wrong-password')).toThrow('incorrect password');
    });
  });

  // ── isReady ─────────────────────────────────────────────────────────────

  describe('isReady', () => {
    it('returns false before initialize', () => {
      const wallet = createWallet();
      expect(wallet.isReady()).toBe(false);
    });

    it('returns true after initialize', async () => {
      const wallet = createWallet();
      await wallet.initialize();
      expect(wallet.isReady()).toBe(true);
    });
  });

  // ── getExplorerUrl ──────────────────────────────────────────────────────

  describe('getExplorerUrl', () => {
    it('returns address URL with cluster param for devnet', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      const url = wallet.getExplorerUrl();
      expect(url).toBe(
        `https://explorer.solana.com/address/${TEST_PUBLIC_KEY}?cluster=devnet`,
      );
    });

    it('returns transaction URL when signature is provided', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      const sig = 'fakeSig123';
      const url = wallet.getExplorerUrl(sig);
      expect(url).toBe(
        `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      );
    });

    it('omits cluster param for mainnet-beta', () => {
      const wallet = createWallet({ cluster: 'mainnet-beta' });
      const url = wallet.getExplorerUrl();
      expect(url).toBe(`https://explorer.solana.com/address/`);
    });
  });

  // ── Accessors before init ───────────────────────────────────────────────

  describe('getPublicKey', () => {
    it('throws when wallet is not initialized', () => {
      const wallet = createWallet();
      expect(() => wallet.getPublicKey()).toThrow('not been initialized');
    });
  });

  describe('getKeystoreId', () => {
    it('returns keystore ID after initialization', async () => {
      const wallet = createWallet();
      await wallet.initialize();
      expect(wallet.getKeystoreId()).toBe('test-ks-id');
    });
  });

  // ── enrichTransactionResult ───────────────────────────────────────────

  describe('enrichTransactionResult', () => {
    it('returns real metadata from confirmed transaction', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      mockGetTransaction.mockResolvedValueOnce({
        slot: 12345,
        meta: { fee: 5000 },
        blockTime: 1700000000,
      });

      const result = await wallet.enrichTransactionResult('test-sig');
      expect(result.slot).toBe(12345);
      expect(result.fee).toBe(5000);
      expect(result.blockTime).toBe(1700000000);
    });

    it('returns defaults when getTransaction returns null', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      mockGetTransaction.mockResolvedValueOnce(null);

      const result = await wallet.enrichTransactionResult('test-sig');
      expect(result.slot).toBe(0);
      expect(result.fee).toBe(0);
      expect(result.blockTime).toBeNull();
    });
  });

  // ── Policy enforcement on transferSOL ──────────────────────────────────

  describe('transferSOL policy enforcement', () => {
    it('enforces policy before Kora path', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      // Set up a policy engine that blocks the transfer
      const { PolicyEngine } = require('../src/security/policy-engine');
      const policy = PolicyEngine.createDefaultPolicy();
      policy.spendingLimits.perTransaction = 0.001; // very low limit
      const engine = new PolicyEngine('test-agent', policy);
      wallet.setPolicyEngine(engine);

      // Even with Kora available, policy should block first
      await expect(wallet.transferSOL('11111111111111111111111111111111', 0.01))
        .rejects.toThrow('Policy violation');
    });

    it('rejects invalid destination address', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      await expect(wallet.transferSOL('not-a-valid-address', 0.01))
        .rejects.toThrow('Invalid destination address');
    });
  });

  // ── submitSerializedTransaction ────────────────────────────────────────

  describe('submitSerializedTransaction', () => {
    it('handles versioned transactions (0x80 flag) via sendRawTransaction', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      // Create a buffer that starts with 0x80 (versioned transaction flag)
      const versionedBuffer = Buffer.alloc(100);
      versionedBuffer[0] = 0x80;
      const base64Tx = versionedBuffer.toString('base64');

      mockSendRawTransaction.mockResolvedValueOnce('versioned-sig');
      mockConfirmTransaction.mockResolvedValueOnce({ value: {} });

      const sig = await wallet.submitSerializedTransaction(base64Tx);
      expect(sig).toBe('versioned-sig');
      expect(mockSendRawTransaction).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ skipPreflight: false, preflightCommitment: 'confirmed' }),
      );
    });
  });

  // ── Transaction Simulation ──────────────────────────────────────────────

  describe('Transaction Simulation', () => {
    it('simulateTransaction returns success for valid tx', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      // Mock the Connection.simulateTransaction to return a successful result
      const mockSimulate = jest.fn().mockResolvedValueOnce({
        value: {
          err: null,
          logs: ['Program log: success'],
          unitsConsumed: 5000,
          accounts: null,
          returnData: null,
        },
      });

      // Inject the mock into the wallet's internal connection
      (wallet as any).connection.simulateTransaction = mockSimulate;

      // Build a minimal Transaction object (simulate accepts a Transaction)
      const { Transaction, SystemProgram, PublicKey } = jest.requireActual('@solana/web3.js');
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(TEST_PUBLIC_KEY),
          toPubkey: new PublicKey(TEST_PUBLIC_KEY),
          lamports: 1000,
        }),
      );

      const result = await wallet.simulateTransaction(tx);
      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
      expect(result.logs).toContain('Program log: success');
      expect(result.unitsConsumed).toBe(5000);
    });

    it('simulateTransaction returns error details on failure', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      const mockSimulate = jest.fn().mockResolvedValueOnce({
        value: {
          err: { InstructionError: [0, 'Custom:1'] },
          logs: ['Program log: failed'],
          unitsConsumed: 0,
          accounts: null,
          returnData: null,
        },
      });

      (wallet as any).connection.simulateTransaction = mockSimulate;

      const { Transaction, SystemProgram, PublicKey } = jest.requireActual('@solana/web3.js');
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(TEST_PUBLIC_KEY),
          toPubkey: new PublicKey(TEST_PUBLIC_KEY),
          lamports: 1000,
        }),
      );

      const result = await wallet.simulateTransaction(tx);
      expect(result.success).toBe(false);
      expect(result.error).not.toBeNull();
      // The error field should contain some representation of the error object
      expect(result.error).toContain('InstructionError');
    });

    it('simulateTransaction returns failure when connection throws', async () => {
      const wallet = createWallet();
      await wallet.initialize();

      const mockSimulate = jest.fn().mockRejectedValueOnce(new Error('RPC node offline'));
      (wallet as any).connection.simulateTransaction = mockSimulate;

      const { Transaction, SystemProgram, PublicKey } = jest.requireActual('@solana/web3.js');
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(TEST_PUBLIC_KEY),
          toPubkey: new PublicKey(TEST_PUBLIC_KEY),
          lamports: 1000,
        }),
      );

      const result = await wallet.simulateTransaction(tx);
      expect(result.success).toBe(false);
      expect(result.error).toBe('RPC node offline');
    });
  });

  // ── Wallet Persistence (load-or-create) ─────────────────────────────────────

  describe('wallet persistence', () => {
    it('should reload existing wallet on second initialize with same label', async () => {
      // First initialize: no existing keystore, creates new
      mockListKeystores.mockReturnValue([]);
      const wallet1 = new AgenticWallet({
        id: 'w1', label: 'persist-test', password: 'pw', cluster: 'devnet',
      });
      await wallet1.initialize();
      const addr1 = wallet1.getPublicKey();

      // Second initialize: existing keystore found, reloads
      mockListKeystores.mockReturnValue([
        { id: 'test-ks-id', label: 'persist-test', cluster: 'devnet', createdAt: Date.now() },
      ]);
      const wallet2 = new AgenticWallet({
        id: 'w2', label: 'persist-test', password: 'pw', cluster: 'devnet',
      });
      await wallet2.initialize();
      const addr2 = wallet2.getPublicKey();

      expect(addr2).toBe(addr1); // Same label → same wallet
      expect(mockVerifyPassword).toHaveBeenCalledWith('test-ks-id', 'pw');
    });

    it('should create new wallet when no matching label exists', async () => {
      mockListKeystores.mockReturnValue([
        { id: 'other-ks', label: 'different-label', cluster: 'devnet', createdAt: Date.now() },
      ]);
      const wallet3 = new AgenticWallet({
        id: 'w3', label: 'unique-label', password: 'pw', cluster: 'devnet',
      });
      await wallet3.initialize();

      expect(mockCreateEncryptedWallet).toHaveBeenCalled();
    });
  });
});
