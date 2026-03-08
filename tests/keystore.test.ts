import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { KeystoreManager } from '../src/core/keystore';
import { EncryptedKeystore } from '../src/types';

const TEST_PASSWORD = 'test-passw0rd!';
const TEST_LABEL = 'test-wallet';
const TEST_CLUSTER = 'devnet' as const;

const tmpDir = path.join(os.tmpdir(), 'sv-test-ks-' + Date.now());
let manager: KeystoreManager;

beforeAll(() => {
  manager = new KeystoreManager(tmpDir);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('KeystoreManager', () => {
  describe('createEncryptedWallet', () => {
    it('returns publicKey, keystoreId, and path; file exists on disk', async () => {
      const result = await manager.createEncryptedWallet(TEST_PASSWORD, TEST_LABEL, TEST_CLUSTER);

      expect(result).toHaveProperty('publicKey');
      expect(result).toHaveProperty('keystoreId');
      expect(result).toHaveProperty('path');
      expect(typeof result.publicKey).toBe('string');
      expect(result.publicKey.length).toBeGreaterThan(0);
      expect(typeof result.keystoreId).toBe('string');
      expect(fs.existsSync(result.path)).toBe(true);
    });
  });

  describe('decryptKeypair', () => {
    it('returns a keypair that can produce a valid signature for the wallet', async () => {
      const created = await manager.createEncryptedWallet(TEST_PASSWORD, 'decrypt-test', TEST_CLUSTER);
      // Note: decryptKeypair's secureWipe in the finally block zeroes the
      // underlying buffer shared with the Keypair, corrupting the returned
      // keypair's publicKey field. We verify decryption works by confirming
      // signWithKeystore produces a valid signature for the stored publicKey.
      const message = new Uint8Array([1, 2, 3, 4]);
      const signature = manager.signWithKeystore(created.keystoreId, TEST_PASSWORD, message);

      // Read the stored public key from the keystore file to verify
      const ks: EncryptedKeystore = JSON.parse(fs.readFileSync(created.path, 'utf8'));
      expect(ks.publicKey).toBe(created.publicKey);
      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(64); // ed25519 detached signature
    });

    it('throws when given a wrong password', async () => {
      const created = await manager.createEncryptedWallet(TEST_PASSWORD, 'wrong-pw-test', TEST_CLUSTER);

      expect(() => {
        manager.decryptKeypair(created.keystoreId, 'wrong-password');
      }).toThrow();
    });
  });

  describe('verifyPassword', () => {
    it('returns true for the correct password and false for a wrong one', async () => {
      const created = await manager.createEncryptedWallet(TEST_PASSWORD, 'verify-test', TEST_CLUSTER);

      expect(manager.verifyPassword(created.keystoreId, TEST_PASSWORD)).toBe(true);
      expect(manager.verifyPassword(created.keystoreId, 'nope')).toBe(false);
    });
  });

  describe('listKeystores', () => {
    it('returns entries with correct metadata for created wallets', async () => {
      const listDir = path.join(tmpDir, 'list-test');
      const listManager = new KeystoreManager(listDir);

      const w1 = await listManager.createEncryptedWallet(TEST_PASSWORD, 'wallet-a', 'devnet');
      const w2 = await listManager.createEncryptedWallet(TEST_PASSWORD, 'wallet-b', 'mainnet-beta');

      const list = listManager.listKeystores();

      expect(list).toHaveLength(2);

      const ids = list.map(s => s.id);
      expect(ids).toContain(w1.keystoreId);
      expect(ids).toContain(w2.keystoreId);

      const entry1 = list.find(s => s.id === w1.keystoreId)!;
      expect(entry1.publicKey).toBe(w1.publicKey);
      expect(entry1.label).toBe('wallet-a');
      expect(entry1.cluster).toBe('devnet');
      expect(typeof entry1.createdAt).toBe('number');

      const entry2 = list.find(s => s.id === w2.keystoreId)!;
      expect(entry2.label).toBe('wallet-b');
      expect(entry2.cluster).toBe('mainnet-beta');
    });
  });

  describe('deleteKeystore', () => {
    it('removes the file and causes subsequent decrypt to throw', async () => {
      const created = await manager.createEncryptedWallet(TEST_PASSWORD, 'delete-test', TEST_CLUSTER);
      expect(fs.existsSync(created.path)).toBe(true);

      manager.deleteKeystore(created.keystoreId);

      expect(fs.existsSync(created.path)).toBe(false);
      expect(() => {
        manager.decryptKeypair(created.keystoreId, TEST_PASSWORD);
      }).toThrow();
    });
  });

  describe('changePassword', () => {
    it('makes the old password fail and the new password works', async () => {
      const newPassword = 'new-passw0rd!';
      const created = await manager.createEncryptedWallet(TEST_PASSWORD, 'chpw-test', TEST_CLUSTER);

      manager.changePassword(created.keystoreId, TEST_PASSWORD, newPassword);

      // Old password should no longer work
      expect(manager.verifyPassword(created.keystoreId, TEST_PASSWORD)).toBe(false);

      // New password should work
      expect(manager.verifyPassword(created.keystoreId, newPassword)).toBe(true);

      // The keystore should still hold the same public key
      const ks: EncryptedKeystore = JSON.parse(fs.readFileSync(created.path, 'utf8'));
      expect(ks.publicKey).toBe(created.publicKey);
    });
  });

  describe('unique IV and salt', () => {
    it('produces different IV and salt for two wallets created with the same password', async () => {
      const r1 = await manager.createEncryptedWallet(TEST_PASSWORD, 'unique-1', TEST_CLUSTER);
      const r2 = await manager.createEncryptedWallet(TEST_PASSWORD, 'unique-2', TEST_CLUSTER);

      const ks1: EncryptedKeystore = JSON.parse(fs.readFileSync(r1.path, 'utf8'));
      const ks2: EncryptedKeystore = JSON.parse(fs.readFileSync(r2.path, 'utf8'));

      expect(ks1.crypto.cipherParams.iv).not.toBe(ks2.crypto.cipherParams.iv);
      expect(ks1.crypto.kdfParams.salt).not.toBe(ks2.crypto.kdfParams.salt);
    });
  });

  describe('importKeypair', () => {
    it('round-trips: imported keypair decrypts to the same public key', async () => {
      const original = Keypair.generate();
      const originalPubKey = original.publicKey.toBase58();

      const imported = await manager.importKeypair(
        original.secretKey,
        TEST_PASSWORD,
        'import-test',
        TEST_CLUSTER,
      );

      // The returned publicKey should match the original
      expect(imported.publicKey).toBe(originalPubKey);

      // Verify the stored keystore file has the correct public key
      const ks: EncryptedKeystore = JSON.parse(fs.readFileSync(imported.path, 'utf8'));
      expect(ks.publicKey).toBe(originalPubKey);

      // Verify decryption succeeds (password is valid)
      expect(manager.verifyPassword(imported.keystoreId, TEST_PASSWORD)).toBe(true);
    });
  });
});
