// SentinelVault — DashboardServer
// Express REST API + WebSocket push layer for the SentinelVault dashboard.
// REST endpoints run on port 3000; the WebSocket broadcast server runs on 3001.

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { Server as WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { AgentOrchestrator } from '../agents/orchestrator';
import { AgentType, AuditQueryFilters, StrategyConfig } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardServerConfig {
  port?: number;
  wsPort?: number;
  /** When true, attach the WebSocket server to the same HTTP server as Express.
   *  This allows Fly.io (single exposed port) deployments to work correctly. */
  singlePort?: boolean;
}

interface WsMessage {
  event: string;
  data: unknown;
  timestamp: number;
}

// ─── DashboardServer ──────────────────────────────────────────────────────────

/**
 * Composite server that exposes:
 *  - An Express HTTP API on `port` (default 3000) for synchronous REST calls.
 *  - A WebSocket server on `wsPort` (default 3001) for real-time push updates.
 *
 * The WebSocket layer subscribes to orchestrator events and broadcasts them to
 * every connected client so the dashboard stays current without polling.
 */
export class DashboardServer {
  // ── Configuration ──────────────────────────────────────────────────────────

  private readonly port: number;
  private readonly wsPort: number;
  private readonly singlePort: boolean;

  // ── Core Dependencies ──────────────────────────────────────────────────────

  private readonly orchestrator: AgentOrchestrator;

  // ── HTTP / Express ─────────────────────────────────────────────────────────

  private readonly app: express.Application;
  private httpServer: http.Server | null = null;

  // ── WebSocket ──────────────────────────────────────────────────────────────

  private wsHttpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;

  // ─────────────────────────────────────────────────────────────────────────────

  constructor(
    orchestrator: AgentOrchestrator,
    config: DashboardServerConfig = {},
  ) {
    this.orchestrator = orchestrator;
    this.port = config.port ?? 3000;
    this.wsPort = config.wsPort ?? 3001;
    this.singlePort = config.singlePort ?? false;

    this.app = express();
    this.configureMiddleware();
    this.registerRoutes();
  }

  // ── Private Setup ─────────────────────────────────────────────────────────

  /** Attach global middleware to the Express application. */
  private configureMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));
  }

  /** Register all REST route handlers. */
  private registerRoutes(): void {
    // ── Health ────────────────────────────────────────────────────────────────

    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      });
    });

    // ── Metrics ───────────────────────────────────────────────────────────────

    this.app.get('/api/metrics', (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(this.orchestrator.getSystemMetrics());
      } catch (err) {
        next(err);
      }
    });

    // ── Dashboard State ───────────────────────────────────────────────────────

    this.app.get('/api/dashboard', (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(this.orchestrator.getDashboardState());
      } catch (err) {
        next(err);
      }
    });

    // ── Agent Collection ──────────────────────────────────────────────────────

    this.app.get('/api/agents', (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(this.orchestrator.getAgentStates());
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/agents', async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { name, type, password, strategy, cluster } = req.body as Record<string, unknown>;

        if (typeof name !== 'string' || typeof type !== 'string' || typeof password !== 'string') {
          res.status(400).json({ error: 'Missing required fields: name, type, password' });
          return;
        }

        if (strategy !== undefined && (typeof strategy !== 'object' || strategy === null)) {
          res.status(400).json({ error: 'Invalid strategy: must be an object' });
          return;
        }

        const id = await this.orchestrator.createAgent({
          name,
          type: type as AgentType,
          strategy: strategy as StrategyConfig,
          password,
          cluster: (typeof cluster === 'string' ? cluster : 'devnet') as 'devnet' | 'testnet' | 'mainnet-beta',
        });

        res.status(201).json({ id, message: `Agent "${name}" created successfully.` });
      } catch (err) {
        next(err);
      }
    });

    // ── Agent Decisions ─────────────────────────────────────────────────────

    this.app.get('/api/agents/:id/decisions', (req: Request, res: Response, next: NextFunction) => {
      try {
        const agent = this.orchestrator.getAgent(req.params.id);
        if (!agent) {
          res.status(404).json({ error: `Agent not found: ${req.params.id}` });
          return;
        }
        const decisions = agent.getDecisionHistory().slice(-20);
        res.json({
          agentId: req.params.id,
          adaptiveWeights: agent.getAdaptiveWeights(),
          marketRegime: agent.getMarketRegime(),
          confidenceCalibration: agent.getConfidenceCalibration(),
          decisions,
        });
      } catch (err) {
        next(err);
      }
    });

    // ── Agent Lifecycle ───────────────────────────────────────────────────────

    this.app.post('/api/agents/:id/start', (req: Request, res: Response, next: NextFunction) => {
      try {
        this.orchestrator.startAgent(req.params.id);
        res.json({ message: `Agent ${req.params.id} started.` });
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/agents/:id/stop', (req: Request, res: Response, next: NextFunction) => {
      try {
        this.orchestrator.stopAgent(req.params.id);
        res.json({ message: `Agent ${req.params.id} stopped.` });
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/agents/:id/pause', (req: Request, res: Response, next: NextFunction) => {
      try {
        this.orchestrator.pauseAgent(req.params.id);
        res.json({ message: `Agent ${req.params.id} paused.` });
      } catch (err) {
        next(err);
      }
    });

    this.app.post('/api/agents/:id/resume', (req: Request, res: Response, next: NextFunction) => {
      try {
        this.orchestrator.resumeAgent(req.params.id);
        res.json({ message: `Agent ${req.params.id} resumed.` });
      } catch (err) {
        next(err);
      }
    });

    this.app.delete('/api/agents/:id', (req: Request, res: Response, next: NextFunction) => {
      try {
        this.orchestrator.removeAgent(req.params.id);
        res.json({ message: `Agent ${req.params.id} removed.` });
      } catch (err) {
        next(err);
      }
    });

    // ── Pool State ─────────────────────────────────────────────────────────────

    this.app.get('/api/pool', (_req: Request, res: Response, next: NextFunction) => {
      try {
        // Pool state is not tracked on AgentState directly. Return a best-effort
        // response using the dashboard state or a placeholder indicating no pool.
        const dashState = this.orchestrator.getDashboardState() as unknown as Record<string, unknown>;
        if (dashState.poolState) {
          res.json(dashState.poolState);
        } else {
          res.json({ status: 'no_pool_configured' });
        }
      } catch (err) {
        next(err);
      }
    });

    // ── Transactions ───────────────────────────────────────────────────────────

    this.app.get('/api/transactions', (_req: Request, res: Response, next: NextFunction) => {
      try {
        // Pull recent transactions from the dashboard state which already
        // aggregates recentTxSignatures from the orchestrator.
        const dashState = this.orchestrator.getDashboardState() as unknown as Record<string, unknown>;
        const recentTxs = (dashState.recentTransactions || []) as Record<string, unknown>[];
        const mapped = recentTxs.map((tx) => ({
          signature: (tx.result as Record<string, unknown>)?.signature || tx.id || '',
          agentId: (tx.request as Record<string, unknown>)?.agentId || '',
          agentName: (tx.request as Record<string, unknown>)?.agentId || 'Unknown',
          type: (tx.request as Record<string, unknown>)?.type || 'transfer',
          timestamp: tx.createdAt || 0,
          amount: null,
          status: tx.status,
        }));
        res.json(mapped.slice(0, 50));
      } catch (err) {
        next(err);
      }
    });

    // ── Audit Log ─────────────────────────────────────────────────────────────

    this.app.get('/api/audit', (req: Request, res: Response, next: NextFunction) => {
      try {
        const { agentId, category, limit } = req.query as {
          agentId?: string;
          category?: string;
          limit?: string;
        };

        const filters: Record<string, unknown> = {};

        if (agentId !== undefined) {
          filters.agentId = agentId;
        }

        if (category !== undefined) {
          filters.category = category;
        }

        if (limit !== undefined) {
          const parsed = parseInt(limit, 10);
          if (!isNaN(parsed) && parsed > 0) {
            filters.limit = parsed;
          }
        }

        const entries = this.orchestrator.getAuditLogger().query(filters as AuditQueryFilters);
        res.json(entries);
      } catch (err) {
        next(err);
      }
    });

    // ── Risk Summary ──────────────────────────────────────────────────────────

    this.app.get('/api/risk', (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(this.orchestrator.getAuditLogger().getRiskSummary());
      } catch (err) {
        next(err);
      }
    });

    // ── Alerts ────────────────────────────────────────────────────────────────

    this.app.get('/api/alerts', (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(this.orchestrator.getAlerts());
      } catch (err) {
        next(err);
      }
    });

    // ── Kora Status ──────────────────────────────────────────────────────────

    this.app.get('/api/kora', (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(this.orchestrator.getKoraStatus());
      } catch (err) {
        next(err);
      }
    });

    // ── Global Error Handler ──────────────────────────────────────────────────

    this.app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = err instanceof Error ? err.message : 'Internal server error';
      console.error('[DashboardServer] Unhandled route error:', message);
      res.status(500).json({ error: message });
    });
  }

  // ── WebSocket Helpers ─────────────────────────────────────────────────────

  /**
   * Serialize a message and broadcast it to every currently open WebSocket
   * client. Clients in any other ready state are silently skipped.
   */
  private broadcast(event: string, data: unknown): void {
    if (this.wss === null) return;

    const message: WsMessage = { event, data, timestamp: Date.now() };
    const payload = JSON.stringify(message);

    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /**
   * Subscribe to all relevant orchestrator events and forward each one as a
   * WebSocket broadcast. Must be called after the WebSocket server is created.
   */
  private subscribeToOrchestratorEvents(): void {
    this.orchestrator.on('agent:created', (agentId, name, type) => {
      this.broadcast('agent:created', { agentId, name, type });
    });

    this.orchestrator.on('agent:started', (agentId) => {
      this.broadcast('agent:started', { agentId });
    });

    this.orchestrator.on('agent:stopped', (agentId) => {
      this.broadcast('agent:stopped', { agentId });
    });

    this.orchestrator.on('alert', (alert) => {
      this.broadcast('alert', alert);
    });

    this.orchestrator.on('metrics:updated', (metrics) => {
      this.broadcast('metrics:updated', metrics);
    });

    this.orchestrator.on('pool:updated', (data) => {
      this.broadcast('pool:updated', data);
    });

    this.orchestrator.on('transaction:executed', (data) => {
      this.broadcast('transaction:executed', data);
    });
  }

  /**
   * Send the current full dashboard snapshot to a single newly connected
   * WebSocket client so it does not have to wait for the next broadcast cycle.
   */
  private sendInitialSnapshot(client: WebSocket): void {
    if (client.readyState !== WebSocket.OPEN) return;

    try {
      const snapshot: WsMessage = {
        event: 'snapshot',
        data: this.orchestrator.getDashboardState(),
        timestamp: Date.now(),
      };
      client.send(JSON.stringify(snapshot));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[DashboardServer] Failed to send initial snapshot:', message);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Start both the HTTP REST server and the WebSocket broadcast server.
   * Resolves once both servers are actively listening.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // ── HTTP server ──────────────────────────────────────────────────────────

      this.httpServer = http.createServer(this.app);

      this.httpServer.on('error', reject);

      this.httpServer.listen(this.port, '0.0.0.0', () => {
        console.log(`[DashboardServer] REST API listening on http://0.0.0.0:${this.port}`);

        // ── WebSocket server ───────────────────────────────────────────────────

        if (this.singlePort) {
          // Attach WebSocket to the same HTTP server — single port mode for Fly.io.
          this.wss = new WebSocketServer({ server: this.httpServer! });

          this.subscribeToOrchestratorEvents();

          this.wss.on('connection', (client: WebSocket) => {
            console.log('[DashboardServer] WebSocket client connected');
            this.sendInitialSnapshot(client);

            client.on('close', () => {
              console.log('[DashboardServer] WebSocket client disconnected');
            });

            client.on('error', (err) => {
              console.error('[DashboardServer] WebSocket client error:', err.message);
            });
          });

          console.log(`[DashboardServer] WebSocket server attached to same port ${this.port}`);
          resolve();
        } else {
          this.wsHttpServer = http.createServer();
          this.wss = new WebSocketServer({ server: this.wsHttpServer });

          this.subscribeToOrchestratorEvents();

          this.wss.on('connection', (client: WebSocket) => {
            console.log('[DashboardServer] WebSocket client connected');
            this.sendInitialSnapshot(client);

            client.on('close', () => {
              console.log('[DashboardServer] WebSocket client disconnected');
            });

            client.on('error', (err) => {
              console.error('[DashboardServer] WebSocket client error:', err.message);
            });
          });

          this.wsHttpServer.on('error', (err) => {
            console.error('[DashboardServer] WebSocket server error:', err.message);
          });

          this.wsHttpServer.listen(this.wsPort, () => {
            console.log(`[DashboardServer] WebSocket server listening on ws://localhost:${this.wsPort}`);
            resolve();
          });
        }
      });
    });
  }

  /**
   * Gracefully close both the HTTP REST server and the WebSocket server.
   * Resolves once both servers have fully shut down.
   */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      const closeWsServer = (): Promise<void> =>
        new Promise((wsResolve, wsReject) => {
          if (this.wss === null) {
            wsResolve();
            return;
          }

          // Terminate all active client connections before closing the server.
          for (const client of this.wss.clients) {
            client.terminate();
          }

          if (this.singlePort || this.wsHttpServer === null) {
            // In single-port mode the WSS shares the HTTP server; just close WSS.
            this.wss.close((err) => {
              if (err) {
                wsReject(err);
              } else {
                console.log('[DashboardServer] WebSocket server closed.');
                wsResolve();
              }
            });
          } else {
            this.wss.close(() => {
              this.wsHttpServer!.close((err) => {
                if (err) {
                  wsReject(err);
                } else {
                  console.log('[DashboardServer] WebSocket server closed.');
                  wsResolve();
                }
              });
            });
          }
        });

      const closeHttpServer = (): Promise<void> =>
        new Promise((httpResolve, httpReject) => {
          if (this.httpServer === null) {
            httpResolve();
            return;
          }

          this.httpServer.close((err) => {
            if (err) {
              httpReject(err);
            } else {
              console.log('[DashboardServer] HTTP server closed.');
              httpResolve();
            }
          });
        });

      closeWsServer()
        .then(() => closeHttpServer())
        .then(resolve)
        .catch(reject);
    });
  }
}

// ─── Standalone Execution ─────────────────────────────────────────────────────

if (require.main === module) {
  const orchestrator = new AgentOrchestrator();
  const server = new DashboardServer(orchestrator);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[DashboardServer] Received ${signal}. Initiating graceful shutdown...`);

    try {
      await server.stop();
      await orchestrator.shutdown();
      console.log('[DashboardServer] Shutdown complete.');
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[DashboardServer] Error during shutdown:', message);
      process.exit(1);
    }
  };

  server
    .start()
    .then(() => {
      console.log('');
      console.log('='.repeat(52));
      console.log('  SentinelVault Dashboard Server');
      console.log('='.repeat(52));
      console.log('  REST API  ->  http://localhost:3000');
      console.log('  WebSocket ->  ws://localhost:3001');
      console.log('');
      console.log('  Endpoints:');
      console.log('    GET  /api/health');
      console.log('    GET  /api/metrics');
      console.log('    GET  /api/dashboard');
      console.log('    GET  /api/agents');
      console.log('    GET  /api/agents/:id/decisions');
      console.log('    POST /api/agents');
      console.log('    POST /api/agents/:id/start');
      console.log('    POST /api/agents/:id/stop');
      console.log('    POST /api/agents/:id/pause');
      console.log('    POST /api/agents/:id/resume');
      console.log('    DEL  /api/agents/:id');
      console.log('    GET  /api/pool');
      console.log('    GET  /api/transactions');
      console.log('    GET  /api/audit');
      console.log('    GET  /api/risk');
      console.log('    GET  /api/alerts');
      console.log('    GET  /api/kora');
      console.log('='.repeat(52));
      console.log('');
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[DashboardServer] Failed to start:', message);
      process.exit(1);
    });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
