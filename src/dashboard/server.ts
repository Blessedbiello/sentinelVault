// SentinelVault — DashboardServer
// Express REST API + WebSocket push layer for the SentinelVault dashboard.
// REST endpoints run on port 3000; the WebSocket broadcast server runs on 3001.

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { Server as WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { AgentOrchestrator } from '../agents/orchestrator';
import { PolicyEngine } from '../security/policy-engine';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardServerConfig {
  port?: number;
  wsPort?: number;
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

    this.app = express();
    this.configureMiddleware();
    this.registerRoutes();
  }

  // ── Private Setup ─────────────────────────────────────────────────────────

  /** Attach global middleware to the Express application. */
  private configureMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
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
        const { name, type, strategy, password, cluster } = req.body as {
          name: string;
          type: string;
          strategy: unknown;
          password: string;
          cluster?: string;
        };

        const id = await this.orchestrator.createAgent({
          name,
          type: type as any,
          strategy: strategy as any,
          password,
          cluster: cluster as any,
        });

        res.status(201).json({ id, message: `Agent "${name}" created successfully.` });
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

        const entries = this.orchestrator.getAuditLogger().query(filters as any);
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

      this.httpServer.listen(this.port, () => {
        console.log(`[DashboardServer] REST API listening on http://localhost:${this.port}`);

        // ── WebSocket server ───────────────────────────────────────────────────

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
          if (this.wss === null || this.wsHttpServer === null) {
            wsResolve();
            return;
          }

          // Terminate all active client connections before closing the server.
          for (const client of this.wss.clients) {
            client.terminate();
          }

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
      console.log('    POST /api/agents');
      console.log('    POST /api/agents/:id/start');
      console.log('    POST /api/agents/:id/stop');
      console.log('    POST /api/agents/:id/pause');
      console.log('    POST /api/agents/:id/resume');
      console.log('    DEL  /api/agents/:id');
      console.log('    GET  /api/audit');
      console.log('    GET  /api/risk');
      console.log('    GET  /api/alerts');
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
