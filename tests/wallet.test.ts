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

jest.mock('../src/core/keystore', () => ({
  KeystoreManager: jest.fn().mockImplementation(() => ({
    createEncryptedWallet: mockCreateEncryptedWallet,
    decryptKeypair: mockDecryptKeypair,
    verifyPassword: mockVerifyPassword,
  })),
}));

// ── Mock @solana/web3.js Connection ─────────────────────────────────────────

const mockGetBalance = jest.fn().mockResolvedValue(2 * LAMPORTS_PER_SOL);
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
});
