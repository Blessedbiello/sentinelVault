// SentinelVault — AmmClient Test Suite
// Tests PDA derivation, instruction building, pool price calculation,
// swap output calculation, and on-chain account deserialization.

import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AmmClient } from '../src/integrations/amm-client';

// ── Mock @solana/web3.js Connection ─────────────────────────────────────────

const mockGetAccountInfo = jest.fn();

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getAccountInfo: mockGetAccountInfo,
    })),
  };
});

jest.mock('@solana/spl-token', () => {
  const { PublicKey: PK } = jest.requireActual('@solana/web3.js');
  return {
    TOKEN_PROGRAM_ID: new PK('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey('Frdq7Ro6txmf5YuWLiCuKyVrSiY1tmFDCtTU6CfxQub2');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function createClient(): AmmClient {
  const { Connection } = require('@solana/web3.js');
  const conn = new Connection('https://api.devnet.solana.com');
  return new AmmClient(conn);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AmmClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── PDA Derivation ──────────────────────────────────────────────────────

  describe('derivePoolPDA', () => {
    it('returns a deterministic PDA for a given authority and mint', () => {
      const client = createClient();
      const authority = PublicKey.unique();
      const mint = PublicKey.unique();

      const [pda1, bump1] = client.derivePoolPDA(authority, mint);
      const [pda2, bump2] = client.derivePoolPDA(authority, mint);

      expect(pda1.equals(pda2)).toBe(true);
      expect(bump1).toBe(bump2);
      expect(bump1).toBeGreaterThanOrEqual(0);
      expect(bump1).toBeLessThanOrEqual(255);
    });

    it('returns different PDAs for different authorities', () => {
      const client = createClient();
      const auth1 = PublicKey.unique();
      const auth2 = PublicKey.unique();
      const mint = PublicKey.unique();

      const [pda1] = client.derivePoolPDA(auth1, mint);
      const [pda2] = client.derivePoolPDA(auth2, mint);

      expect(pda1.equals(pda2)).toBe(false);
    });

    it('returns different PDAs for different mints', () => {
      const client = createClient();
      const authority = PublicKey.unique();
      const mint1 = PublicKey.unique();
      const mint2 = PublicKey.unique();

      const [pda1] = client.derivePoolPDA(authority, mint1);
      const [pda2] = client.derivePoolPDA(authority, mint2);

      expect(pda1.equals(pda2)).toBe(false);
    });

    it('derives PDA using correct seeds [pool, authority, mint]', () => {
      const client = createClient();
      const authority = PublicKey.unique();
      const mint = PublicKey.unique();

      const [pda] = client.derivePoolPDA(authority, mint);

      // Verify by deriving manually
      const [expected] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool'), authority.toBuffer(), mint.toBuffer()],
        PROGRAM_ID,
      );

      expect(pda.equals(expected)).toBe(true);
    });
  });

  // ── Instruction Builders ────────────────────────────────────────────────

  describe('buildCreatePoolIx', () => {
    it('builds instruction with correct program ID and account count', () => {
      const client = createClient();
      const authority = PublicKey.unique();
      const mint = PublicKey.unique();

      const ix = client.buildCreatePoolIx(authority, mint, 30);

      expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
      expect(ix.keys).toHaveLength(8); // authority, mint, poolPDA, poolATA, system, token, ata, rent
    });

    it('serializes fee_bps correctly in instruction data', () => {
      const client = createClient();
      const authority = PublicKey.unique();
      const mint = PublicKey.unique();

      const ix = client.buildCreatePoolIx(authority, mint, 30);

      // Data: 8 bytes discriminator + 2 bytes fee_bps
      expect(ix.data.length).toBe(10);
      expect(ix.data.readUInt16LE(8)).toBe(30);
    });

    it('marks authority as signer and writable', () => {
      const client = createClient();
      const authority = PublicKey.unique();
      const mint = PublicKey.unique();

      const ix = client.buildCreatePoolIx(authority, mint, 30);

      expect(ix.keys[0].pubkey.equals(authority)).toBe(true);
      expect(ix.keys[0].isSigner).toBe(true);
      expect(ix.keys[0].isWritable).toBe(true);
    });
  });

  describe('buildAddLiquidityIx', () => {
    it('serializes sol_amount and token_amount correctly', () => {
      const client = createClient();
      const authority = PublicKey.unique();
      const pool = PublicKey.unique();
      const mint = PublicKey.unique();
      const authorityATA = PublicKey.unique();
      const poolATA = PublicKey.unique();

      const ix = client.buildAddLiquidityIx(
        authority, pool, mint, authorityATA, poolATA,
        500_000_000, // 0.5 SOL in lamports
        1_000_000_000, // 1B tokens
      );

      // Data: 8 bytes discriminator + 8 bytes sol + 8 bytes tokens
      expect(ix.data.length).toBe(24);
      expect(Number(ix.data.readBigUInt64LE(8))).toBe(500_000_000);
      expect(Number(ix.data.readBigUInt64LE(16))).toBe(1_000_000_000);
    });

    it('has 7 account keys', () => {
      const client = createClient();
      const ix = client.buildAddLiquidityIx(
        PublicKey.unique(), PublicKey.unique(), PublicKey.unique(),
        PublicKey.unique(), PublicKey.unique(),
        100, 200,
      );
      expect(ix.keys).toHaveLength(7);
    });
  });

  describe('buildSwapSolForTokenIx', () => {
    it('serializes sol_in and min_token_out correctly', () => {
      const client = createClient();

      const ix = client.buildSwapSolForTokenIx(
        PublicKey.unique(), PublicKey.unique(), PublicKey.unique(),
        PublicKey.unique(), PublicKey.unique(),
        10_000_000, // 0.01 SOL
        5000,       // min 5000 tokens
      );

      expect(ix.data.length).toBe(24);
      expect(Number(ix.data.readBigUInt64LE(8))).toBe(10_000_000);
      expect(Number(ix.data.readBigUInt64LE(16))).toBe(5000);
    });

    it('includes system_program and token_program in accounts', () => {
      const client = createClient();
      const user = PublicKey.unique();

      const ix = client.buildSwapSolForTokenIx(
        user, PublicKey.unique(), PublicKey.unique(),
        PublicKey.unique(), PublicKey.unique(),
        1000, 0,
      );

      const programIds = ix.keys.map(k => k.pubkey.toBase58());
      expect(programIds).toContain(SystemProgram.programId.toBase58());
      expect(programIds).toContain(TOKEN_PROGRAM_ID.toBase58());
    });
  });

  describe('buildSwapTokenForSolIx', () => {
    it('serializes token_in and min_sol_out correctly', () => {
      const client = createClient();

      const ix = client.buildSwapTokenForSolIx(
        PublicKey.unique(), PublicKey.unique(), PublicKey.unique(),
        PublicKey.unique(), PublicKey.unique(),
        50000,      // 50000 tokens
        1_000_000,  // min 0.001 SOL
      );

      expect(ix.data.length).toBe(24);
      expect(Number(ix.data.readBigUInt64LE(8))).toBe(50000);
      expect(Number(ix.data.readBigUInt64LE(16))).toBe(1_000_000);
    });

    it('does NOT include system_program (uses lamport manipulation)', () => {
      const client = createClient();

      const ix = client.buildSwapTokenForSolIx(
        PublicKey.unique(), PublicKey.unique(), PublicKey.unique(),
        PublicKey.unique(), PublicKey.unique(),
        1000, 0,
      );

      const programIds = ix.keys.map(k => k.pubkey.toBase58());
      expect(programIds).not.toContain(SystemProgram.programId.toBase58());
      expect(programIds).toContain(TOKEN_PROGRAM_ID.toBase58());
    });
  });

  // ── Pool Price Calculation ──────────────────────────────────────────────

  describe('getPoolPrice', () => {
    it('returns sol_reserve / token_reserve', () => {
      const client = createClient();

      const price = client.getPoolPrice({
        authority: 'auth',
        tokenMint: 'mint',
        poolTokenAccount: 'pta',
        solReserve: 500_000_000,   // 0.5 SOL in lamports
        tokenReserve: 1_000_000_000, // 1B tokens
        feeBps: 30,
        bump: 255,
      });

      expect(price).toBeCloseTo(0.5, 5);
    });

    it('returns 0 when token_reserve is 0', () => {
      const client = createClient();

      const price = client.getPoolPrice({
        authority: 'auth',
        tokenMint: 'mint',
        poolTokenAccount: 'pta',
        solReserve: 500_000_000,
        tokenReserve: 0,
        feeBps: 30,
        bump: 255,
      });

      expect(price).toBe(0);
    });
  });

  // ── Swap Output Calculation ─────────────────────────────────────────────

  describe('calculateSwapOutput', () => {
    it('returns correct token output using constant-product formula with fee', () => {
      const client = createClient();

      // Pool: 1000 SOL, 1000000 tokens, 30 bps fee
      // Swap 10 SOL
      // sol_in_after_fee = 10 * (10000 - 30) = 99700
      // numerator = 1000000 * 99700 = 99,700,000,000
      // denominator = 1000 * 10000 + 99700 = 10,099,700
      // token_out = floor(99700000000 / 10099700) = 9871 (approx)
      const output = client.calculateSwapOutput(10, 1000, 1_000_000, 30);

      expect(output).toBeGreaterThan(9800);
      expect(output).toBeLessThan(10000);
    });

    it('returns 0 when pool has no liquidity', () => {
      const client = createClient();

      expect(client.calculateSwapOutput(10, 0, 1000, 30)).toBe(0);
      expect(client.calculateSwapOutput(10, 1000, 0, 30)).toBe(0);
    });

    it('output increases with larger input', () => {
      const client = createClient();

      const small = client.calculateSwapOutput(1, 1000, 1_000_000, 30);
      const large = client.calculateSwapOutput(10, 1000, 1_000_000, 30);

      expect(large).toBeGreaterThan(small);
    });

    it('higher fee means less output', () => {
      const client = createClient();

      const lowFee = client.calculateSwapOutput(10, 1000, 1_000_000, 10);
      const highFee = client.calculateSwapOutput(10, 1000, 1_000_000, 100);

      expect(lowFee).toBeGreaterThan(highFee);
    });
  });

  // ── On-Chain Read ────────────────────────────────────────────────────────

  describe('getPoolState', () => {
    it('returns null when account does not exist', async () => {
      mockGetAccountInfo.mockResolvedValue(null);
      const client = createClient();

      const state = await client.getPoolState(PublicKey.unique());

      expect(state).toBeNull();
    });

    it('deserializes a valid pool state account', async () => {
      // Build a mock 123-byte PoolState account
      const data = Buffer.alloc(123);
      // 8-byte discriminator (arbitrary)
      data.fill(0xAA, 0, 8);
      // authority (32 bytes)
      const authority = PublicKey.unique();
      authority.toBuffer().copy(data, 8);
      // token_mint (32 bytes)
      const mint = PublicKey.unique();
      mint.toBuffer().copy(data, 40);
      // pool_token_account (32 bytes)
      const poolATA = PublicKey.unique();
      poolATA.toBuffer().copy(data, 72);
      // sol_reserve (u64 LE)
      data.writeBigUInt64LE(BigInt(500_000_000), 104);
      // token_reserve (u64 LE)
      data.writeBigUInt64LE(BigInt(1_000_000_000), 112);
      // fee_bps (u16 LE)
      data.writeUInt16LE(30, 120);
      // bump (u8)
      data.writeUInt8(254, 122);

      mockGetAccountInfo.mockResolvedValue({ data, lamports: 1_000_000_000 });
      const client = createClient();

      const state = await client.getPoolState(PublicKey.unique());

      expect(state).not.toBeNull();
      expect(state!.authority).toBe(authority.toBase58());
      expect(state!.tokenMint).toBe(mint.toBase58());
      expect(state!.poolTokenAccount).toBe(poolATA.toBase58());
      expect(state!.solReserve).toBe(500_000_000);
      expect(state!.tokenReserve).toBe(1_000_000_000);
      expect(state!.feeBps).toBe(30);
      expect(state!.bump).toBe(254);
    });

    it('returns null when account data is too small', async () => {
      mockGetAccountInfo.mockResolvedValue({ data: Buffer.alloc(50), lamports: 0 });
      const client = createClient();

      const state = await client.getPoolState(PublicKey.unique());
      expect(state).toBeNull();
    });
  });

  // ── Program ID ──────────────────────────────────────────────────────────

  describe('getProgramId', () => {
    it('returns the SentinelVault program ID', () => {
      const client = createClient();
      expect(client.getProgramId().toBase58()).toBe('Frdq7Ro6txmf5YuWLiCuKyVrSiY1tmFDCtTU6CfxQub2');
    });
  });
});
