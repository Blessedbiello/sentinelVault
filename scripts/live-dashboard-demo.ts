// Live dashboard demo — fund agents via CLI transfer, do SPL + Memo ops, start OODA loops

import { AgentOrchestrator } from '../src/agents/orchestrator';
import { TradingAgent } from '../src/agents/trading-agent';
import { DashboardServer } from '../src/dashboard/server';
import { execSync } from 'child_process';
import chalk from 'chalk';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function solanaTransfer(to: string, amount: number): string | null {
  try {
    const out = execSync(
      `solana transfer ${to} ${amount} --allow-unfunded-recipient --commitment confirmed 2>&1`,
      { encoding: 'utf-8', timeout: 30_000 },
    );
    const match = out.match(/Signature: (\S+)/);
    return match ? match[1] : out.trim().slice(0, 40);
  } catch (e: any) {
    console.log(chalk.yellow(`  ! Transfer failed: ${e.message.slice(0, 80)}`));
    return null;
  }
}

(async function main() {
  // Validate Solana CLI is available
  try {
    execSync('solana --version', { encoding: 'utf-8', timeout: 5000 });
  } catch {
    console.log(chalk.red('  ✗ Solana CLI not found. Install: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"'));
    process.exit(1);
  }

  const orchestrator = new AgentOrchestrator();

  // Create two agents
  console.log(chalk.cyan('\n  Creating agents...'));

  const alphaId = await orchestrator.createAgent({
    name: 'Alpha-Momentum',
    type: 'trader',
    password: 'live-alpha-001',
    strategy: {
      name: 'Momentum', type: 'momentum', params: {},
      riskLevel: 'moderate', maxPositionSize: 0.01, cooldownMs: 12_000,
    },
  });

  const betaId = await orchestrator.createAgent({
    name: 'Beta-MeanRev',
    type: 'trader',
    password: 'live-beta-002',
    strategy: {
      name: 'MeanReversion', type: 'mean_reversion', params: {},
      riskLevel: 'moderate', maxPositionSize: 0.01, cooldownMs: 15_000,
    },
  });

  const alphaWallet = orchestrator.getAgentWallet(alphaId);
  const betaWallet = orchestrator.getAgentWallet(betaId);
  const alphaPub = alphaWallet.getPublicKey();
  const betaPub = betaWallet.getPublicKey();

  console.log(chalk.green(`  ✓ Alpha: ${alphaPub}`));
  console.log(chalk.green(`  ✓ Beta:  ${betaPub}`));

  // Fund via solana CLI transfer
  console.log(chalk.cyan('\n  Funding via Solana CLI transfer...'));
  const sig1 = solanaTransfer(alphaPub, 0.5);
  if (sig1) console.log(chalk.green(`  ✓ Alpha funded: ${sig1.slice(0, 24)}...`));

  await sleep(2000);

  const sig2 = solanaTransfer(betaPub, 0.5);
  if (sig2) console.log(chalk.green(`  ✓ Beta funded:  ${sig2.slice(0, 24)}...`));

  await sleep(2000);

  // Check balances
  let alphaBalance = 0, betaBalance = 0;
  try { alphaBalance = await alphaWallet.getBalance(); } catch (e: any) {
    console.log(chalk.yellow(`  ! Alpha balance fetch failed: ${(e.message ?? String(e)).slice(0, 60)}`));
  }
  try { betaBalance = await betaWallet.getBalance(); } catch (e: any) {
    console.log(chalk.yellow(`  ! Beta balance fetch failed: ${(e.message ?? String(e)).slice(0, 60)}`));
  }
  console.log(chalk.white(`  Alpha: ${alphaBalance.toFixed(4)} SOL | Beta: ${betaBalance.toFixed(4)} SOL`));

  // SPL Token operations
  if (alphaBalance >= 0.1) {
    console.log(chalk.cyan('\n  SPL Token operations...'));
    try {
      const mint = await alphaWallet.createTokenMint(9);
      if (mint) {
        console.log(chalk.green(`  ✓ Mint created: ${mint.slice(0, 24)}...`));

        const mintSig = await alphaWallet.mintTokens(mint, 1_000_000 * 10 ** 9);
        if (mintSig) {
          console.log(chalk.green(`  ✓ 1M tokens minted: ${mintSig.slice(0, 24)}...`));

          const xferSig = await alphaWallet.transferToken(mint, betaPub, 500_000 * 10 ** 9);
          if (xferSig) {
            console.log(chalk.green(`  ✓ 500K tokens → Beta: ${xferSig.slice(0, 24)}...`));
          }
        }
      }

      const alphaTokens = await alphaWallet.getTokenBalances();
      const betaTokens = await betaWallet.getTokenBalances();
      console.log(chalk.gray(`  Alpha tokens: ${alphaTokens.map(t => t.uiBalance).join(', ')}`));
      console.log(chalk.gray(`  Beta tokens:  ${betaTokens.map(t => t.uiBalance).join(', ')}`));
    } catch (e: any) {
      console.log(chalk.yellow(`  ! SPL failed: ${e.message}`));
    }
  }

  // Memo program
  console.log(chalk.cyan('\n  Memo program interaction...'));
  try {
    const m1 = await alphaWallet.sendMemo(`[SentinelVault] Alpha initialized — momentum — ${new Date().toISOString()}`);
    console.log(chalk.green(`  ✓ Alpha memo: ${m1.slice(0, 24)}...`));
  } catch (e: any) {
    console.log(chalk.yellow(`  ! Alpha memo failed: ${e.message}`));
  }
  try {
    const m2 = await betaWallet.sendMemo(`[SentinelVault] Beta initialized — mean_reversion — ${new Date().toISOString()}`);
    console.log(chalk.green(`  ✓ Beta memo:  ${m2.slice(0, 24)}...`));
  } catch (e: any) {
    console.log(chalk.yellow(`  ! Beta memo failed: ${e.message}`));
  }

  // Wire agent-to-agent targeting
  const alphaAgent = orchestrator.getAgent(alphaId);
  const betaAgent = orchestrator.getAgent(betaId);
  if (alphaAgent && betaAgent) {
    (alphaAgent as TradingAgent).setTargetAddress(betaPub);
    (betaAgent as TradingAgent).setTargetAddress(alphaPub);
    console.log(chalk.green('\n  ✓ Agents wired: Alpha ↔ Beta'));
  }

  // Start dashboard
  const dashboard = new DashboardServer(orchestrator);
  await dashboard.start();
  console.log(chalk.green('  ✓ Dashboard: http://localhost:3000'));

  // Start OODA loops
  orchestrator.startAll();
  orchestrator.startHealthMonitoring();
  console.log(chalk.green.bold('\n  ✓ OODA loops running — watch the dashboard!\n'));

  console.log(chalk.cyan('  http://localhost:3000'));
  console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

  // Print status every 15s
  const printStatus = async () => {
    try { await alphaWallet.getBalance(); } catch (e: any) {
      console.log(chalk.yellow(`  ! Alpha balance: ${(e.message ?? '').slice(0, 40)}`));
    }
    try { await betaWallet.getBalance(); } catch (e: any) {
      console.log(chalk.yellow(`  ! Beta balance: ${(e.message ?? '').slice(0, 40)}`));
    }
    const metrics = orchestrator.getSystemMetrics();
    const aState = alphaAgent?.getState();
    const bState = betaAgent?.getState();

    console.log(chalk.gray(`  [${new Date().toLocaleTimeString()}] `) +
      chalk.white(`Alpha: ${(aState?.wallet?.balanceSol ?? 0).toFixed(4)} SOL `) +
      chalk.white(`| Beta: ${(bState?.wallet?.balanceSol ?? 0).toFixed(4)} SOL `) +
      chalk.cyan(`| Txns: ${metrics.totalTransactions} `) +
      chalk.cyan(`| Vol: ${metrics.totalVolumeSol.toFixed(4)} SOL`));

    const latest = alphaAgent?.getDecisionHistory().slice(-1)[0];
    const chain = latest?.marketConditions?.reasoningChain as string[] | undefined;
    if (chain) {
      console.log(chalk.gray(`    ${latest?.action} (conf: ${latest?.confidence.toFixed(3)}) — `) +
        chalk.gray(chain[chain.length - 1] || ''));
    }
  };

  const interval = setInterval(() => void printStatus(), 15_000);

  process.on('SIGINT', async () => {
    clearInterval(interval);
    console.log(chalk.yellow('\n  Shutting down...'));
    orchestrator.stopAll();
    orchestrator.stopHealthMonitoring();
    await orchestrator.shutdown();
    await dashboard.stop();
    console.log(chalk.green('  Done.\n'));
    process.exit(0);
  });
})();
