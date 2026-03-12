// SentinelVault — Live Dashboard Entry Point
// Persistent 24/7 server for Fly.io deployment.
// Starts the dashboard server IMMEDIATELY, then sets up agents in the background.

import { AgentOrchestrator } from '../src/agents/orchestrator';
import { TradingAgent } from '../src/agents/trading-agent';
import { ArbitrageAgent } from '../src/agents/arbitrage-agent';
import { PortfolioAgent } from '../src/agents/portfolio-agent';
import { LiquidityAgent } from '../src/agents/liquidity-agent';
import { DashboardServer } from '../src/dashboard/server';
import { Connection, Keypair, Transaction, SystemProgram, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const OODA_COOLDOWN_MS = 15_000;
const MIN_BALANCE_SOL = 0.3;
const REFUND_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STATUS_INTERVAL_MS = 60_000; // 1 minute
const AIRDROP_AMOUNT_SOL = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[${new Date().toISOString()}] WARN: ${msg}`);
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

async function airdropWithRetry(
  wallet: { requestAirdrop(amount: number): Promise<string>; getPublicKey(): string },
  amount: number,
  label: string,
  maxAttempts = 2,
): Promise<string | null> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const sig = await wallet.requestAirdrop(amount);
      log(`${label} airdrop success — sig: ${sig.slice(0, 16)}...`);
      return sig;
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 60);
      if (i < maxAttempts - 1) {
        warn(`${label} airdrop attempt ${i + 1} failed: ${msg} — retrying in ${(i + 1) * 3}s...`);
        await sleep((i + 1) * 3000);
      } else {
        warn(`${label} airdrop failed after ${maxAttempts} attempts: ${msg}`);
      }
    }
  }
  return null;
}

/**
 * Transfer SOL from the Solana CLI deployer keypair (~/.config/solana/id.json)
 * to a recipient address. Used as fallback when devnet airdrops are rate-limited.
 */
async function fundFromDeployer(
  connection: Connection,
  recipientPubkey: string,
  amount: number,
  label: string,
): Promise<string | null> {
  try {
    const idPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
    if (!fs.existsSync(idPath)) return null;

    const keyData = JSON.parse(fs.readFileSync(idPath, 'utf-8')) as number[];
    const deployer = Keypair.fromSecretKey(Uint8Array.from(keyData));

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: new PublicKey(recipientPubkey),
        lamports: Math.round(amount * LAMPORTS_PER_SOL),
      }),
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [deployer]);
    deployer.secretKey.fill(0);
    log(`${label} funded from deployer — sig: ${sig.slice(0, 16)}...`);
    return sig;
  } catch (e: unknown) {
    warn(`${label} deployer funding failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('SentinelVault Live Dashboard starting up...');
  log(`PORT=${PORT}  NODE_ENV=${process.env.NODE_ENV ?? 'development'}`);

  const orchestrator = new AgentOrchestrator();
  let dashboard: DashboardServer | null = null;

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    log(`Received ${signal} — shutting down gracefully...`);
    try {
      orchestrator.stopAll();
      orchestrator.stopHealthMonitoring();
      if (dashboard) {
        await dashboard.stop();
      }
      await orchestrator.shutdown();
      log('Shutdown complete.');
    } catch (e: unknown) {
      warn(`Error during shutdown: ${(e instanceof Error ? e.message : String(e))}`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 0: Start dashboard server IMMEDIATELY so Fly.io health check passes
  // ══════════════════════════════════════════════════════════════════════════

  log(`Starting DashboardServer on port ${PORT} (single-port mode)...`);

  dashboard = new DashboardServer(orchestrator, {
    port: PORT,
    singlePort: true,
  });

  await dashboard.start();

  log(`Dashboard live on port ${PORT} — Fly.io health check will pass`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1: Create 5 agents (fast — no network calls)
  // ══════════════════════════════════════════════════════════════════════════

  log('Creating agents...');

  const alphaId = await orchestrator.createAgent({
    name: 'Alpha-Trader',
    type: 'trader',
    strategy: {
      name: 'Momentum',
      type: 'momentum',
      params: {},
      riskLevel: 'moderate',
      maxPositionSize: 0.01,
      cooldownMs: OODA_COOLDOWN_MS,
    },
    password: 'live-alpha-001',
  });

  const betaId = await orchestrator.createAgent({
    name: 'Beta-Trader',
    type: 'trader',
    strategy: {
      name: 'MeanReversion',
      type: 'mean_reversion',
      params: {},
      riskLevel: 'moderate',
      maxPositionSize: 0.01,
      cooldownMs: OODA_COOLDOWN_MS,
    },
    password: 'live-beta-002',
  });

  const arbId = await orchestrator.createAgent({
    name: 'Gamma-Arbitrageur',
    type: 'arbitrageur',
    strategy: {
      name: 'CrossDexArbitrage',
      type: 'momentum',
      params: {},
      riskLevel: 'moderate',
      maxPositionSize: 0.01,
      cooldownMs: OODA_COOLDOWN_MS,
    },
    password: 'live-gamma-003',
  });

  const portfolioId = await orchestrator.createAgent({
    name: 'Delta-Portfolio',
    type: 'portfolio_manager',
    strategy: {
      name: 'BalancedAllocation',
      type: 'momentum',
      params: { targetAllocation: { sol: 0.6, tokens: 0.4 } },
      riskLevel: 'conservative',
      maxPositionSize: 0.01,
      cooldownMs: OODA_COOLDOWN_MS,
    },
    password: 'live-delta-004',
  });

  const lpId = await orchestrator.createAgent({
    name: 'Epsilon-Liquidity',
    type: 'liquidity_provider',
    strategy: {
      name: 'LiquidityProvision',
      type: 'dca',
      params: {},
      riskLevel: 'moderate',
      maxPositionSize: 0.01,
      cooldownMs: OODA_COOLDOWN_MS,
    },
    password: 'live-epsilon-005',
  });

  const alphaWallet = orchestrator.getAgentWallet(alphaId);
  const betaWallet = orchestrator.getAgentWallet(betaId);
  const arbWallet = orchestrator.getAgentWallet(arbId);
  const portfolioWallet = orchestrator.getAgentWallet(portfolioId);
  const lpWallet = orchestrator.getAgentWallet(lpId);

  const alphaPubkey = alphaWallet.getPublicKey();
  const betaPubkey = betaWallet.getPublicKey();
  const arbPubkey = arbWallet.getPublicKey();
  const portfolioPubkey = portfolioWallet.getPublicKey();
  const lpPubkey = lpWallet.getPublicKey();

  log(`Alpha-Trader      ${alphaPubkey}`);
  log(`Beta-Trader       ${betaPubkey}`);
  log(`Gamma-Arbitrageur ${arbPubkey}`);
  log(`Delta-Portfolio   ${portfolioPubkey}`);
  log(`Epsilon-Liquidity ${lpPubkey}`);

  // ── Wire agent targets (no network) ──────────────────────────────────────

  const alphaAgent = orchestrator.getAgent(alphaId);
  const betaAgent = orchestrator.getAgent(betaId);
  const arbAgent = orchestrator.getAgent(arbId);
  const portfolioAgent = orchestrator.getAgent(portfolioId);
  const lpAgent = orchestrator.getAgent(lpId);

  if (alphaAgent && betaAgent) {
    (alphaAgent as TradingAgent).setTargetAddress(betaPubkey);
    (betaAgent as TradingAgent).setTargetAddress(alphaPubkey);
  }
  if (arbAgent) {
    (arbAgent as ArbitrageAgent).setTargetAddress(alphaPubkey);
  }
  if (portfolioAgent) {
    (portfolioAgent as PortfolioAgent).setTargetAddress(betaPubkey);
  }
  if (lpAgent) {
    (lpAgent as LiquidityAgent).setTargetAddress(alphaPubkey);
  }

  log('Agent targets wired');

  // ── Start OODA loops (agents will handle no-balance gracefully) ──────────

  orchestrator.startAll();
  orchestrator.startHealthMonitoring();
  log('All 5 agents running OODA loops');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 2: Fund agents + set up AMM (async — dashboard already serving)
  // ══════════════════════════════════════════════════════════════════════════

  const walletEntries = [
    { wallet: alphaWallet, label: 'Alpha' },
    { wallet: betaWallet, label: 'Beta' },
    { wallet: arbWallet, label: 'Gamma' },
    { wallet: portfolioWallet, label: 'Delta' },
    { wallet: lpWallet, label: 'Epsilon' },
  ];

  const rpcConnection = alphaWallet.getConnection();

  log('Funding agents (dashboard is already serving)...');

  for (const { wallet, label } of walletEntries) {
    let balance = 0;
    try { balance = await wallet.getBalance(); } catch {}

    if (balance >= MIN_BALANCE_SOL) {
      log(`${label} already has ${balance.toFixed(4)} SOL — skipping`);
      continue;
    }

    const sig = await airdropWithRetry(wallet, AIRDROP_AMOUNT_SOL, label, 2);
    if (!sig) {
      log(`Trying deployer fallback for ${label}...`);
      await fundFromDeployer(rpcConnection, wallet.getPublicKey(), AIRDROP_AMOUNT_SOL, label);
    }
    await sleep(2000);
  }

  // ── SPL Token + AMM Pool setup ────────────────────────────────────────────

  let mintAddress: string | null = null;

  let alphaBalance = 0;
  try { alphaBalance = await alphaWallet.getBalance(); } catch {}

  if (alphaBalance >= 0.1) {
    try {
      log('Creating SENTINEL token mint...');
      mintAddress = await alphaWallet.createTokenMint(9);
      log(`Token mint: ${mintAddress}`);

      log('Minting 1,000,000 SENTINEL tokens...');
      await alphaWallet.mintTokens(mintAddress, 1_000_000 * 10 ** 9);

      const recipients = [
        { pubkey: betaPubkey, label: 'Beta', amount: 200_000 * 10 ** 9 },
        { pubkey: arbPubkey, label: 'Gamma', amount: 100_000 * 10 ** 9 },
        { pubkey: portfolioPubkey, label: 'Delta', amount: 100_000 * 10 ** 9 },
        { pubkey: lpPubkey, label: 'Epsilon', amount: 100_000 * 10 ** 9 },
      ];
      for (const r of recipients) {
        try {
          await alphaWallet.transferToken(mintAddress, r.pubkey, r.amount);
          log(`Transferred ${r.amount / 10 ** 9} SENTINEL to ${r.label}`);
        } catch (e: unknown) {
          warn(`Token transfer to ${r.label} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`);
        }
      }
    } catch (e: unknown) {
      warn(`SPL token setup failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
      mintAddress = null;
    }
  } else {
    warn('Insufficient Alpha balance for SPL token setup — skipping');
  }

  // Refresh balance before pool creation
  try { alphaBalance = await alphaWallet.getBalance(); } catch {}

  if (mintAddress && alphaBalance >= 0.6) {
    try {
      log('Creating AMM pool (SOL/SENTINEL, 0.3% fee)...');
      const poolResult = await alphaWallet.createAmmPool(mintAddress, 30);
      log(`Pool PDA: ${poolResult.poolAddress}`);

      log('Adding initial liquidity (0.5 SOL + 200K SENTINEL)...');
      await alphaWallet.addLiquidity(mintAddress, 0.5 * LAMPORTS_PER_SOL, 200_000 * 10 ** 9);
      log('Liquidity added successfully');
    } catch (e: unknown) {
      warn(`AMM pool setup failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
    }
  } else if (mintAddress) {
    warn('Insufficient balance for AMM pool creation — skipping');
  }

  // Wire pool mint to agents
  if (mintAddress) {
    orchestrator.setPoolMintForAgents(mintAddress, alphaPubkey);
    log(`Pool mint wired to all agents: ${mintAddress.slice(0, 16)}...`);
  }

  log('Setup complete. Entering main loop.');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 3: Status + auto-refund loop (runs forever)
  // ══════════════════════════════════════════════════════════════════════════

  let statusTick = 0;
  let lastRefundAt = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(STATUS_INTERVAL_MS);
    statusTick++;

    const metrics = orchestrator.getSystemMetrics();
    log(
      `[Status #${statusTick}] ` +
      `agents=${metrics.activeAgents}/${metrics.totalAgents} ` +
      `txns=${metrics.totalTransactions} ` +
      `vol=${metrics.totalVolumeSol.toFixed(4)} SOL ` +
      `uptime=${formatUptime(metrics.uptimeSeconds)} ` +
      `mem=${metrics.memoryUsageMb.toFixed(1)} MB`
    );

    // Auto-refund: every 30 minutes
    if (Date.now() - lastRefundAt >= REFUND_INTERVAL_MS) {
      lastRefundAt = Date.now();
      log('Running auto-refund check...');

      for (const { wallet, label } of walletEntries) {
        let balance = 0;
        try { balance = await wallet.getBalance(); } catch {}

        if (balance < MIN_BALANCE_SOL) {
          log(`${label} balance low (${balance.toFixed(4)} SOL) — attempting refund...`);
          const sig = await airdropWithRetry(wallet, AIRDROP_AMOUNT_SOL, label, 1);
          if (!sig) {
            await fundFromDeployer(rpcConnection, wallet.getPublicKey(), AIRDROP_AMOUNT_SOL, label);
          }
          await sleep(1500);
        }
      }
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${new Date().toISOString()}] FATAL: ${message}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
