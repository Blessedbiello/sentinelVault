// SentinelVault — Multi-Agent Demo
// Runs a full end-to-end demonstration on Solana devnet: creates four
// autonomous agents, funds them via airdrop, starts the dashboard, runs
// status update cycles for two minutes, then shuts everything down cleanly.

import { AgentOrchestrator } from '../src/agents/orchestrator';
import { DashboardServer } from '../src/dashboard/server';
import chalk from 'chalk';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentDescriptor {
  name: string;
  id: string;
  publicKey: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_INTERVAL_MS = 10_000;
const STATUS_ITERATIONS = 12;
const AIRDROP_DELAY_MS = 3_000;
const AIRDROP_AMOUNT_SOL = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatUptime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

function printBanner(): void {
  const line = '═'.repeat(52);
  console.log('');
  console.log(chalk.cyan.bold(`  ╔${line}╗`));
  console.log(chalk.cyan.bold(`  ║${'  SentinelVault — Multi-Agent Demo'.padEnd(52)}║`));
  console.log(chalk.cyan.bold(`  ╚${line}╝`));
  console.log('');
}

function printSectionHeader(title: string): void {
  console.log('');
  console.log(chalk.yellow.bold(`  ── ${title} ${'─'.repeat(Math.max(0, 44 - title.length))}`));
}

function printAgentTable(
  descriptors: AgentDescriptor[],
  orchestrator: AgentOrchestrator,
  iteration: number,
): void {
  const agentStates = orchestrator.getAgentStates();
  const stateMap = new Map(agentStates.map(s => [s.id, s]));

  printSectionHeader(`Status Update — iteration ${iteration}/${STATUS_ITERATIONS}`);

  const col = {
    name:      14,
    status:    12,
    balance:   12,
    decisions: 10,
    txns:      8,
  };

  const header =
    chalk.bold('  ' +
      'AGENT'.padEnd(col.name) +
      'STATUS'.padEnd(col.status) +
      'BALANCE'.padEnd(col.balance) +
      'DECISIONS'.padEnd(col.decisions) +
      'TXNS'.padEnd(col.txns));

  console.log(header);
  console.log('  ' + '─'.repeat(col.name + col.status + col.balance + col.decisions + col.txns));

  for (const desc of descriptors) {
    const state = stateMap.get(desc.id);

    const statusRaw = state?.status ?? 'unknown';
    const statusColor =
      statusRaw === 'idle'      ? chalk.green(statusRaw.padEnd(col.status)) :
      statusRaw === 'analyzing' ? chalk.cyan(statusRaw.padEnd(col.status))  :
      statusRaw === 'executing' ? chalk.magenta(statusRaw.padEnd(col.status)):
      statusRaw === 'paused'    ? chalk.yellow(statusRaw.padEnd(col.status)) :
      statusRaw === 'error'     ? chalk.red(statusRaw.padEnd(col.status))   :
      statusRaw === 'stopped'   ? chalk.gray(statusRaw.padEnd(col.status))  :
                                  statusRaw.padEnd(col.status);

    const balanceRaw  = state?.wallet?.balanceSol ?? 0;
    const balanceStr  = `${balanceRaw.toFixed(4)} SOL`.padEnd(col.balance);

    const decisionCount = state ? orchestrator.getAgent(desc.id)?.getDecisionHistory().length ?? 0 : 0;
    const decisionsStr  = String(decisionCount).padEnd(col.decisions);

    const txns    = state?.performance?.totalTransactions ?? 0;
    const txnsStr = String(txns).padEnd(col.txns);

    console.log(
      '  ' +
      chalk.white(desc.name.padEnd(col.name)) +
      statusColor +
      chalk.cyan(balanceStr) +
      chalk.white(decisionsStr) +
      chalk.white(txnsStr),
    );
  }
}

function printSystemMetrics(orchestrator: AgentOrchestrator): void {
  const metrics = orchestrator.getSystemMetrics();

  console.log('');
  console.log(chalk.gray('  System Metrics:'));
  console.log(
    chalk.gray('  ') +
    chalk.white(`Agents: ${chalk.green(metrics.activeAgents)}/${chalk.white(metrics.totalAgents)}`) +
    chalk.gray('  |  ') +
    chalk.white(`Uptime: ${chalk.cyan(formatUptime(metrics.uptimeSeconds))}`) +
    chalk.gray('  |  ') +
    chalk.white(`Total Txns: ${chalk.cyan(metrics.totalTransactions)}`) +
    chalk.gray('  |  ') +
    chalk.white(`Vol: ${chalk.cyan(metrics.totalVolumeSol.toFixed(4))} SOL`) +
    chalk.gray('  |  ') +
    chalk.white(`Mem: ${chalk.cyan(metrics.memoryUsageMb.toFixed(1))} MB`),
  );
}

// ─── Main Demo ────────────────────────────────────────────────────────────────

(async function main(): Promise<void> {
  // ── Banner ──────────────────────────────────────────────────────────────────

  printBanner();
  console.log(chalk.white('  Starting on Solana devnet...'));
  console.log('');

  // ── Orchestrator ────────────────────────────────────────────────────────────

  const orchestrator = new AgentOrchestrator();
  let dashboard: DashboardServer | null = null;

  // ── SIGINT handler ──────────────────────────────────────────────────────────

  process.on('SIGINT', () => {
    console.log('');
    console.log(chalk.yellow('  Shutting down gracefully...'));

    void (async () => {
      try {
        await orchestrator.shutdown();
        if (dashboard !== null) {
          await dashboard.stop();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`  Shutdown error: ${msg}`));
      } finally {
        process.exit(0);
      }
    })();
  });

  try {
    // ── Agent Definitions ────────────────────────────────────────────────────

    const agentParams = [
      {
        name: 'DCA-Alpha',
        type: 'trader' as const,
        strategy: {
          name: 'DCA',
          type: 'dca' as const,
          params: {},
          riskLevel: 'conservative' as const,
          maxPositionSize: 0.01,
          cooldownMs: 15_000,
        },
        password: 'demo-dca-001',
      },
      {
        name: 'Momentum-Beta',
        type: 'trader' as const,
        strategy: {
          name: 'Momentum',
          type: 'momentum' as const,
          params: {},
          riskLevel: 'moderate' as const,
          maxPositionSize: 0.01,
          cooldownMs: 20_000,
        },
        password: 'demo-mom-002',
      },
      {
        name: 'MeanRev-Gamma',
        type: 'trader' as const,
        strategy: {
          name: 'MeanReversion',
          type: 'mean_reversion' as const,
          params: {},
          riskLevel: 'moderate' as const,
          maxPositionSize: 0.01,
          cooldownMs: 20_000,
        },
        password: 'demo-mr-003',
      },
      {
        name: 'Liquidity-Delta',
        type: 'liquidity_provider' as const,
        strategy: {
          name: 'LiquidityProvision',
          type: 'liquidity_provision' as const,
          params: {},
          riskLevel: 'conservative' as const,
          maxPositionSize: 0.05,
          cooldownMs: 30_000,
        },
        password: 'demo-lp-004',
      },
    ];

    // ── Create Agents ────────────────────────────────────────────────────────

    printSectionHeader('Creating Agents');

    const descriptors: AgentDescriptor[] = [];

    for (const params of agentParams) {
      console.log(chalk.gray(`  Creating ${params.name}...`));
      const agentId = await orchestrator.createAgent(params);

      const state = orchestrator.getAgent(agentId)?.getState();
      const publicKey = state?.wallet?.publicKey ?? '(unavailable)';

      descriptors.push({ name: params.name, id: agentId, publicKey });

      console.log(
        chalk.green(`  ✓ ${params.name.padEnd(18)}`) +
        chalk.gray('id: ') + chalk.cyan(agentId.slice(0, 8) + '...') +
        chalk.gray('  pubkey: ') + chalk.cyan(publicKey.slice(0, 12) + '...'),
      );
    }

    // ── Fund Agents ──────────────────────────────────────────────────────────

    printSectionHeader('Funding Agents via Airdrop');
    console.log(chalk.gray(`  Requesting ${AIRDROP_AMOUNT_SOL} SOL per agent (rate limits may apply)...`));
    console.log('');

    // Track which agents receive airdrop failures via the orchestrator's alert
    // events so we can surface them in per-agent log lines.
    const airdropFailures = new Set<string>();
    orchestrator.once('alert', (alert) => {
      if (alert.agentId && alert.message.toLowerCase().includes('airdrop')) {
        airdropFailures.add(alert.agentId);
      }
    });

    // fundAllAgents handles the sequential airdrop with its own inter-agent
    // delay (INTER_AIRDROP_DELAY_MS = 2s). We layer our 3s delay on top by
    // doing one agent at a time using a subset call pattern — but since the
    // orchestrator API only exposes a batch method, we call it once and then
    // print per-agent summaries after the fact, adding our extra delay between
    // the print lines for output pacing.
    //
    // We print a "requesting" line before the batch call, then after it
    // completes we summarize per-agent outcomes and add the inter-line delay.
    for (let i = 0; i < descriptors.length; i++) {
      const desc = descriptors[i];
      console.log(chalk.gray(`  Requesting airdrop for ${desc.name}...`));

      if (i < descriptors.length - 1) {
        await sleep(AIRDROP_DELAY_MS);
      }
    }

    // Execute all airdrops in sequence (orchestrator adds its own 2s gaps).
    try {
      await orchestrator.fundAllAgents(AIRDROP_AMOUNT_SOL);

      for (const desc of descriptors) {
        const failed = airdropFailures.has(desc.id);
        if (failed) {
          console.log(chalk.yellow(`  ! ${desc.name.padEnd(18)} airdrop may have failed (devnet rate limit)`));
        } else {
          console.log(
            chalk.green(`  ✓ ${desc.name.padEnd(18)}`) +
            chalk.gray(`${AIRDROP_AMOUNT_SOL} SOL airdrop requested`),
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  ! Airdrop batch error: ${msg}`));
      console.log(chalk.gray('    Continuing demo — agents may have zero balance.'));
    }

    // ── Dashboard ────────────────────────────────────────────────────────────

    printSectionHeader('Starting Dashboard');

    dashboard = new DashboardServer(orchestrator);
    await dashboard.start();

    console.log(chalk.green('  ✓ Dashboard:  ') + chalk.cyan.underline('http://localhost:3000/api/dashboard'));
    console.log(chalk.green('  ✓ WebSocket:  ') + chalk.cyan.underline('ws://localhost:3001'));

    // ── Start Agents ─────────────────────────────────────────────────────────

    printSectionHeader('Starting All Agents');

    orchestrator.startAll();
    orchestrator.startHealthMonitoring();

    console.log(chalk.green.bold('  All agents running!'));

    // ── Status Loop ──────────────────────────────────────────────────────────

    printSectionHeader(`Monitoring (${STATUS_ITERATIONS} updates × ${STATUS_INTERVAL_MS / 1000}s)`);
    console.log(chalk.gray('  Press Ctrl+C to stop early.'));

    for (let iteration = 1; iteration <= STATUS_ITERATIONS; iteration++) {
      await sleep(STATUS_INTERVAL_MS);

      printAgentTable(descriptors, orchestrator, iteration);

      // Refresh balances where possible.
      for (const desc of descriptors) {
        const agent = orchestrator.getAgent(desc.id);
        if (agent) {
          try {
            await (agent as any).wallet?.getBalance?.();
          } catch {
            // Balance refresh is best-effort; devnet RPC calls may fail.
          }
        }
      }

      printSystemMetrics(orchestrator);
    }

    // ── Graceful Shutdown ────────────────────────────────────────────────────

    printSectionHeader('Shutting Down');

    console.log(chalk.gray('  Stopping all agents...'));
    await orchestrator.shutdown();

    console.log(chalk.gray('  Stopping dashboard...'));
    await dashboard.stop();
    dashboard = null;

    // ── Final Metrics ────────────────────────────────────────────────────────

    printSectionHeader('Final Metrics');

    const finalMetrics = orchestrator.getSystemMetrics();

    console.log(chalk.white('  Uptime:            ') + chalk.cyan(formatUptime(finalMetrics.uptimeSeconds)));
    console.log(chalk.white('  Total agents:      ') + chalk.cyan(finalMetrics.totalAgents));
    console.log(chalk.white('  Total transactions:') + chalk.cyan(` ${finalMetrics.totalTransactions}`));
    console.log(chalk.white('  Total volume:      ') + chalk.cyan(`${finalMetrics.totalVolumeSol.toFixed(4)} SOL`));
    console.log(chalk.white('  Peak memory:       ') + chalk.cyan(`${finalMetrics.memoryUsageMb.toFixed(1)} MB`));

    const alerts = orchestrator.getAlerts();
    if (alerts.length > 0) {
      console.log('');
      console.log(chalk.yellow(`  Alerts raised during demo: ${alerts.length}`));
      for (const alert of alerts.slice(-5)) {
        const severity =
          alert.severity === 'critical' ? chalk.red(alert.severity)     :
          alert.severity === 'warning'  ? chalk.yellow(alert.severity)  :
                                          chalk.gray(alert.severity);
        console.log(`    [${severity}] ${alert.message.slice(0, 80)}`);
      }
    }

    console.log('');
    console.log(chalk.green.bold('  Demo complete!'));
    console.log('');

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('');
    console.error(chalk.red.bold('  Demo failed: ') + chalk.red(msg));
    if (err instanceof Error && err.stack) {
      console.error(chalk.gray(err.stack.split('\n').slice(1).map(l => '  ' + l).join('\n')));
    }

    try {
      await orchestrator.shutdown();
      if (dashboard !== null) {
        await dashboard.stop();
      }
    } catch {
      // Best-effort cleanup on error path.
    }

    process.exit(1);
  }
})();
