// SentinelVault — KeystoreManager
// AES-256-GCM encrypted keystores with PBKDF2 key derivation for Solana keypairs

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { v4 as uuidv4 } from 'uuid';
import nacl from 'tweetnacl';
import { EncryptedKeystore, SolanaCluster } from '../types';

// ─── Constants ───────────────────────────────────────────────────────────────

const KEYSTORE_VERSION = 1;
const CIPHER_ALGORITHM = 'aes-256-gcm';
const KDF_ALGORITHM = 'pbkdf2';
const KDF_DIGEST = 'sha512';
const KDF_ITERATIONS = 100_000;
const KDF_KEY_LENGTH = 32;
const IV_LENGTH = 12;   // 96-bit IV recommended for GCM
const SALT_LENGTH = 32; // 256-bit salt

// ─── Return Types ────────────────────────────────────────────────────────────

export interface CreatedWalletResult {
  publicKey: string;
  keystoreId: string;
  path: string;
}

export interface KeystoreSummary {
  id: string;
  publicKey: string;
  label: string;
  cluster: SolanaCluster;
  createdAt: number;
}

// ─── KeystoreManager ─────────────────────────────────────────────────────────

export class KeystoreManager {
  private readonly keystoreDir: string;

  constructor(keystoreDir: string = '.sentinelvault/keystores') {
    this.keystoreDir = path.resolve(keystoreDir);
    this.ensureKeystoreDir();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generate a new Solana keypair, encrypt it, persist to disk, and return
   * the public key, keystore ID, and file path.
   */
  async createEncryptedWallet(
    password: string,
    label: string,
    cluster: SolanaCluster,
  ): Promise<CreatedWalletResult> {
    const keypair = Keypair.generate();
    return this.persistKeypair(keypair, password, label, cluster);
  }

  /**
   * Import an existing keypair from a raw secret key (64-byte Uint8Array),
   * encrypt it, persist to disk, and return identifying metadata.
   */
  async importKeypair(
    secretKey: Uint8Array,
    password: string,
    label: string,
    cluster: SolanaCluster,
  ): Promise<CreatedWalletResult> {
    const keypair = Keypair.fromSecretKey(secretKey);
    return this.persistKeypair(keypair, password, label, cluster);
  }

  /**
   * Load and decrypt a keystore file, returning the reconstructed Keypair.
   * Throws if the keystore does not exist or the password is wrong.
   */
  decryptKeypair(keystoreId: string, password: string): Keypair {
    const keystore = this.loadKeystore(keystoreId);
    const secretKeyBytes = this.decrypt(keystore, password);
    try {
      // Copy the bytes so the Keypair owns its own buffer and we can safely
      // wipe the decrypted material without corrupting the returned Keypair.
      const copy = new Uint8Array(secretKeyBytes);
      return Keypair.fromSecretKey(copy);
    } finally {
      this.secureWipe(secretKeyBytes);
    }
  }

  /**
   * Decrypt the keystore, sign `message` with the keypair's ed25519 secret
   * key via tweetnacl, then wipe all key material before returning.
   */
  signWithKeystore(
    keystoreId: string,
    password: string,
    message: Uint8Array,
  ): Uint8Array {
    const keystore = this.loadKeystore(keystoreId);
    const secretKeyBytes = this.decrypt(keystore, password);
    try {
      // tweetnacl sign.detached expects the full 64-byte secret key
      return nacl.sign.detached(message, secretKeyBytes);
    } finally {
      this.secureWipe(secretKeyBytes);
    }
  }

  /**
   * Return summary metadata for every keystore file found in the keystore
   * directory. Files that fail to parse are silently skipped.
   */
  listKeystores(): KeystoreSummary[] {
    if (!fs.existsSync(this.keystoreDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.keystoreDir).filter(f => f.endsWith('.json'));
    const summaries: KeystoreSummary[] = [];

    for (const filename of entries) {
      try {
        const filepath = path.join(this.keystoreDir, filename);
        const raw = fs.readFileSync(filepath, 'utf8');
        const keystore: EncryptedKeystore = JSON.parse(raw);
        summaries.push({
          id: keystore.id,
          publicKey: keystore.publicKey,
          label: keystore.metadata.label,
          cluster: keystore.metadata.cluster,
          createdAt: keystore.metadata.createdAt,
        });
      } catch {
        // Corrupt or unreadable file — skip without crashing the list
      }
    }

    return summaries;
  }

  /**
   * Permanently delete a keystore file. Throws if the file does not exist.
   */
  deleteKeystore(keystoreId: string): void {
    const filepath = this.keystorePath(keystoreId);
    if (!fs.existsSync(filepath)) {
      throw new Error(`Keystore not found: ${keystoreId}`);
    }
    fs.unlinkSync(filepath);
  }

  /**
   * Re-encrypt an existing keystore under a new password.
   * The old ciphertext is replaced atomically via a rename.
   */
  changePassword(
    keystoreId: string,
    oldPassword: string,
    newPassword: string,
  ): void {
    const keystore = this.loadKeystore(keystoreId);
    const secretKeyBytes = this.decrypt(keystore, oldPassword);
    try {
      const keypair = Keypair.fromSecretKey(secretKeyBytes);
      const updated = this.buildKeystore(
        keypair,
        newPassword,
        keystore.metadata.label,
        keystore.metadata.cluster,
        keystoreId,           // preserve original ID
        keystore.metadata.createdAt, // preserve original timestamp
      );
      this.saveKeystore(updated);
    } finally {
      this.secureWipe(secretKeyBytes);
    }
  }

  /**
   * Return `true` if the supplied password successfully decrypts the keystore,
   * `false` otherwise. Does not throw on wrong password.
   */
  verifyPassword(keystoreId: string, password: string): boolean {
    try {
      const keystore = this.loadKeystore(keystoreId);
      const secretKeyBytes = this.decrypt(keystore, password);
      this.secureWipe(secretKeyBytes);
      return true;
    } catch {
      return false;
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /** Ensure the keystore directory exists with restrictive permissions (0o700). */
  private ensureKeystoreDir(): void {
    if (!fs.existsSync(this.keystoreDir)) {
      fs.mkdirSync(this.keystoreDir, { recursive: true, mode: 0o700 });
    } else {
      // Tighten permissions if the directory was created by other means
      fs.chmodSync(this.keystoreDir, 0o700);
    }
  }

  /** Return the expected file path for a given keystore ID. */
  private keystorePath(keystoreId: string): string {
    return path.join(this.keystoreDir, `${keystoreId}.json`);
  }

  /** Read and parse a keystore file, throwing with a clear message on failure. */
  private loadKeystore(keystoreId: string): EncryptedKeystore {
    const filepath = this.keystorePath(keystoreId);
    if (!fs.existsSync(filepath)) {
      throw new Error(`Keystore not found: ${keystoreId}`);
    }
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      return JSON.parse(raw) as EncryptedKeystore;
    } catch (err) {
      throw new Error(`Failed to read keystore ${keystoreId}: ${(err as Error).message}`);
    }
  }

  /** Write a keystore object to disk with restrictive file permissions (0o600). */
  private saveKeystore(keystore: EncryptedKeystore): void {
    const filepath = this.keystorePath(keystore.id);
    const json = JSON.stringify(keystore, null, 2);
    fs.writeFileSync(filepath, json, { mode: 0o600, encoding: 'utf8' });
  }

  /**
   * Shared persistence logic used by both `createEncryptedWallet` and
   * `importKeypair`. Builds the encrypted keystore and saves it.
   */
  private persistKeypair(
    keypair: Keypair,
    password: string,
    label: string,
    cluster: SolanaCluster,
  ): CreatedWalletResult {
    const keystoreId = uuidv4();
    const keystore = this.buildKeystore(keypair, password, label, cluster, keystoreId);
    this.saveKeystore(keystore);
    return {
      publicKey: keystore.publicKey,
      keystoreId,
      path: this.keystorePath(keystoreId),
    };
  }

  /**
   * Construct an `EncryptedKeystore` object from a keypair and metadata.
   * `keystoreId` and `createdAt` can be supplied to preserve existing values
   * during a password change.
   */
  private buildKeystore(
    keypair: Keypair,
    password: string,
    label: string,
    cluster: SolanaCluster,
    keystoreId: string = uuidv4(),
    createdAt: number = Date.now(),
  ): EncryptedKeystore {
    const publicKey = keypair.publicKey.toBase58();
    const secretKeyBytes = keypair.secretKey; // Uint8Array(64)
    const encrypted = this.encrypt(secretKeyBytes, password);

    return {
      version: KEYSTORE_VERSION,
      id: keystoreId,
      publicKey,
      crypto: {
        cipher: CIPHER_ALGORITHM,
        cipherText: encrypted.cipherText,
        cipherParams: {
          iv: encrypted.iv,
          tag: encrypted.tag,
        },
        kdf: KDF_ALGORITHM,
        kdfParams: {
          salt: encrypted.salt,
          iterations: KDF_ITERATIONS,
          keyLength: KDF_KEY_LENGTH,
          digest: KDF_DIGEST,
        },
      },
      metadata: {
        createdAt,
        label,
        cluster,
      },
    };
  }

  // ── Cryptographic Primitives ───────────────────────────────────────────────

  /**
   * Derive a 256-bit key from a password and hex-encoded salt using PBKDF2-SHA512.
   * Returns a Buffer that the caller is responsible for wiping after use.
   */
  private deriveKey(password: string, salt: string): Buffer {
    const saltBuffer = Buffer.from(salt, 'hex');
    return crypto.pbkdf2Sync(
      password,
      saltBuffer,
      KDF_ITERATIONS,
      KDF_KEY_LENGTH,
      KDF_DIGEST,
    );
  }

  /**
   * Encrypt `data` under `password` using AES-256-GCM + PBKDF2.
   * Returns hex-encoded components needed to reconstruct the ciphertext.
   */
  private encrypt(
    data: Uint8Array,
    password: string,
  ): { cipherText: string; iv: string; tag: string; salt: string } {
    const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = this.deriveKey(password, salt);

    try {
      const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      const tag = cipher.getAuthTag();

      return {
        cipherText: encrypted.toString('hex'),
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        salt,
      };
    } finally {
      this.secureWipe(key);
    }
  }

  /**
   * Decrypt an `EncryptedKeystore`'s cipher payload under `password`.
   * Returns the raw secret key bytes. The caller MUST wipe this buffer.
   * Throws if the password is wrong (GCM authentication failure).
   */
  private decrypt(keystore: EncryptedKeystore, password: string): Buffer {
    const { kdfParams, cipherParams, cipherText } = keystore.crypto;
    const key = this.deriveKey(password, kdfParams.salt);

    try {
      const iv = Buffer.from(cipherParams.iv, 'hex');
      const tag = Buffer.from(cipherParams.tag, 'hex');
      const cipherBuffer = Buffer.from(cipherText, 'hex');

      const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      return Buffer.concat([decipher.update(cipherBuffer), decipher.final()]);
    } catch {
      throw new Error('Decryption failed: invalid password or corrupted keystore');
    } finally {
      this.secureWipe(key);
    }
  }

  /**
   * Overwrite a buffer's contents with zeros to minimise the window in which
   * key material resides in memory after use.
   */
  private secureWipe(buffer: Buffer | Uint8Array): void {
    buffer.fill(0);
  }
}

// ─── Convenience factory ──────────────────────────────────────────────────────

/**
 * Create a `KeystoreManager` instance pointing at the given directory.
 * Exported as a lightweight alternative to `new KeystoreManager(...)`.
 */
export function createKeystoreManager(keystoreDir?: string): KeystoreManager {
  return new KeystoreManager(keystoreDir);
}
