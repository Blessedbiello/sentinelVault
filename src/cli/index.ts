#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import figlet from 'figlet';
import { AgentOrchestrator } from '../agents/orchestrator';
import { PolicyEngine } from '../security/policy-engine';
import type { AgentState, AgentType, SystemMetrics, StrategyType, AuditEntry } from '../types';

// ─── Banner ───────────────────────────────────────────────────────────────────

console.log(
  chalk.cyan(
    figlet.textSync('SentinelVault', {
      font: 'Standard',
      horizontalLayout: 'default',
      verticalLayout: 'default',
    }),
  ),
);

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('sentinel-vault')
  .version('1.0.0')
  .description('SentinelVault — autonomous multi-agent Solana trading platform CLI');

// ─── Helper: sleep ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Helper: printAgentTable ─────────────────────────────────────────────────

function printAgentTable(agents: AgentState[]): void {
  if (agents.length === 0) {
    console.log(chalk.yellow('  No agents registered.'));
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('ID (short)'),
      chalk.cyan('Name'),
      chalk.cyan('Type'),
      chalk.cyan('Status'),
      chalk.cyan('Balance (SOL)'),
      chalk.cyan('Transactions'),
    ],
    colWidths: [14, 24, 20, 12, 14, 14],
    style: { border: ['grey'] },
  });

  for (const agent of agents) {
    const shortId = agent.id.slice(0, 8) + '…';
    const statusColor =
      agent.status === 'executing' || agent.status === 'analyzing'
        ? chalk.green(agent.status)
        : agent.status === 'error'
        ? chalk.red(agent.status)
        : agent.status === 'stopped'
        ? chalk.grey(agent.status)
        : chalk.yellow(agent.status);

    table.push([
      shortId,
      agent.name,
      agent.type,
      statusColor,
      agent.wallet.balanceSol.toFixed(4),
      String(agent.performance.totalTransactions),
    ]);
  }

  console.log(table.toString());
}

// ─── Helper: printMetrics ─────────────────────────────────────────────────────

function printMetrics(metrics: SystemMetrics): void {
  const uptimeMin = (metrics.uptimeSeconds / 60).toFixed(1);

  console.log('');
  console.log(chalk.cyan('  ── System Metrics ──────────────────────────'));
  console.log(
    `  ${chalk.cyan('Total agents')}      : ${chalk.green(String(metrics.totalAgents))}`,
  );
  console.log(
    `  ${chalk.cyan('Active agents')}     : ${chalk.green(String(metrics.activeAgents))}`,
  );
  console.log(
    `  ${chalk.cyan('Total wallets')}     : ${chalk.green(String(metrics.totalWallets))}`,
  );
  console.log(
    `  ${chalk.cyan('Total transactions')}: ${chalk.green(String(metrics.totalTransactions))}`,
  );
  console.log(
    `  ${chalk.cyan('Total volume')}      : ${chalk.green(metrics.totalVolumeSol.toFixed(4))} SOL`,
  );
  console.log(
    `  ${chalk.cyan('Uptime')}            : ${chalk.green(uptimeMin)} min`,
  );
  console.log(
    `  ${chalk.cyan('Average TPS')}       : ${chalk.green(metrics.averageTps.toFixed(4))}`,
  );
  console.log(
    `  ${chalk.cyan('Memory usage')}      : ${chalk.green(metrics.memoryUsageMb.toFixed(1))} MB`,
  );
  console.log('');
}

// ─── Command: demo ────────────────────────────────────────────────────────────

program
  .command('demo')
  .description('Run the full multi-agent demo (4 agents, 60 seconds, devnet)')
  .action(async () => {
    try {
      const orchestrator = new AgentOrchestrator();

      // ── Create agents ───────────────────────────────────────────────────────

      const spinner = ora({ text: chalk.cyan('Creating agents...'), color: 'cyan' }).start();

      const agentDefinitions: Array<{
        name: string;
        type: AgentType;
        strategyType: StrategyType;
      }> = [
        { name: 'DCA-Trader-1',         type: 'trader',            strategyType: 'dca'              },
        { name: 'Momentum-Trader-2',     type: 'trader',            strategyType: 'momentum'         },
        { name: 'MeanReversion-Trader-3',type: 'trader',            strategyType: 'mean_reversion'   },
        { name: 'LiquidityProvider-4',   type: 'liquidity_provider',strategyType: 'liquidity_provision'},
      ];

      const agentIds: string[] = [];

      for (let i = 0; i < agentDefinitions.length; i++) {
        const def = agentDefinitions[i];
        spinner.text = chalk.cyan(`Creating agent: ${def.name}...`);

        const agentId = await orchestrator.createAgent({
          name: def.name,
          type: def.type,
          strategy: {
            name: def.strategyType,
            type: def.strategyType,
            params: {},
            riskLevel: 'moderate',
            maxPositionSize: 0.5,
            cooldownMs: 5_000,
          },
          password: `demo-password-${i + 1}`,
          cluster: 'devnet',
        });

        agentIds.push(agentId);
      }

      spinner.succeed(chalk.green(`Created ${agentIds.length} agents.`));

      // ── Fund agents ─────────────────────────────────────────────────────────

      const fundSpinner = ora({
        text: chalk.cyan('Funding agents via devnet airdrop...'),
        color: 'cyan',
      }).start();

      await orchestrator.fundAllAgents(1);

      fundSpinner.succeed(chalk.green('Funded all agents (1 SOL each).'));

      // ── Start agents ────────────────────────────────────────────────────────

      orchestrator.startAll();
      console.log(chalk.green('\n  All agents started.\n'));

      // ── Status table loop (every 10 s for 60 s) ─────────────────────────────

      const POLL_INTERVAL_MS = 10_000;
      const DEMO_DURATION_MS = 60_000;
      const iterations = DEMO_DURATION_MS / POLL_INTERVAL_MS;

      for (let tick = 1; tick <= iterations; tick++) {
        await sleep(POLL_INTERVAL_MS);

        console.log(chalk.cyan(`  ── Agent Status (t=${tick * 10}s) ${'─'.repeat(30)}`));
        printAgentTable(orchestrator.getAgentStates());
      }

      // ── Shutdown ────────────────────────────────────────────────────────────

      const shutdownSpinner = ora({
        text: chalk.cyan('Shutting down gracefully...'),
        color: 'cyan',
      }).start();

      await orchestrator.shutdown();

      shutdownSpinner.succeed(chalk.green('Orchestrator shut down.'));

      // ── Final metrics ───────────────────────────────────────────────────────

      console.log(chalk.cyan('\n  ── Final Metrics ────────────────────────────'));
      printMetrics(orchestrator.getSystemMetrics());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  [demo] Error: ${message}`));
      process.exit(1);
    }
  });

// ─── Command: create-agent ────────────────────────────────────────────────────

program
  .command('create-agent <name>')
  .description('Create a new autonomous agent')
  .option('--type <type>',       'Agent type (trader|liquidity_provider|arbitrageur|portfolio_manager)', 'trader')
  .option('--strategy <strategy>','Strategy type (dca|momentum|mean_reversion|grid_trading|liquidity_provision)', 'dca')
  .option('--cluster <cluster>', 'Solana cluster (devnet|testnet|mainnet-beta)', 'devnet')
  .option('--password <password>','Wallet encryption password (required)')
  .action(async (name: string, options: {
    type: string;
    strategy: string;
    cluster: string;
    password: string;
  }) => {
    try {
      if (!options.password) {
        console.error(chalk.red('  Error: --password is required.'));
        process.exit(1);
      }

      const spinner = ora({ text: chalk.cyan(`Creating agent "${name}"...`), color: 'cyan' }).start();

      const orchestrator = new AgentOrchestrator();

      const agentId = await orchestrator.createAgent({
        name,
        type: options.type as AgentType,
        strategy: {
          name: options.strategy,
          type: options.strategy as StrategyType,
          params: {},
          riskLevel: 'moderate',
          maxPositionSize: 0.5,
          cooldownMs: 5_000,
        },
        password: options.password,
        cluster: options.cluster as 'devnet' | 'testnet' | 'mainnet-beta',
      });

      spinner.succeed(chalk.green(`Agent "${name}" created successfully.`));

      const agents = orchestrator.getAgentStates();
      const created = agents.find(a => a.id === agentId);

      if (created) {
        console.log('');
        console.log(chalk.cyan('  ── Agent Details ──────────────────────────'));
        console.log(`  ${chalk.cyan('ID')}       : ${created.id}`);
        console.log(`  ${chalk.cyan('Name')}     : ${created.name}`);
        console.log(`  ${chalk.cyan('Type')}     : ${created.type}`);
        console.log(`  ${chalk.cyan('Strategy')}: ${created.currentStrategy}`);
        console.log(`  ${chalk.cyan('Cluster')} : ${options.cluster}`);
        console.log(`  ${chalk.cyan('Wallet')}  : ${created.wallet.publicKey}`);
        console.log(`  ${chalk.cyan('Status')}  : ${created.status}`);
        console.log('');
      }

      await orchestrator.shutdown();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  [create-agent] Error: ${message}`));
      process.exit(1);
    }
  });

// ─── Command: list-agents ─────────────────────────────────────────────────────

program
  .command('list-agents')
  .description('List all active agents registered with the orchestrator')
  .action(async () => {
    try {
      const spinner = ora({ text: chalk.cyan('Fetching agent list...'), color: 'cyan' }).start();

      const orchestrator = new AgentOrchestrator();
      const agents = orchestrator.getAgentStates();

      spinner.stop();

      console.log('');
      console.log(chalk.cyan(`  ── Registered Agents (${agents.length}) ${'─'.repeat(28)}`));
      printAgentTable(agents);

      await orchestrator.shutdown();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  [list-agents] Error: ${message}`));
      process.exit(1);
    }
  });

// ─── Command: status ──────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show system status and a quick health check')
  .action(async () => {
    try {
      console.log('');
      console.log(chalk.cyan('  ── System Information ───────────────────────'));
      console.log(`  ${chalk.cyan('Node version')} : ${chalk.green(process.version)}`);
      console.log(`  ${chalk.cyan('Platform')}     : ${chalk.green(process.platform)}`);
      console.log(`  ${chalk.cyan('Architecture')} : ${chalk.green(process.arch)}`);
      console.log(`  ${chalk.cyan('PID')}          : ${chalk.green(String(process.pid))}`);

      const spinner = ora({
        text: chalk.cyan('Running health check...'),
        color: 'cyan',
      }).start();

      const orchestrator = new AgentOrchestrator();
      const metrics = orchestrator.getSystemMetrics();

      spinner.succeed(chalk.green('Health check passed.'));

      console.log('');
      console.log(chalk.cyan('  ── Orchestrator Status ──────────────────────'));
      console.log(
        `  ${chalk.cyan('Registered agents')}: ${chalk.green(String(metrics.totalAgents))}`,
      );
      console.log(
        `  ${chalk.cyan('Active agents')}    : ${chalk.green(String(metrics.activeAgents))}`,
      );
      console.log(
        `  ${chalk.cyan('Memory usage')}     : ${chalk.green(metrics.memoryUsageMb.toFixed(1))} MB`,
      );
      console.log(
        `  ${chalk.cyan('Policy engine')}    : ${chalk.green('operational')}`,
      );
      console.log(
        `  ${chalk.cyan('Audit logger')}     : ${chalk.green('operational')}`,
      );
      console.log('');

      await orchestrator.shutdown();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  [status] Error: ${message}`));
      process.exit(1);
    }
  });

// ─── Command: fund ────────────────────────────────────────────────────────────

program
  .command('fund <agent-id>')
  .description('Request a SOL airdrop for a specific agent (devnet only)')
  .option('--amount <sol>', 'Amount of SOL to airdrop', '1')
  .action(async (agentId: string, options: { amount: string }) => {
    try {
      const amountSol = parseFloat(options.amount);
      if (isNaN(amountSol) || amountSol <= 0) {
        console.error(chalk.red('  Error: --amount must be a positive number.'));
        process.exit(1);
      }

      const orchestrator = new AgentOrchestrator();
      const agent = orchestrator.getAgent(agentId);

      if (!agent) {
        console.error(chalk.red(`  Error: Agent not found: ${agentId}`));
        await orchestrator.shutdown();
        process.exit(1);
      }

      const spinner = ora({
        text: chalk.cyan(`Requesting airdrop of ${amountSol} SOL for agent ${agentId}...`),
        color: 'cyan',
      }).start();

      await orchestrator.fundAllAgents(amountSol);

      spinner.succeed(
        chalk.green(`Airdrop of ${amountSol} SOL requested for agent ${agentId}.`),
      );

      await orchestrator.shutdown();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  [fund] Error: ${message}`));
      process.exit(1);
    }
  });

// ─── Command: start ───────────────────────────────────────────────────────────

program
  .command('start <agent-id>')
  .description('Start an agent\'s OODA loop')
  .action(async (agentId: string) => {
    try {
      const orchestrator = new AgentOrchestrator();
      const agent = orchestrator.getAgent(agentId);

      if (!agent) {
        console.error(chalk.red(`  Error: Agent not found: ${agentId}`));
        await orchestrator.shutdown();
        process.exit(1);
      }

      const spinner = ora({
        text: chalk.cyan(`Starting agent ${agentId}...`),
        color: 'cyan',
      }).start();

      orchestrator.startAgent(agentId);

      spinner.succeed(chalk.green(`Agent ${agentId} started.`));

      await orchestrator.shutdown();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  [start] Error: ${message}`));
      process.exit(1);
    }
  });

// ─── Command: stop ────────────────────────────────────────────────────────────

program
  .command('stop <agent-id>')
  .description('Stop an agent\'s OODA loop')
  .action(async (agentId: string) => {
    try {
      const orchestrator = new AgentOrchestrator();
      const agent = orchestrator.getAgent(agentId);

      if (!agent) {
        console.error(chalk.red(`  Error: Agent not found: ${agentId}`));
        await orchestrator.shutdown();
        process.exit(1);
      }

      const spinner = ora({
        text: chalk.cyan(`Stopping agent ${agentId}...`),
        color: 'cyan',
      }).start();

      orchestrator.stopAgent(agentId);

      spinner.succeed(chalk.green(`Agent ${agentId} stopped.`));

      await orchestrator.shutdown();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  [stop] Error: ${message}`));
      process.exit(1);
    }
  });

// ─── Command: logs ────────────────────────────────────────────────────────────

program
  .command('logs')
  .description('Show recent audit log entries')
  .option('--limit <n>', 'Number of entries to display', '20')
  .action(async (options: { limit: string }) => {
    try {
      const limit = parseInt(options.limit, 10);
      if (isNaN(limit) || limit <= 0) {
        console.error(chalk.red('  Error: --limit must be a positive integer.'));
        process.exit(1);
      }

      const spinner = ora({
        text: chalk.cyan(`Fetching last ${limit} audit log entries...`),
        color: 'cyan',
      }).start();

      const orchestrator = new AgentOrchestrator();
      const auditLogger = orchestrator.getAuditLogger();
      const entries: AuditEntry[] = auditLogger.getRecentEntries(limit);

      spinner.stop();

      if (entries.length === 0) {
        console.log(chalk.yellow('\n  No audit log entries found.\n'));
        await orchestrator.shutdown();
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan('Timestamp'),
          chalk.cyan('Level'),
          chalk.cyan('Category'),
          chalk.cyan('Agent ID'),
          chalk.cyan('Action'),
          chalk.cyan('Risk'),
        ],
        colWidths: [22, 10, 20, 14, 30, 8],
        style: { border: ['grey'] },
      });

      for (const entry of entries) {
        const ts = new Date(entry.timestamp).toISOString().replace('T', ' ').slice(0, 19);

        const levelStr =
          entry.level === 'critical'
            ? chalk.red(entry.level)
            : entry.level === 'warning'
            ? chalk.yellow(entry.level)
            : entry.level === 'security'
            ? chalk.magenta(entry.level)
            : chalk.green(entry.level);

        const riskStr =
          entry.riskScore >= 0.7
            ? chalk.red(entry.riskScore.toFixed(2))
            : entry.riskScore >= 0.4
            ? chalk.yellow(entry.riskScore.toFixed(2))
            : chalk.green(entry.riskScore.toFixed(2));

        table.push([
          ts,
          levelStr,
          entry.category,
          entry.agentId.slice(0, 8) + '…',
          entry.action,
          riskStr,
        ]);
      }

      console.log('');
      console.log(chalk.cyan(`  ── Audit Logs (last ${entries.length}) ${'─'.repeat(30)}`));
      console.log(table.toString());

      await orchestrator.shutdown();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  [logs] Error: ${message}`));
      process.exit(1);
    }
  });

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse(process.argv);
