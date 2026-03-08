// SentinelVault — Single DCA Trading Agent Demo
// Spins up one DCA TradingAgent on devnet, runs it for 2 minutes, prints a
// final performance report, then shuts everything down cleanly.

import { AgentOrchestrator } from '../src/agents/orchestrator';
import chalk from 'chalk';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatWinRate(rate: number): string {
  const pct = (rate * 100).toFixed(1);
  if (rate >= 0.6) return chalk.green(`${pct}%`);
  if (rate >= 0.4) return chalk.yellow(`${pct}%`);
  return chalk.red(`${pct}%`);
}

function printBanner(): void {
  console.log('');
  console.log(chalk.cyan('╔══════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║') + chalk.bold.white('   SentinelVault — Trading Agent Demo            ') + chalk.cyan('║'));
  console.log(chalk.cyan('╚══════════════════════════════════════════════════╝'));
  console.log('');
}

function printSectionHeader(title: string): void {
  console.log('');
  console.log(chalk.bold.blue(`── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Banner ──────────────────────────────────────────────────────────────────

  printBanner();
  console.log(chalk.white('  Single DCA agent running for 2 minutes on devnet'));
  console.log('');

  // ── Orchestrator ────────────────────────────────────────────────────────────

  const orchestrator = new AgentOrchestrator();

  // ── SIGINT handler — registered before any async work ────────────────────────

  let shuttingDown = false;

  async function gracefulShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('');
    console.log(chalk.yellow(`[${timestamp()}] Received ${reason} — shutting down gracefully...`));

    try {
      await orchestrator.shutdown();
      console.log(chalk.green('Orchestrator shut down cleanly.'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Shutdown error: ${message}`));
    }

    process.exit(0);
  }

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));

  // ── Create DCA agent ────────────────────────────────────────────────────────

  printSectionHeader('Creating Agent');

  let agentId: string;

  try {
    agentId = await orchestrator.createAgent({
      name: 'DCA-Trader',
      type: 'trader',
      strategy: {
        name: 'DCA',
        type: 'dca',
        params: {},
        riskLevel: 'conservative',
        maxPositionSize: 0.01,
        cooldownMs: 10_000,
      },
      password: 'dca-demo-secure-pass',
    });

    console.log(chalk.green(`  Agent created: ${chalk.bold('DCA-Trader')} (id: ${agentId})`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`  Failed to create agent: ${message}`));
    await orchestrator.shutdown();
    process.exit(1);
  }

  // ── Fund via airdrop ────────────────────────────────────────────────────────

  printSectionHeader('Funding Agent');
  console.log(chalk.white('  Requesting 1 SOL airdrop on devnet...'));

  try {
    await orchestrator.fundAllAgents(1);
    console.log(chalk.green('  Airdrop successful — 1 SOL funded.'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(chalk.yellow(`  Airdrop failed (continuing anyway): ${message}`));
  }

  // ── Start agent ─────────────────────────────────────────────────────────────

  printSectionHeader('Starting Agent');
  orchestrator.startAgent(agentId);
  console.log(chalk.green('  Agent running... collecting decisions'));

  // ── Wire event listeners ────────────────────────────────────────────────────

  const agent = orchestrator.getAgent(agentId);

  if (agent) {
    agent.on('agent:decision', (decision) => {
      const ts = new Date(decision.timestamp).toISOString();
      const actionColor =
        decision.action === 'buy'
          ? chalk.green(decision.action.toUpperCase())
          : decision.action === 'sell'
          ? chalk.red(decision.action.toUpperCase())
          : chalk.gray(decision.action.toUpperCase());

      console.log('');
      console.log(
        chalk.dim(`[${ts}]`) +
        chalk.bold(' Decision: ') +
        actionColor +
        chalk.dim(` | confidence: ${(decision.confidence * 100).toFixed(0)}%`),
      );
      console.log(chalk.dim(`  ${decision.reasoning}`));
    });

    agent.on('agent:action', (action) => {
      const ts = new Date(action.timestamp).toISOString();
      const amountSol = typeof action.details.amountSol === 'number'
        ? action.details.amountSol.toFixed(6)
        : '?';
      const sig = action.result?.signature ?? 'N/A';
      const shortSig = sig.length > 20 ? `${sig.slice(0, 10)}...${sig.slice(-6)}` : sig;

      console.log(
        chalk.dim(`[${ts}]`) +
        chalk.bold(' Action executed: ') +
        chalk.cyan(action.type) +
        chalk.dim(` | amount: ${amountSol} SOL | sig: ${shortSig}`),
      );
    });
  } else {
    console.warn(chalk.yellow('  Warning: could not retrieve agent reference for event wiring.'));
  }

  // ── Run for 120 seconds with 30-second interim status prints ─────────────────

  const TOTAL_DURATION_MS = 120_000;
  const STATUS_INTERVAL_MS = 30_000;
  const statusCheckCount = TOTAL_DURATION_MS / STATUS_INTERVAL_MS;

  for (let i = 1; i <= statusCheckCount; i++) {
    await sleep(STATUS_INTERVAL_MS);

    if (shuttingDown) break;

    const elapsed = i * STATUS_INTERVAL_MS / 1_000;
    const agentStates = orchestrator.getAgentStates();
    const agentState = agentStates[0];

    if (!agentState) continue;

    const { performance, wallet } = agentState;
    const balance = wallet?.balanceSol ?? 0;

    printSectionHeader(`Interim Status — ${elapsed}s elapsed`);
    console.log(
      chalk.white(`  Balance:            `) + chalk.cyan(`${balance.toFixed(6)} SOL`),
    );
    console.log(
      chalk.white(`  Total transactions: `) + chalk.cyan(`${performance.totalTransactions}`),
    );
    console.log(
      chalk.white(`  Win rate:           `) + formatWinRate(performance.winRate),
    );
  }

  // ── Stop agent ──────────────────────────────────────────────────────────────

  printSectionHeader('Stopping Agent');

  if (!shuttingDown) {
    orchestrator.stopAgent(agentId);
    console.log(chalk.yellow('  Agent stopped.'));
  }

  // ── Final report ────────────────────────────────────────────────────────────

  printSectionHeader('Final Report');

  // Decision history (from agent reference obtained earlier, or from state)
  const decisionHistory = agent?.getDecisionHistory() ?? [];

  if (decisionHistory.length > 0) {
    console.log(chalk.bold.white(`\n  Decision History (${decisionHistory.length} total):`));

    // Show the last 5 decisions to keep output manageable
    const preview = decisionHistory.slice(-5);
    const skipped = decisionHistory.length - preview.length;

    if (skipped > 0) {
      console.log(chalk.dim(`  ... ${skipped} earlier decisions omitted ...`));
    }

    for (const d of preview) {
      const ts = new Date(d.timestamp).toISOString();
      const actionLabel =
        d.action === 'buy'
          ? chalk.green(d.action)
          : d.action === 'sell'
          ? chalk.red(d.action)
          : chalk.gray(d.action);

      console.log(
        `  ${chalk.dim(ts)}  ${actionLabel.padEnd(4)}` +
        `  confidence: ${(d.confidence * 100).toFixed(0).padStart(3)}%` +
        `  executed: ${d.executed ? chalk.green('yes') : chalk.gray('no')}`,
      );
    }
  } else {
    console.log(chalk.dim('  No decisions recorded in this run.'));
  }

  // Performance metrics
  const finalStates = orchestrator.getAgentStates();
  const finalState = finalStates[0];
  const metrics = finalState?.performance;

  console.log(chalk.bold.white('\n  Performance Metrics:'));

  if (metrics) {
    console.log(
      chalk.white('  totalTransactions:       ') + chalk.cyan(metrics.totalTransactions),
    );
    console.log(
      chalk.white('  successfulTransactions:  ') + chalk.green(metrics.successfulTransactions),
    );
    console.log(
      chalk.white('  failedTransactions:      ') + chalk.red(metrics.failedTransactions),
    );
    console.log(
      chalk.white('  winRate:                 ') + formatWinRate(metrics.winRate),
    );
    console.log(
      chalk.white('  totalVolumeSol:          ') + chalk.cyan(`${metrics.totalVolumeSol.toFixed(6)} SOL`),
    );
  } else {
    console.log(chalk.dim('  No performance data available.'));
  }

  // Summary
  console.log('');
  console.log(chalk.bold.white('  Summary:'));

  const decisionsTotal = decisionHistory.length;
  const decisionsExecuted = decisionHistory.filter(d => d.executed).length;
  const buyDecisions = decisionHistory.filter(d => d.action === 'buy').length;
  const sellDecisions = decisionHistory.filter(d => d.action === 'sell').length;
  const holdDecisions = decisionHistory.filter(d => d.action === 'hold').length;

  console.log(chalk.white(`  Ran DCA-Trader for 2 minutes on devnet.`));
  console.log(chalk.white(`  Total decisions made:  ${chalk.cyan(decisionsTotal)}`));
  console.log(chalk.white(`  Decisions executed:    ${chalk.cyan(decisionsExecuted)}`));
  console.log(
    chalk.white(`  Decision breakdown:    `) +
    chalk.green(`${buyDecisions} buy`) + chalk.dim(' / ') +
    chalk.red(`${sellDecisions} sell`) + chalk.dim(' / ') +
    chalk.gray(`${holdDecisions} hold`),
  );

  // ── Shutdown orchestrator ───────────────────────────────────────────────────

  if (!shuttingDown) {
    shuttingDown = true;
    printSectionHeader('Shutdown');

    try {
      await orchestrator.shutdown();
      console.log(chalk.green('  Orchestrator shut down cleanly.'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`  Shutdown error: ${message}`));
    }
  }

  console.log('');
  console.log(chalk.cyan('  Demo complete.'));
  console.log('');
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`[fatal] ${message}`));
  process.exit(1);
});
