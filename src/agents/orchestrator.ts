// SentinelVault — AgentOrchestrator
// Central coordination layer that manages the full lifecycle of all autonomous
// agents: creation, funding, health monitoring, metrics aggregation, and
// graceful shutdown.

import EventEmitter from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentType,
  AgentState,
  AgentConfig,
  AgentStatus,
  CreateAgentParams,
  OrchestratorConfig,
  SystemMetrics,
  DashboardState,
  AlertEntry,
  StrategyConfig,
  SecurityPolicy,
} from '../types';
import { BaseAgent } from './base-agent';
import { TradingAgent } from './trading-agent';
import { LiquidityAgent } from './liquidity-agent';
import { AgenticWallet } from '../core/wallet';
import { PolicyEngine } from '../security/policy-engine';
import { AuditLogger } from '../security/audit-logger';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxAgents: 10,
  healthCheckIntervalMs: 30_000,
  metricsIntervalMs: 10_000,
  autoRestart: true,
  dashboardPort: 3000,
  websocketPort: 3001,
};

/** Milliseconds to wait between sequential airdrops to avoid rate-limiting. */
const INTER_AIRDROP_DELAY_MS = 2_000;

// ─── Event Map ────────────────────────────────────────────────────────────────

interface OrchestratorEvents {
  'agent:created': [agentId: string, name: string, type: AgentType];
  'agent:started': [agentId: string];
  'agent:stopped': [agentId: string];
  'agent:removed': [agentId: string];
  'alert': [alert: AlertEntry];
  'metrics:updated': [metrics: SystemMetrics];
}

// ─── Agent Registry Entry ─────────────────────────────────────────────────────

interface AgentRegistryEntry {
  agent: BaseAgent;
  wallet: AgenticWallet;
  policyEngine: PolicyEngine;
}

// ─── AgentOrchestrator ────────────────────────────────────────────────────────

/**
 * Central coordinator for all SentinelVault agents.
 *
 * Responsibilities:
 *  - Agent factory: instantiate the right concrete agent for each AgentType
 *  - Lifecycle management: start / stop / pause / resume / remove
 *  - Health monitoring: periodic status checks with optional auto-restart
 *  - Metrics aggregation: system-wide performance snapshots on a timer
 *  - Funding: sequential SOL airdrops across all agent wallets
 *  - Audit integration: wire agent events into the shared AuditLogger
 *  - Dashboard state: single method to gather all UI-relevant data
 */
export class AgentOrchestrator extends EventEmitter<OrchestratorEvents> {
  // ── Configuration ──────────────────────────────────────────────────────────

  private readonly config: OrchestratorConfig;

  // ── Agent Registry ─────────────────────────────────────────────────────────

  private readonly agents: Map<string, AgentRegistryEntry> = new Map();

  // ── Cross-cutting Infrastructure ───────────────────────────────────────────

  private readonly auditLogger: AuditLogger;

  // ── Alert Log ──────────────────────────────────────────────────────────────

  private readonly alerts: AlertEntry[] = [];

  // ── Recent Transaction Signatures (newest last) ───────────────────────────

  private readonly recentTxSignatures: { agentId: string; signature: string; timestamp: number }[] = [];

  // ── Uptime ─────────────────────────────────────────────────────────────────

  private readonly startTime: number;

  // ── Background Intervals ───────────────────────────────────────────────────

  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private metricsInterval: ReturnType<typeof setInterval> | null = null;

  // ─────────────────────────────────────────────────────────────────────────────

  constructor(config: Partial<OrchestratorConfig> = {}) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };
    this.auditLogger = new AuditLogger();
    this.startTime = Date.now();

    this.auditLogger.logSystemEvent('orchestrator:initialized', {
      config: this.config,
    });
  }

  // ── Agent Factory ─────────────────────────────────────────────────────────

  /**
   * Create a new agent of the requested type, initialize its encrypted wallet,
   * wire security and audit infrastructure, and register it in the agent map.
   *
   * Returns the new agent's UUID.
   *
   * @throws When the orchestrator has already reached maxAgents capacity.
   */
  async createAgent(params: CreateAgentParams): Promise<string> {
    if (this.agents.size >= this.config.maxAgents) {
      throw new Error(
        `Cannot create agent "${params.name}": orchestrator capacity of ` +
        `${this.config.maxAgents} agents has been reached.`,
      );
    }

    const agentId = uuidv4();

    // ── Wallet ────────────────────────────────────────────────────────────────

    const walletConfig = {
      id: uuidv4(),
      label: params.name,
      password: params.password,
      cluster: params.cluster ?? 'devnet',
      ...(params.rpcEndpoint ? { rpcEndpoint: params.rpcEndpoint } : {}),
    };

    const wallet = new AgenticWallet(walletConfig);
    await wallet.initialize();

    // ── Policy Engine ─────────────────────────────────────────────────────────

    const defaultPolicy = PolicyEngine.createDefaultPolicy();
    const mergedPolicy: SecurityPolicy = {
      ...defaultPolicy,
      ...params.securityPolicy,
      spendingLimits: {
        ...defaultPolicy.spendingLimits,
        ...(params.securityPolicy?.spendingLimits ?? {}),
      },
      alertThresholds:
        params.securityPolicy?.alertThresholds ?? defaultPolicy.alertThresholds,
    };

    const policyEngine = new PolicyEngine(agentId, mergedPolicy);

    // ── Agent Config ──────────────────────────────────────────────────────────

    const agentConfig: AgentConfig = {
      id: agentId,
      name: params.name,
      type: params.type,
      walletConfig,
      strategy: params.strategy,
      securityPolicy: mergedPolicy,
      enabled: true,
    };

    // ── Agent Instantiation ───────────────────────────────────────────────────

    const agent = this.instantiateAgent(agentConfig, wallet);

    // ── Policy Engine Wiring ──────────────────────────────────────────────────
    // Enforce policy at both the wallet level (direct API calls) and the agent
    // level (OODA loop decisions) for defense in depth.

    wallet.setPolicyEngine(policyEngine);
    agent.setPolicyEngine(policyEngine);

    // ── Event Wiring ──────────────────────────────────────────────────────────

    this.wireAgentEvents(agent, wallet);

    // ── Registration ──────────────────────────────────────────────────────────

    this.agents.set(agentId, { agent, wallet, policyEngine });

    this.auditLogger.logSystemEvent('agent:created', {
      agentId,
      name: params.name,
      type: params.type,
      cluster: walletConfig.cluster,
    });

    this.emit('agent:created', agentId, params.name, params.type);

    return agentId;
  }

  // ── Lifecycle Management ──────────────────────────────────────────────────

  /**
   * Start the OODA loop for a single agent.
   * @throws When no agent with the given ID exists.
   */
  startAgent(agentId: string): void {
    const entry = this.requireAgent(agentId);
    entry.agent.start();

    this.auditLogger.logSystemEvent('agent:started', { agentId });
    this.emit('agent:started', agentId);
  }

  /**
   * Permanently stop a single agent's OODA loop.
   * @throws When no agent with the given ID exists.
   */
  stopAgent(agentId: string): void {
    const entry = this.requireAgent(agentId);
    entry.agent.stop();

    this.auditLogger.logSystemEvent('agent:stopped', { agentId });
    this.emit('agent:stopped', agentId);
  }

  /**
   * Temporarily suspend a single agent's OODA loop without removing it.
   * @throws When no agent with the given ID exists.
   */
  pauseAgent(agentId: string): void {
    const entry = this.requireAgent(agentId);
    entry.agent.pause();

    this.auditLogger.logSystemEvent('agent:paused', { agentId });
  }

  /**
   * Resume a previously paused agent.
   * @throws When no agent with the given ID exists.
   */
  resumeAgent(agentId: string): void {
    const entry = this.requireAgent(agentId);
    entry.agent.resume();

    this.auditLogger.logSystemEvent('agent:resumed', { agentId });
  }

  /**
   * Stop and deregister an agent. The agent's wallet and policy engine are
   * discarded along with the registry entry.
   *
   * @throws When no agent with the given ID exists.
   */
  removeAgent(agentId: string): void {
    const entry = this.requireAgent(agentId);

    // Ensure the OODA loop is halted before we discard the entry.
    const currentStatus: AgentStatus = entry.agent.getStatus();
    if (currentStatus !== 'stopped') {
      entry.agent.stop();
    }

    this.agents.delete(agentId);

    this.auditLogger.logSystemEvent('agent:removed', { agentId });
    this.emit('agent:removed', agentId);
  }

  // ── Batch Lifecycle ───────────────────────────────────────────────────────

  /** Start all registered agents. */
  startAll(): void {
    for (const agentId of this.agents.keys()) {
      this.startAgent(agentId);
    }
  }

  /** Stop all registered agents. */
  stopAll(): void {
    for (const agentId of this.agents.keys()) {
      this.stopAgent(agentId);
    }
  }

  // ── Funding ───────────────────────────────────────────────────────────────

  /**
   * Request a SOL airdrop for every registered agent wallet, sequentially, with
   * a short pause between each to avoid devnet rate-limiting.
   *
   * @param amountSol - Amount of SOL to request per agent (default: 1).
   */
  async fundAllAgents(amountSol: number = 1): Promise<void> {
    const entries = Array.from(this.agents.entries());

    for (let i = 0; i < entries.length; i++) {
      const [agentId, { wallet }] = entries[i];

      try {
        const signature = await wallet.requestAirdrop(amountSol);

        this.auditLogger.logWalletOperation(
          agentId,
          wallet.getState()?.id ?? agentId,
          'airdrop:requested',
          { amountSol, signature },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        this.auditLogger.logSecurityEvent(
          agentId,
          wallet.getState()?.id ?? agentId,
          'airdrop:failed',
          { amountSol, error: message },
          'warning',
        );

        this.addAlert('warning', `Airdrop failed for agent ${agentId}: ${message}`, agentId);
      }

      // Throttle requests except after the last one.
      if (i < entries.length - 1) {
        await sleep(INTER_AIRDROP_DELAY_MS);
      }
    }
  }

  // ── Health Monitoring ─────────────────────────────────────────────────────

  /**
   * Start the health-check and metrics timers.
   *
   * Health check: inspects each agent's status and, when autoRestart is
   * enabled, attempts to resume any agent in 'error' state.
   *
   * Metrics: emits an updated SystemMetrics snapshot on the metricsIntervalMs
   * cadence so subscribers (e.g. dashboard) stay current without polling.
   */
  startHealthMonitoring(): void {
    if (this.healthCheckInterval !== null) {
      return; // Already running — idempotent.
    }

    this.healthCheckInterval = setInterval(() => {
      this.runHealthChecks();
    }, this.config.healthCheckIntervalMs);

    this.metricsInterval = setInterval(() => {
      const metrics = this.getSystemMetrics();
      this.emit('metrics:updated', metrics);
    }, this.config.metricsIntervalMs);

    this.auditLogger.logSystemEvent('health_monitoring:started', {
      healthCheckIntervalMs: this.config.healthCheckIntervalMs,
      metricsIntervalMs: this.config.metricsIntervalMs,
    });
  }

  /** Stop health-check and metrics timers. */
  stopHealthMonitoring(): void {
    if (this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.metricsInterval !== null) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    this.auditLogger.logSystemEvent('health_monitoring:stopped', {});
  }

  // ── Alert Management ──────────────────────────────────────────────────────

  /**
   * Create, record, and emit a new alert entry.
   *
   * @param severity - 'info' | 'warning' | 'critical'
   * @param message  - Human-readable description of the alert condition.
   * @param agentId  - Optional: the agent that triggered the alert.
   */
  addAlert(
    severity: AlertEntry['severity'],
    message: string,
    agentId?: string,
  ): void {
    const alert: AlertEntry = {
      id: uuidv4(),
      timestamp: Date.now(),
      severity,
      message,
      agentId,
      acknowledged: false,
    };

    this.alerts.push(alert);
    this.emit('alert', alert);

    this.auditLogger.logSystemEvent('alert:created', {
      alertId: alert.id,
      severity,
      message,
      agentId,
    });
  }

  // ── State & Metrics ───────────────────────────────────────────────────────

  /**
   * Assemble the full dashboard state snapshot in a single call.
   * Intended for WebSocket broadcast or HTTP polling by the dashboard frontend.
   */
  getDashboardState(): DashboardState {
    return {
      agents: this.getAgentStates(),
      systemMetrics: this.getSystemMetrics(),
      recentTransactions: this.recentTxSignatures.slice(-20).reverse().map((tx) => ({
        id: tx.signature,
        request: { id: tx.signature, agentId: tx.agentId, walletId: tx.agentId, type: 'transfer_sol' as const, priority: 'medium' as const, maxRetries: 0, simulateFirst: false, metadata: {}, createdAt: tx.timestamp },
        result: { id: tx.signature, signature: tx.signature, status: 'confirmed' as const, slot: 0, blockTime: null, fee: 0, error: null, logs: [], duration: 0 },
        attempts: 1,
        createdAt: tx.timestamp,
        completedAt: tx.timestamp,
        status: 'completed' as const,
      })),
      recentAuditEntries: this.auditLogger.getRecentEntries(20),
      alerts: [...this.alerts],
    };
  }

  /**
   * Compute system-wide performance metrics by aggregating across all agents.
   */
  getSystemMetrics(): SystemMetrics {
    const allEntries = Array.from(this.agents.values());

    const totalAgents = allEntries.length;

    const activeAgents = allEntries.filter(
      ({ agent }) => agent.getStatus() !== 'stopped',
    ).length;

    const totalWallets = totalAgents;

    let totalTransactions = 0;
    let totalVolumeSol = 0;

    for (const { agent } of allEntries) {
      const perf = agent.getPerformance();
      totalTransactions += perf.totalTransactions;
      totalVolumeSol += perf.totalVolumeSol;
    }

    const uptimeSeconds = (Date.now() - this.startTime) / 1_000;

    const averageTps = uptimeSeconds > 0 ? totalTransactions / uptimeSeconds : 0;

    const memoryUsageMb = process.memoryUsage().heapUsed / 1_024 / 1_024;

    return {
      totalAgents,
      activeAgents,
      totalWallets,
      totalTransactions,
      totalVolumeSol,
      uptimeSeconds,
      averageTps,
      memoryUsageMb,
    };
  }

  /** Return the current state snapshot for every registered agent. */
  getAgentStates(): AgentState[] {
    return Array.from(this.agents.values()).map(({ agent }) => agent.getState());
  }

  /**
   * Look up a registered agent by ID.
   * Returns undefined when no agent with the given ID is registered.
   */
  getAgent(agentId: string): BaseAgent | undefined {
    return this.agents.get(agentId)?.agent;
  }

  /** Return the number of currently registered agents. */
  getAgentCount(): number {
    return this.agents.size;
  }

  /** Return the shared AuditLogger instance. */
  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }

  /** Return a copy of the accumulated alert log. */
  getAlerts(): AlertEntry[] {
    return [...this.alerts];
  }

  /** Return the wallet for a specific agent. */
  getAgentWallet(agentId: string): AgenticWallet {
    const entry = this.requireAgent(agentId);
    return entry.wallet;
  }

  /** Return a map of agentId → public key for all registered agents. */
  getAgentWalletAddresses(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [agentId, { wallet }] of this.agents.entries()) {
      const state = wallet.getState();
      if (state) {
        result.set(agentId, state.publicKey);
      }
    }
    return result;
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  /**
   * Gracefully shut down the orchestrator:
   *  1. Stop all agent OODA loops.
   *  2. Stop background health and metrics timers.
   *  3. Flush and close the audit log write stream.
   */
  async shutdown(): Promise<void> {
    this.auditLogger.logSystemEvent('orchestrator:shutdown:initiated', {
      agentCount: this.agents.size,
    });

    this.stopAll();
    this.stopHealthMonitoring();
    this.auditLogger.close();
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Instantiate the correct concrete agent class based on the requested type.
   * 'arbitrageur' and 'portfolio_manager' fall back to TradingAgent until
   * dedicated implementations are available.
   */
  private instantiateAgent(config: AgentConfig, wallet: AgenticWallet): BaseAgent {
    switch (config.type) {
      case 'trader':
        return new TradingAgent(config, wallet);

      case 'liquidity_provider':
        return new LiquidityAgent(config, wallet);

      case 'arbitrageur':
        console.warn(
          `[Orchestrator] AgentType "arbitrageur" is not yet implemented; ` +
          `falling back to TradingAgent for agent "${config.name}" (${config.id}).`,
        );
        return new TradingAgent(config, wallet);

      case 'portfolio_manager':
        console.warn(
          `[Orchestrator] AgentType "portfolio_manager" is not yet implemented; ` +
          `falling back to TradingAgent for agent "${config.name}" (${config.id}).`,
        );
        return new TradingAgent(config, wallet);

      default: {
        // Exhaustiveness guard — TypeScript should catch unreachable cases.
        const exhaustive: never = config.type;
        throw new Error(`Unrecognized AgentType: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * Subscribe to every event a BaseAgent can emit and forward relevant ones
   * to the AuditLogger and the alert system. This keeps the individual agent
   * classes free of orchestration concerns.
   */
  private wireAgentEvents(agent: BaseAgent, wallet: AgenticWallet): void {
    const agentId = agent.getId();
    const walletId = wallet.getState()?.id ?? agentId;

    agent.on('agent:decision', (decision) => {
      this.auditLogger.logAgentDecision(
        agentId,
        walletId,
        decision.action,
        {
          decisionId: decision.id,
          confidence: decision.confidence,
          reasoning: decision.reasoning,
          executed: decision.executed,
          marketConditions: decision.marketConditions,
        },
      );
    });

    agent.on('agent:action', (action) => {
      this.auditLogger.logTransaction(
        agentId,
        walletId,
        action.type,
        {
          actionId: action.id,
          details: action.details,
        },
        action.result?.signature,
      );
    });

    agent.on('agent:error', (error) => {
      const message = error.message;

      this.auditLogger.logSecurityEvent(
        agentId,
        walletId,
        'agent:error',
        { error: message },
        'warning',
      );

      this.addAlert('warning', `Agent ${agentId} encountered an error: ${message}`, agentId);
    });

    wallet.on('wallet:funded', (signature, amountSol) => {
      this.auditLogger.logWalletOperation(
        agentId,
        walletId,
        'wallet:funded',
        { signature, amountSol },
      );
    });

    wallet.on('transaction:confirmed', (signature) => {
      this.recentTxSignatures.push({ agentId, signature, timestamp: Date.now() });
      // Keep only the most recent 50 entries
      if (this.recentTxSignatures.length > 50) {
        this.recentTxSignatures.shift();
      }
    });

    wallet.on('transaction:failed', (error) => {
      this.auditLogger.logSecurityEvent(
        agentId,
        walletId,
        'transaction:failed',
        { error: error.message },
        'warning',
      );
    });
  }

  /**
   * Inspect every registered agent and react to anomalies:
   *  - Agents in 'error' state are resumed when autoRestart is enabled.
   *  - A 'critical' alert is raised for any agent that cannot be recovered.
   */
  private runHealthChecks(): void {
    for (const [agentId, { agent }] of this.agents.entries()) {
      const status: AgentStatus = agent.getStatus();

      if (status === 'error') {
        if (this.config.autoRestart) {
          try {
            agent.resume();

            this.auditLogger.logSystemEvent('health_check:agent_recovered', {
              agentId,
              previousStatus: status,
            });

            this.addAlert(
              'info',
              `Agent ${agentId} (${agent.getName()}) was automatically recovered from error state.`,
              agentId,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            this.auditLogger.logSystemEvent('health_check:recovery_failed', {
              agentId,
              error: message,
            });

            this.addAlert(
              'critical',
              `Agent ${agentId} (${agent.getName()}) could not be recovered: ${message}`,
              agentId,
            );
          }
        } else {
          this.addAlert(
            'warning',
            `Agent ${agentId} (${agent.getName()}) is in error state. ` +
            `Auto-restart is disabled.`,
            agentId,
          );
        }
      }
    }
  }

  /**
   * Retrieve a registry entry by agent ID.
   * @throws When no entry exists for the given ID.
   */
  private requireAgent(agentId: string): AgentRegistryEntry {
    const entry = this.agents.get(agentId);
    if (!entry) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return entry;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
