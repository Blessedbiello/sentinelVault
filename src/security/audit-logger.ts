import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  AuditLevel,
  AuditCategory,
  AuditEntry,
  AuditQueryFilters,
  RiskSummary,
} from '../types';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const MAX_IN_MEMORY_ENTRIES = 5000;
const HIGH_RISK_THRESHOLD = 0.7;
const TOP_RISKS_LIMIT = 10;

const CATEGORY_BASE_SCORES: Record<AuditCategory, number> = {
  wallet_operation: 0.2,
  transaction: 0.3,
  security_event: 0.7,
  agent_decision: 0.1,
  system_event: 0.05,
  policy_violation: 0.8,
};

export class AuditLogger {
  private readonly auditDir: string;
  private readonly writeStream: fs.WriteStream;
  private readonly entries: AuditEntry[] = [];

  constructor(auditDir: string = '.sentinelvault/audit') {
    this.auditDir = auditDir;
    fs.mkdirSync(this.auditDir, { recursive: true });

    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const logFile = path.join(this.auditDir, `audit-${dateStr}.jsonl`);
    this.writeStream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private log(entry: AuditEntry): void {
    this.writeStream.write(JSON.stringify(entry) + '\n');

    if (this.entries.length >= MAX_IN_MEMORY_ENTRIES) {
      this.entries.shift();
    }
    this.entries.push(entry);
  }

  private calculateRiskScore(
    category: AuditCategory,
    action: string,
    details: Record<string, unknown>,
  ): number {
    let score = CATEGORY_BASE_SCORES[category];

    // Amount modifier: each SOL adds 0.05 risk, contribution uncapped before final cap
    const amountSol = details.amountSol;
    if (typeof amountSol === 'number' && amountSol > 0) {
      score += amountSol * 0.05;
    }

    // Unknown program penalty
    const programId = details.programId;
    if (typeof programId === 'string' && programId !== SYSTEM_PROGRAM_ID) {
      score += 0.2;
    }

    // Error penalty
    if (details.error !== undefined && details.error !== null) {
      score += 0.15;
    }

    return Math.min(score, 1.0);
  }

  private buildEntry(
    level: AuditLevel,
    category: AuditCategory,
    agentId: string,
    walletId: string,
    action: string,
    details: Record<string, unknown>,
    transactionSignature?: string,
  ): AuditEntry {
    const riskScore = this.calculateRiskScore(category, action, details);
    return {
      id: uuidv4(),
      timestamp: Date.now(),
      level,
      category,
      agentId,
      walletId,
      action,
      details,
      transactionSignature,
      riskScore,
    };
  }

  // -------------------------------------------------------------------------
  // Public logging methods
  // -------------------------------------------------------------------------

  logWalletOperation(
    agentId: string,
    walletId: string,
    action: string,
    details: Record<string, unknown>,
  ): void {
    const entry = this.buildEntry(
      'info',
      'wallet_operation',
      agentId,
      walletId,
      action,
      details,
    );
    this.log(entry);
  }

  logTransaction(
    agentId: string,
    walletId: string,
    action: string,
    details: Record<string, unknown>,
    signature?: string,
  ): void {
    const entry = this.buildEntry(
      'info',
      'transaction',
      agentId,
      walletId,
      action,
      details,
      signature,
    );
    this.log(entry);
  }

  logSecurityEvent(
    agentId: string,
    walletId: string,
    action: string,
    details: Record<string, unknown>,
    level: AuditLevel = 'warning',
  ): void {
    const entry = this.buildEntry(
      level,
      'security_event',
      agentId,
      walletId,
      action,
      details,
    );
    this.log(entry);
  }

  logAgentDecision(
    agentId: string,
    walletId: string,
    action: string,
    details: Record<string, unknown>,
  ): void {
    const entry = this.buildEntry(
      'info',
      'agent_decision',
      agentId,
      walletId,
      action,
      details,
    );
    this.log(entry);
  }

  logSystemEvent(action: string, details: Record<string, unknown>): void {
    const entry = this.buildEntry(
      'info',
      'system_event',
      'system',
      'system',
      action,
      details,
    );
    this.log(entry);
  }

  // -------------------------------------------------------------------------
  // Query and analysis methods
  // -------------------------------------------------------------------------

  query(filters: AuditQueryFilters): AuditEntry[] {
    let results = this.entries.filter((entry) => {
      if (filters.agentId !== undefined && entry.agentId !== filters.agentId) {
        return false;
      }
      if (filters.walletId !== undefined && entry.walletId !== filters.walletId) {
        return false;
      }
      if (filters.category !== undefined && entry.category !== filters.category) {
        return false;
      }
      if (filters.level !== undefined && entry.level !== filters.level) {
        return false;
      }
      if (filters.since !== undefined && entry.timestamp < filters.since) {
        return false;
      }
      return true;
    });

    if (filters.limit !== undefined && filters.limit > 0) {
      results = results.slice(-filters.limit);
    }

    return results;
  }

  getRiskSummary(): RiskSummary {
    const totalEntries = this.entries.length;

    if (totalEntries === 0) {
      return {
        averageRiskScore: 0,
        highRiskCount: 0,
        totalEntries: 0,
        topRisksByAction: [],
      };
    }

    const totalRisk = this.entries.reduce((sum, e) => sum + e.riskScore, 0);
    const averageRiskScore = totalRisk / totalEntries;
    const highRiskCount = this.entries.filter(
      (e) => e.riskScore > HIGH_RISK_THRESHOLD,
    ).length;

    // Aggregate risk scores by action
    const actionMap = new Map<string, { totalRisk: number; count: number }>();
    for (const entry of this.entries) {
      const existing = actionMap.get(entry.action);
      if (existing) {
        existing.totalRisk += entry.riskScore;
        existing.count += 1;
      } else {
        actionMap.set(entry.action, { totalRisk: entry.riskScore, count: 1 });
      }
    }

    const topRisksByAction = Array.from(actionMap.entries())
      .map(([action, { totalRisk, count }]) => ({
        action,
        avgRisk: totalRisk / count,
        count,
      }))
      .sort((a, b) => b.avgRisk - a.avgRisk)
      .slice(0, TOP_RISKS_LIMIT);

    return {
      averageRiskScore,
      highRiskCount,
      totalEntries,
      topRisksByAction,
    };
  }

  getRecentEntries(count: number): AuditEntry[] {
    return this.entries.slice(-count);
  }

  export(filepath: string): void {
    fs.writeFileSync(filepath, JSON.stringify(this.entries, null, 2), 'utf-8');
  }

  close(): void {
    this.writeStream.end();
  }
}
