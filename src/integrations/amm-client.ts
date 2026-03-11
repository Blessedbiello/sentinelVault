// SentinelVault — AmmClient
// Constructs raw Anchor instructions for the on-chain constant-product AMM.
// No @coral-xyz/anchor runtime dependency — uses manual discriminator+serialization
// following the same pattern as the vault instructions in wallet.ts.

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PoolState } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** SentinelVault program ID (deployed on devnet). */
const PROGRAM_ID = new PublicKey('Frdq7Ro6txmf5YuWLiCuKyVrSiY1tmFDCtTU6CfxQub2');

/** Associated Token Program ID. */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Anchor instruction discriminators: first 8 bytes of sha256("global:<name>").
 * Pre-computed for the AMM instructions.
 */
const AMM_IX_DISCRIMINATOR = {
  createPool:       Buffer.from([233, 146, 209, 142, 207, 104, 64, 188]),
  addLiquidity:     Buffer.from([181, 157, 89, 67, 143, 182, 52, 72]),
  swapSolForToken:  Buffer.from([241, 106, 222, 44, 89, 254, 233, 161]),
  swapTokenForSol:  Buffer.from([253, 34, 238, 50, 70, 172, 220, 33]),
};

/** Discriminator length (8 bytes) + PoolState fields for on-chain deserialization. */
const POOL_STATE_ACCOUNT_SIZE = 8 + 32 + 32 + 32 + 8 + 8 + 2 + 1; // 123 bytes

// ─── AmmClient ────────────────────────────────────────────────────────────────

export class AmmClient {
  constructor(private connection: Connection) {}

  // ── PDA Derivation ────────────────────────────────────────────────────────

  /** Derive the pool PDA address from authority and token mint. */
  derivePoolPDA(authority: PublicKey, tokenMint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), authority.toBuffer(), tokenMint.toBuffer()],
      PROGRAM_ID,
    );
  }

  /** Derive the associated token account for a given owner and mint. */
  deriveATA(owner: PublicKey, mint: PublicKey): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    return ata;
  }

  // ── Instruction Builders ──────────────────────────────────────────────────

  /** Build a create_pool instruction. */
  buildCreatePoolIx(
    authority: PublicKey,
    tokenMint: PublicKey,
    feeBps: number,
  ): TransactionInstruction {
    const [poolPDA] = this.derivePoolPDA(authority, tokenMint);
    const poolATA = this.deriveATA(poolPDA, tokenMint);

    // Serialize: discriminator (8) + fee_bps (u16 LE, 2)
    const data = Buffer.alloc(10);
    AMM_IX_DISCRIMINATOR.createPool.copy(data, 0);
    data.writeUInt16LE(feeBps, 8);

    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: poolATA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /** Build an add_liquidity instruction. */
  buildAddLiquidityIx(
    authority: PublicKey,
    poolPDA: PublicKey,
    tokenMint: PublicKey,
    authorityATA: PublicKey,
    poolATA: PublicKey,
    solAmount: number,
    tokenAmount: number,
  ): TransactionInstruction {
    // Serialize: discriminator (8) + sol_amount (u64 LE, 8) + token_amount (u64 LE, 8)
    const data = Buffer.alloc(24);
    AMM_IX_DISCRIMINATOR.addLiquidity.copy(data, 0);
    data.writeBigUInt64LE(BigInt(solAmount), 8);
    data.writeBigUInt64LE(BigInt(tokenAmount), 16);

    // IDL order: authority, pool_state, token_mint, authority_token_account, pool_token_account, system_program, token_program
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: authorityATA, isSigner: false, isWritable: true },
        { pubkey: poolATA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /** Build a swap_sol_for_token instruction. */
  buildSwapSolForTokenIx(
    user: PublicKey,
    poolPDA: PublicKey,
    tokenMint: PublicKey,
    poolATA: PublicKey,
    userATA: PublicKey,
    solIn: number,
    minTokenOut: number,
  ): TransactionInstruction {
    // Serialize: discriminator (8) + sol_in (u64 LE, 8) + min_token_out (u64 LE, 8)
    const data = Buffer.alloc(24);
    AMM_IX_DISCRIMINATOR.swapSolForToken.copy(data, 0);
    data.writeBigUInt64LE(BigInt(solIn), 8);
    data.writeBigUInt64LE(BigInt(minTokenOut), 16);

    // IDL order: user, pool_state, token_mint, pool_token_account, user_token_account, system_program, token_program
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: poolATA, isSigner: false, isWritable: true },
        { pubkey: userATA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /** Build a swap_token_for_sol instruction. */
  buildSwapTokenForSolIx(
    user: PublicKey,
    poolPDA: PublicKey,
    tokenMint: PublicKey,
    poolATA: PublicKey,
    userATA: PublicKey,
    tokenIn: number,
    minSolOut: number,
  ): TransactionInstruction {
    // Serialize: discriminator (8) + token_in (u64 LE, 8) + min_sol_out (u64 LE, 8)
    const data = Buffer.alloc(24);
    AMM_IX_DISCRIMINATOR.swapTokenForSol.copy(data, 0);
    data.writeBigUInt64LE(BigInt(tokenIn), 8);
    data.writeBigUInt64LE(BigInt(minSolOut), 16);

    // IDL order: user, pool_state, token_mint, pool_token_account, user_token_account, token_program
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: poolATA, isSigner: false, isWritable: true },
        { pubkey: userATA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  // ── On-Chain Reads ────────────────────────────────────────────────────────

  /** Fetch and deserialize a PoolState account. Returns null if not found. */
  async getPoolState(poolPDA: PublicKey): Promise<PoolState | null> {
    const accountInfo = await this.connection.getAccountInfo(poolPDA);
    if (!accountInfo || accountInfo.data.length < POOL_STATE_ACCOUNT_SIZE) {
      return null;
    }

    const data = accountInfo.data;

    // Skip 8-byte Anchor discriminator
    const authority = new PublicKey(data.subarray(8, 40)).toBase58();
    const tokenMint = new PublicKey(data.subarray(40, 72)).toBase58();
    const poolTokenAccount = new PublicKey(data.subarray(72, 104)).toBase58();
    const solReserve = Number(data.readBigUInt64LE(104));
    const tokenReserve = Number(data.readBigUInt64LE(112));
    const feeBps = data.readUInt16LE(120);
    const bump = data.readUInt8(122);

    return {
      authority,
      tokenMint,
      poolTokenAccount,
      solReserve,
      tokenReserve,
      feeBps,
      bump,
    };
  }

  /** Calculate the current pool price (SOL per token). */
  getPoolPrice(pool: PoolState): number {
    if (pool.tokenReserve === 0) return 0;
    return pool.solReserve / pool.tokenReserve;
  }

  /**
   * Calculate expected token output for a given SOL input using constant-product formula.
   * Includes fee deduction.
   */
  calculateSwapOutput(
    solIn: number,
    solReserve: number,
    tokenReserve: number,
    feeBps: number,
  ): number {
    if (solReserve === 0 || tokenReserve === 0) return 0;

    const solInAfterFee = solIn * (10000 - feeBps);
    const numerator = tokenReserve * solInAfterFee;
    const denominator = solReserve * 10000 + solInAfterFee;

    return Math.floor(numerator / denominator);
  }

  /** Get the program ID. */
  getProgramId(): PublicKey {
    return PROGRAM_ID;
  }
}
