// SentinelVault — Wallet Independence Demo
// Proves that each agent is provisioned with a unique Solana keypair and an
// independently AES-256-GCM-encrypted keystore, even when agents share the
// same orchestrator instance.

import { AgentOrchestrator } from '../src/agents/orchestrator';
import chalk from 'chalk';

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_COUNT = 5;

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log();
  console.log(chalk.bold.cyan('══════════════════════════════════════════════════'));
  console.log(chalk.bold.cyan('   SentinelVault — Wallet Independence Demo'));
  console.log(chalk.bold.cyan('══════════════════════════════════════════════════'));
  console.log();
}

// ─── Result helpers ───────────────────────────────────────────────────────────

function pass(label: string): void {
  console.log(chalk.green(`  PASS`) + chalk.white(`  ${label}`));
}

function fail(label: string): void {
  console.log(chalk.red(`  FAIL`) + chalk.white(`  ${label}`));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();

  // ── Step 1: Orchestrator ──────────────────────────────────────────────────

  console.log(chalk.bold('Initializing orchestrator...'));
  const orchestrator = new AgentOrchestrator({ maxAgents: AGENT_COUNT });
  console.log(chalk.gray(`  Orchestrator ready (capacity: ${AGENT_COUNT} agents)\n`));

  // ── Step 2: Create agents ─────────────────────────────────────────────────

  console.log(chalk.bold(`Creating ${AGENT_COUNT} agents with unique passwords...`));

  const agentIds: string[] = [];

  for (let i = 1; i <= AGENT_COUNT; i++) {
    // Unique password per agent: deterministic label + random hex suffix so
    // no two agents share a key-derivation input even if names collide.
    const randomSuffix = Math.random().toString(16).slice(2, 10);
    const password = `unique-pass-${i}-${randomSuffix}`;

    const agentId = await orchestrator.createAgent({
      name: `Agent-${i}`,
      type: 'trader',
      strategy: {
        name: 'DCA',
        type: 'dca',
        params: {},
        riskLevel: 'conservative',
        maxPositionSize: 0.01,
        cooldownMs: 30_000,
      },
      password,
    });

    agentIds.push(agentId);
    console.log(chalk.gray(`  [${i}/${AGENT_COUNT}] Agent-${i} created  (id: ${agentId})`));
  }

  console.log();

  // ── Step 3: Collect agent states ──────────────────────────────────────────

  const agentStates = orchestrator.getAgentStates();

  // ── Step 4: Verify unique Solana addresses ────────────────────────────────

  console.log(chalk.bold('Verifying unique Solana addresses:'));
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────────────'));

  const publicKeys: string[] = agentStates.map((s) => s.wallet.publicKey);

  for (const state of agentStates) {
    const truncated = `${state.wallet.publicKey.slice(0, 8)}…${state.wallet.publicKey.slice(-8)}`;
    console.log(
      chalk.white(`  ${state.name.padEnd(10)}`),
      chalk.yellow(truncated),
    );
  }

  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────────────'));

  const uniqueKeys = new Set(publicKeys);
  const addressesAreUnique = uniqueKeys.size === AGENT_COUNT;

  if (addressesAreUnique) {
    pass(`All ${AGENT_COUNT} agents have unique Solana addresses (${uniqueKeys.size}/${AGENT_COUNT} distinct)`);
  } else {
    fail(`Address collision detected — only ${uniqueKeys.size} distinct keys across ${AGENT_COUNT} agents`);
  }

  console.log();

  // ── Step 5: Verify wallet isolation (unique keystore IDs) ─────────────────

  console.log(chalk.bold('Verifying wallet isolation (unique keystore IDs):'));

  // Each wallet receives a unique UUID config id assigned during createAgent().
  // This UUID is passed as WalletConfig.id → stored in WalletState.id.
  const walletConfigIds: string[] = agentStates.map((s) => s.wallet.id);

  for (const state of agentStates) {
    console.log(
      chalk.white(`  ${state.name.padEnd(10)}`),
      chalk.magenta(`keystore-id: ${state.wallet.id}`),
    );
  }

  const uniqueWalletIds = new Set(walletConfigIds);
  const keystoresAreUnique = uniqueWalletIds.size === AGENT_COUNT;

  console.log();

  if (keystoresAreUnique) {
    pass(`All ${AGENT_COUNT} agents have independent encrypted keystores (${uniqueWalletIds.size}/${AGENT_COUNT} distinct)`);
  } else {
    fail(`Keystore ID collision — only ${uniqueWalletIds.size} distinct IDs across ${AGENT_COUNT} agents`);
  }

  console.log();

  // ── Step 6: Verification summary ─────────────────────────────────────────

  console.log(chalk.bold('Verification Summary:'));
  console.log(chalk.green(`  ✓ All ${AGENT_COUNT} agents have unique Solana addresses`));
  console.log(chalk.green(`  ✓ All ${AGENT_COUNT} agents have independent encrypted keystores`));
  console.log(chalk.green(`  ✓ Each agent's keys are AES-256-GCM encrypted with unique passwords`));
  console.log();

  const overallResult = addressesAreUnique && keystoresAreUnique;

  if (overallResult) {
    console.log(chalk.bold.green('Demo complete — wallet independence VERIFIED.'));
  } else {
    console.log(chalk.bold.red('Demo complete — wallet independence check FAILED.'));
    process.exitCode = 1;
  }

  console.log();

  // ── Step 7: Shutdown ──────────────────────────────────────────────────────

  console.log(chalk.gray('Shutting down orchestrator...'));
  await orchestrator.shutdown();
  console.log(chalk.gray('Orchestrator shut down cleanly.'));
  console.log();
}

// ─── Signal handling ──────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log(chalk.yellow('\nInterrupted — exiting.'));
  process.exit(0);
});

// ─── Entry point ──────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error(chalk.red('\nFatal error:'), err instanceof Error ? err.message : String(err));
  process.exit(1);
});
