import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { AuditLogger } from '../src/security/audit-logger';

describe('AuditLogger', () => {
  const tmpDir = path.join(os.tmpdir(), `sv-test-audit-${Date.now()}`);
  const auditDir = path.join(tmpDir, 'audit');
  let logger: AuditLogger;

  beforeAll(() => {
    logger = new AuditLogger(auditDir);
  });

  afterAll(async () => {
    logger.close();
    // Allow the write stream to finish before removing the directory
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('logWalletOperation', () => {
    it('creates entry with correct category and level', () => {
      logger.logWalletOperation('agent-1', 'wallet-1', 'create_wallet', { name: 'test' });

      const entries = logger.getRecentEntries(1);
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.category).toBe('wallet_operation');
      expect(entry.level).toBe('info');
      expect(entry.agentId).toBe('agent-1');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.action).toBe('create_wallet');
      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeGreaterThan(0);
    });
  });

  describe('logTransaction', () => {
    it('creates entry with transaction signature', () => {
      const sig = 'abc123signature';
      logger.logTransaction('agent-2', 'wallet-2', 'transfer', { amountSol: 1 }, sig);

      const entries = logger.query({ agentId: 'agent-2', category: 'transaction' });
      expect(entries).toHaveLength(1);
      expect(entries[0].transactionSignature).toBe(sig);
      expect(entries[0].category).toBe('transaction');
    });
  });

  describe('logSecurityEvent', () => {
    it('uses the provided level', () => {
      logger.logSecurityEvent('agent-3', 'wallet-3', 'suspicious_activity', { reason: 'test' }, 'critical');

      const entries = logger.query({ agentId: 'agent-3', category: 'security_event' });
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('critical');
      expect(entries[0].category).toBe('security_event');
    });

    it('defaults to warning level when not specified', () => {
      logger.logSecurityEvent('agent-3b', 'wallet-3b', 'minor_issue', { reason: 'default' });

      const entries = logger.query({ agentId: 'agent-3b' });
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('warning');
    });
  });

  describe('logSystemEvent', () => {
    it('uses system for agentId and walletId', () => {
      logger.logSystemEvent('startup', { version: '1.0' });

      const entries = logger.query({ agentId: 'system', category: 'system_event' });
      expect(entries.length).toBeGreaterThanOrEqual(1);

      const entry = entries[entries.length - 1];
      expect(entry.agentId).toBe('system');
      expect(entry.walletId).toBe('system');
      expect(entry.category).toBe('system_event');
    });
  });

  describe('query', () => {
    it('filters by agentId', () => {
      const results = logger.query({ agentId: 'agent-1' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      results.forEach((e) => expect(e.agentId).toBe('agent-1'));
    });

    it('filters by category', () => {
      const results = logger.query({ category: 'transaction' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      results.forEach((e) => expect(e.category).toBe('transaction'));
    });

    it('filters by since timestamp', () => {
      const before = Date.now();
      logger.logWalletOperation('agent-since', 'wallet-since', 'check', {});
      const results = logger.query({ agentId: 'agent-since', since: before });
      expect(results).toHaveLength(1);
    });

    it('respects limit parameter', () => {
      logger.logWalletOperation('agent-limit', 'wallet-limit', 'op1', {});
      logger.logWalletOperation('agent-limit', 'wallet-limit', 'op2', {});
      logger.logWalletOperation('agent-limit', 'wallet-limit', 'op3', {});

      const results = logger.query({ agentId: 'agent-limit', limit: 2 });
      expect(results).toHaveLength(2);
      expect(results[0].action).toBe('op2');
      expect(results[1].action).toBe('op3');
    });
  });

  describe('risk score calculation', () => {
    it('calculates transaction risk with amountSol modifier', () => {
      logger.logTransaction('agent-risk', 'wallet-risk', 'send', { amountSol: 2 });

      const entries = logger.query({ agentId: 'agent-risk', category: 'transaction' });
      const entry = entries[entries.length - 1];
      // base 0.3 + (2 * 0.05) = 0.4
      expect(entry.riskScore).toBeCloseTo(0.4, 5);
    });

    it('applies error penalty to security event score', () => {
      logger.logSecurityEvent('agent-err', 'wallet-err', 'failed_auth', { error: 'timeout' });

      const entries = logger.query({ agentId: 'agent-err', category: 'security_event' });
      const entry = entries[entries.length - 1];
      // base 0.7 + error 0.15 = 0.85
      expect(entry.riskScore).toBeGreaterThan(0.7 + 0.15 - 0.001);
      expect(entry.riskScore).toBeCloseTo(0.85, 5);
    });

    it('caps risk score at 1.0', () => {
      logger.logSecurityEvent('agent-cap', 'wallet-cap', 'breach', {
        amountSol: 100,
        programId: 'unknownProgram',
        error: 'critical failure',
      });

      const entries = logger.query({ agentId: 'agent-cap' });
      const entry = entries[entries.length - 1];
      expect(entry.riskScore).toBe(1.0);
    });
  });

  describe('getRiskSummary', () => {
    it('returns correct totals', () => {
      const summary = logger.getRiskSummary();

      expect(summary.totalEntries).toBeGreaterThan(0);
      expect(summary.averageRiskScore).toBeGreaterThan(0);
      expect(summary.averageRiskScore).toBeLessThanOrEqual(1.0);
      expect(typeof summary.highRiskCount).toBe('number');
      expect(summary.highRiskCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(summary.topRisksByAction)).toBe(true);
      summary.topRisksByAction.forEach((item) => {
        expect(item).toHaveProperty('action');
        expect(item).toHaveProperty('avgRisk');
        expect(item).toHaveProperty('count');
      });
    });
  });

  describe('getRecentEntries', () => {
    it('returns the last N entries', () => {
      const allEntries = logger.getRecentEntries(1000);
      const totalCount = allEntries.length;

      const recent3 = logger.getRecentEntries(3);
      expect(recent3).toHaveLength(3);
      expect(recent3[0].id).toBe(allEntries[totalCount - 3].id);
      expect(recent3[2].id).toBe(allEntries[totalCount - 1].id);
    });
  });

  describe('export', () => {
    it('writes entries to a JSON file', () => {
      const exportPath = path.join(tmpDir, 'export.json');
      logger.export(exportPath);

      expect(fs.existsSync(exportPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      expect(data[0]).toHaveProperty('id');
      expect(data[0]).toHaveProperty('category');
      expect(data[0]).toHaveProperty('riskScore');
    });
  });

  describe('close', () => {
    it('does not throw when called', () => {
      const tempLogger = new AuditLogger(path.join(tmpDir, 'close-test'));
      expect(() => tempLogger.close()).not.toThrow();
    });
  });
});
