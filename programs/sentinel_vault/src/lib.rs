use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("Frdq7Ro6txmf5YuWLiCuKyVrSiY1tmFDCtTU6CfxQub2");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const MIN_DEPOSIT_LAMPORTS: u64 = 100_000;
pub const VAULT_STATE_SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1;
pub const POOL_STATE_SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 2 + 1;
const BPS_DENOMINATOR: u128 = 10_000;

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod sentinel_vault {
    use super::*;

    // ── Vault Instructions ──────────────────────────────────────────────────

    pub fn initialize_vault(ctx: Context<InitializeVault>, agent_id: [u8; 32]) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.owner = ctx.accounts.owner.key();
        vault.agent_id = agent_id;
        vault.deposit_count = 0;
        vault.total_deposited = 0;
        vault.total_withdrawn = 0;
        vault.bump = ctx.bumps.vault_state;
        msg!("Vault initialized. owner={} bump={}", vault.owner, vault.bump);
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64, reason_tag: u8) -> Result<()> {
        require!(amount >= MIN_DEPOSIT_LAMPORTS, VaultError::AmountTooSmall);

        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.vault_state.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;

        let vault = &mut ctx.accounts.vault_state;
        vault.deposit_count = vault.deposit_count.checked_add(1).unwrap();
        vault.total_deposited = vault.total_deposited.checked_add(amount).unwrap();

        let clock = Clock::get()?;
        emit!(VaultDeposit { vault: vault.key(), amount, reason_tag, timestamp: clock.unix_timestamp });
        msg!("Deposit: vault={} amount={} ts={}", vault.key(), amount, clock.unix_timestamp);
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.vault_state.owner, VaultError::Unauthorized);

        let vault_info = ctx.accounts.vault_state.to_account_info();
        let rent = Rent::get()?;
        let minimum_balance = rent.minimum_balance(VAULT_STATE_SIZE);
        let current_balance = vault_info.lamports();
        let spendable = current_balance.checked_sub(minimum_balance).ok_or(VaultError::InsufficientFunds)?;
        require!(amount <= spendable, VaultError::InsufficientFunds);

        **vault_info.try_borrow_mut_lamports()? = current_balance.checked_sub(amount).ok_or(VaultError::InsufficientFunds)?;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? =
            ctx.accounts.owner.to_account_info().lamports().checked_add(amount).unwrap();

        let vault = &mut ctx.accounts.vault_state;
        vault.total_withdrawn = vault.total_withdrawn.checked_add(amount).unwrap();

        let clock = Clock::get()?;
        emit!(VaultWithdraw { vault: vault.key(), amount, timestamp: clock.unix_timestamp });
        msg!("Withdraw: vault={} amount={} ts={}", vault.key(), amount, clock.unix_timestamp);
        Ok(())
    }

    // ── AMM Instructions ────────────────────────────────────────────────────

    pub fn create_pool(ctx: Context<CreatePool>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1000, PoolError::InvalidFee);

        let pool = &mut ctx.accounts.pool_state;
        pool.authority = ctx.accounts.authority.key();
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.pool_token_account = ctx.accounts.pool_token_account.key();
        pool.sol_reserve = 0;
        pool.token_reserve = 0;
        pool.fee_bps = fee_bps;
        pool.bump = ctx.bumps.pool_state;

        msg!("Pool created: authority={} mint={} fee_bps={}", pool.authority, pool.token_mint, fee_bps);
        Ok(())
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>, sol_amount: u64, token_amount: u64) -> Result<()> {
        require!(sol_amount > 0, PoolError::ZeroAmount);
        require!(token_amount > 0, PoolError::ZeroAmount);
        require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.pool_state.authority, VaultError::Unauthorized);

        // Transfer SOL from authority to pool PDA
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.pool_state.to_account_info(),
                },
            ),
            sol_amount,
        )?;

        // Transfer tokens from authority ATA to pool ATA
        let decimals = ctx.accounts.token_mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.authority_token_account.to_account_info(),
                    to: ctx.accounts.pool_token_account.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                },
            ),
            token_amount,
            decimals,
        )?;

        let pool = &mut ctx.accounts.pool_state;
        pool.sol_reserve = pool.sol_reserve.checked_add(sol_amount).ok_or(PoolError::MathOverflow)?;
        pool.token_reserve = pool.token_reserve.checked_add(token_amount).ok_or(PoolError::MathOverflow)?;

        msg!("Liquidity added: sol={} tokens={} reserves=({}, {})", sol_amount, token_amount, pool.sol_reserve, pool.token_reserve);
        Ok(())
    }

    pub fn swap_sol_for_token(ctx: Context<SwapSolForToken>, sol_in: u64, min_token_out: u64) -> Result<()> {
        require!(sol_in > 0, PoolError::ZeroAmount);

        let pool = &ctx.accounts.pool_state;
        require!(pool.sol_reserve > 0 && pool.token_reserve > 0, PoolError::PoolEmpty);

        let fee_bps = pool.fee_bps as u128;
        let sol_in_128 = sol_in as u128;
        let sol_reserve_128 = pool.sol_reserve as u128;
        let token_reserve_128 = pool.token_reserve as u128;

        let sol_in_after_fee = sol_in_128
            .checked_mul(BPS_DENOMINATOR.checked_sub(fee_bps).ok_or(PoolError::MathOverflow)?)
            .ok_or(PoolError::MathOverflow)?;
        let numerator = token_reserve_128.checked_mul(sol_in_after_fee).ok_or(PoolError::MathOverflow)?;
        let denominator = sol_reserve_128.checked_mul(BPS_DENOMINATOR).ok_or(PoolError::MathOverflow)?
            .checked_add(sol_in_after_fee).ok_or(PoolError::MathOverflow)?;
        let token_out = numerator.checked_div(denominator).ok_or(PoolError::MathOverflow)? as u64;

        require!(token_out >= min_token_out, PoolError::SlippageExceeded);
        require!(token_out <= pool.token_reserve, PoolError::PoolEmpty);

        // SOL: user → pool PDA
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.pool_state.to_account_info(),
                },
            ),
            sol_in,
        )?;

        // Tokens: pool ATA → user ATA (PDA-signed)
        let authority_key = ctx.accounts.pool_state.authority;
        let mint_key = ctx.accounts.pool_state.token_mint;
        let bump = ctx.accounts.pool_state.bump;
        let seeds: &[&[u8]] = &[b"pool", authority_key.as_ref(), mint_key.as_ref(), &[bump]];

        let decimals = ctx.accounts.token_mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.pool_token_account.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                },
                &[seeds],
            ),
            token_out,
            decimals,
        )?;

        let pool = &mut ctx.accounts.pool_state;
        pool.sol_reserve = pool.sol_reserve.checked_add(sol_in).ok_or(PoolError::MathOverflow)?;
        pool.token_reserve = pool.token_reserve.checked_sub(token_out).ok_or(PoolError::MathOverflow)?;

        let clock = Clock::get()?;
        emit!(SwapEvent {
            pool: pool.key(), user: ctx.accounts.user.key(),
            sol_amount: sol_in, token_amount: token_out, direction: 0,
            new_sol_reserve: pool.sol_reserve, new_token_reserve: pool.token_reserve,
            timestamp: clock.unix_timestamp,
        });
        msg!("Swap SOL→Token: sol_in={} token_out={} reserves=({}, {})", sol_in, token_out, pool.sol_reserve, pool.token_reserve);
        Ok(())
    }

    pub fn swap_token_for_sol(ctx: Context<SwapTokenForSol>, token_in: u64, min_sol_out: u64) -> Result<()> {
        require!(token_in > 0, PoolError::ZeroAmount);

        let pool = &ctx.accounts.pool_state;
        require!(pool.sol_reserve > 0 && pool.token_reserve > 0, PoolError::PoolEmpty);

        let fee_bps = pool.fee_bps as u128;
        let token_in_128 = token_in as u128;
        let sol_reserve_128 = pool.sol_reserve as u128;
        let token_reserve_128 = pool.token_reserve as u128;

        let token_in_after_fee = token_in_128
            .checked_mul(BPS_DENOMINATOR.checked_sub(fee_bps).ok_or(PoolError::MathOverflow)?)
            .ok_or(PoolError::MathOverflow)?;
        let numerator = sol_reserve_128.checked_mul(token_in_after_fee).ok_or(PoolError::MathOverflow)?;
        let denominator = token_reserve_128.checked_mul(BPS_DENOMINATOR).ok_or(PoolError::MathOverflow)?
            .checked_add(token_in_after_fee).ok_or(PoolError::MathOverflow)?;
        let sol_out = numerator.checked_div(denominator).ok_or(PoolError::MathOverflow)? as u64;

        require!(sol_out >= min_sol_out, PoolError::SlippageExceeded);

        // Ensure pool retains rent-exemption
        let pool_info = ctx.accounts.pool_state.to_account_info();
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(POOL_STATE_SIZE);
        let available_sol = pool_info.lamports().saturating_sub(min_balance);
        require!(sol_out <= available_sol, PoolError::PoolEmpty);

        // Tokens: user ATA → pool ATA
        let decimals = ctx.accounts.token_mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.pool_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                },
            ),
            token_in,
            decimals,
        )?;

        // SOL: pool PDA → user (lamport manipulation)
        let pool_lamports = pool_info.lamports();
        **pool_info.try_borrow_mut_lamports()? = pool_lamports.checked_sub(sol_out).ok_or(PoolError::MathOverflow)?;
        let user_info = ctx.accounts.user.to_account_info();
        **user_info.try_borrow_mut_lamports()? = user_info.lamports().checked_add(sol_out).ok_or(PoolError::MathOverflow)?;

        let pool = &mut ctx.accounts.pool_state;
        pool.sol_reserve = pool.sol_reserve.checked_sub(sol_out).ok_or(PoolError::MathOverflow)?;
        pool.token_reserve = pool.token_reserve.checked_add(token_in).ok_or(PoolError::MathOverflow)?;

        let clock = Clock::get()?;
        emit!(SwapEvent {
            pool: pool.key(), user: ctx.accounts.user.key(),
            sol_amount: sol_out, token_amount: token_in, direction: 1,
            new_sol_reserve: pool.sol_reserve, new_token_reserve: pool.token_reserve,
            timestamp: clock.unix_timestamp,
        });
        msg!("Swap Token→SOL: token_in={} sol_out={} reserves=({}, {})", token_in, sol_out, pool.sol_reserve, pool.token_reserve);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts — Vault
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(agent_id: [u8; 32])]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = VAULT_STATE_SIZE, seeds = [b"vault", owner.key().as_ref(), &agent_id], bump)]
    pub vault_state: Account<'info, VaultState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref(), &vault_state.agent_id], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref(), &vault_state.agent_id], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Accounts — AMM Pool
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init, payer = authority, space = POOL_STATE_SIZE,
        seeds = [b"pool", authority.key().as_ref(), token_mint.key().as_ref()], bump
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        init_if_needed, payer = authority,
        associated_token::mint = token_mint,
        associated_token::authority = pool_state,
    )]
    pub pool_token_account: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"pool", pool_state.authority.as_ref(), pool_state.token_mint.as_ref()], bump = pool_state.bump)]
    pub pool_state: Account<'info, PoolState>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub authority_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub pool_token_account: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SwapSolForToken<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"pool", pool_state.authority.as_ref(), pool_state.token_mint.as_ref()], bump = pool_state.bump)]
    pub pool_state: Account<'info, PoolState>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub pool_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SwapTokenForSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"pool", pool_state.authority.as_ref(), pool_state.token_mint.as_ref()], bump = pool_state.bump)]
    pub pool_state: Account<'info, PoolState>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub pool_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct VaultState {
    pub owner: Pubkey,
    pub agent_id: [u8; 32],
    pub deposit_count: u64,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
    pub bump: u8,
}

#[account]
pub struct PoolState {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub pool_token_account: Pubkey,
    pub sol_reserve: u64,
    pub token_reserve: u64,
    pub fee_bps: u16,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct VaultDeposit {
    pub vault: Pubkey,
    pub amount: u64,
    pub reason_tag: u8,
    pub timestamp: i64,
}

#[event]
pub struct VaultWithdraw {
    pub vault: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct SwapEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub direction: u8,
    pub new_sol_reserve: u64,
    pub new_token_reserve: u64,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum VaultError {
    #[msg("Deposit amount is below the minimum of 100,000 lamports (0.0001 SOL)")]
    AmountTooSmall,
    #[msg("Insufficient vault balance to complete this withdrawal")]
    InsufficientFunds,
    #[msg("Only the vault owner may perform this operation")]
    Unauthorized,
}

#[error_code]
pub enum PoolError {
    #[msg("Pool has insufficient liquidity to complete this swap")]
    PoolEmpty,
    #[msg("Output amount is below the minimum specified (slippage exceeded)")]
    SlippageExceeded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow in pool calculation")]
    MathOverflow,
    #[msg("Fee basis points must be <= 1000 (10%)")]
    InvalidFee,
}
