// SentinelVault — Transaction Engine
// Priority-queued transaction processor with retry logic and metrics tracking

import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import {
  TransactionRequest,
  TransactionResult,
  TransactionRecord,
  TransactionPriority,
  TransactionOptions,
} from '../types';

// ─── Configuration ────────────────────────────────────────────────────────────

interface TransactionEngineConfig {
  maxHistorySize?: number;
  defaultRetries?: number;
  defaultPriority?: TransactionPriority;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface TransactionMetrics {
  totalSubmitted: number;
  totalConfirmed: number;
  totalFailed: number;
  totalRetries: number;
  averageConfirmationTime: number;
  totalFeePaid: number;
}

// ─── Priority Fee Map (microlamports for ComputeBudgetProgram) ────────────────

const PRIORITY_FEES: Record<TransactionPriority, number> = {
  critical: 100000,
  high: 50000,
  medium: 10000,
  low: 1000,
};

// ─── Priority Ordering (highest → lowest) ────────────────────────────────────

const PRIORITY_ORDER: TransactionPriority[] = ['critical', 'high', 'medium', 'low'];

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_HISTORY = 1_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_PRIORITY: TransactionPriority = 'medium';

// ─── TransactionEngine ────────────────────────────────────────────────────────

export class TransactionEngine extends EventEmitter {
  private readonly queue: Map<TransactionPriority, TransactionRecord[]>;
  private isProcessing: boolean;
  private history: TransactionRecord[];
  private metrics: TransactionMetrics;

  private readonly maxHistorySize: number;
  private readonly defaultRetries: number;
  private readonly defaultPriority: TransactionPriority;

  constructor(config: TransactionEngineConfig = {}) {
    super();

    this.maxHistorySize = config.maxHistorySize ?? DEFAULT_MAX_HISTORY;
    this.defaultRetries = config.defaultRetries ?? DEFAULT_MAX_RETRIES;
    this.defaultPriority = config.defaultPriority ?? DEFAULT_PRIORITY;

    // Initialise queue with all priority levels so iteration order is stable
    this.queue = new Map([
      ['critical', []],
      ['high', []],
      ['medium', []],
      ['low', []],
    ]);

    this.isProcessing = false;
    this.history = [];

    this.metrics = {
      totalSubmitted: 0,
      totalConfirmed: 0,
      totalFailed: 0,
      totalRetries: 0,
      averageConfirmationTime: 0,
      totalFeePaid: 0,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Enqueue a transaction request and return its tracking record.
   * The caller owns the request ID; a new record ID is generated here so that
   * re-submissions of the same request always produce distinct records.
   */
  submit(request: TransactionRequest): TransactionRecord {
    const record: TransactionRecord = {
      id: uuidv4(),
      request,
      result: null,
      attempts: 0,
      createdAt: Date.now(),
      completedAt: null,
      status: 'pending',
    };

    const priority = request.priority ?? this.defaultPriority;
    const bucket = this.queue.get(priority)!;
    bucket.push(record);

    this.metrics.totalSubmitted += 1;

    this.emit('transaction:queued', record);

    return record;
  }

  /**
   * Drain the queue in priority order, executing each record via the provided
   * executor callback. Retries failed attempts with exponential backoff.
   * Concurrent calls are serialised — if already processing, the call returns
   * immediately so the caller does not need to guard externally.
   */
  async processQueue(
    executor: (record: TransactionRecord) => Promise<TransactionResult>,
  ): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      let record: TransactionRecord | undefined;

      while ((record = this.getNextFromQueue()) !== undefined) {
        await this.executeRecord(record, executor);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /** Total number of records across all priority buckets. */
  getQueueSize(): number {
    let total = 0;
    for (const bucket of this.queue.values()) {
      total += bucket.length;
    }
    return total;
  }

  /** Per-priority record counts. */
  getQueueSizeByPriority(): Record<TransactionPriority, number> {
    return {
      critical: this.queue.get('critical')!.length,
      high: this.queue.get('high')!.length,
      medium: this.queue.get('medium')!.length,
      low: this.queue.get('low')!.length,
    };
  }

  /**
   * Return up to `limit` most-recent history entries (newest first).
   * Omitting `limit` returns the full history array.
   */
  getHistory(limit?: number): TransactionRecord[] {
    const reversed = [...this.history].reverse();
    return limit !== undefined ? reversed.slice(0, limit) : reversed;
  }

  /** Snapshot of current aggregate metrics. */
  getMetrics(): TransactionMetrics {
    return { ...this.metrics };
  }

  /**
   * Locate a record by ID, checking the in-flight queue first, then history.
   * Returns `undefined` when no match is found.
   */
  getRecord(id: string): TransactionRecord | undefined {
    for (const bucket of this.queue.values()) {
      const found = bucket.find((r) => r.id === id);
      if (found) return found;
    }
    return this.history.find((r) => r.id === id);
  }

  /** Wipe the history buffer. Does not affect the queue or metrics. */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Remove a still-pending record from the queue.
   * Returns `true` when the record was found and removed, `false` otherwise
   * (e.g. already processing, completed, or not found).
   */
  cancelPending(id: string): boolean {
    for (const [priority, bucket] of this.queue.entries()) {
      const index = bucket.findIndex((r) => r.id === id && r.status === 'pending');
      if (index !== -1) {
        bucket.splice(index, 1);
        this.queue.set(priority, bucket);
        return true;
      }
    }
    return false;
  }

  /**
   * Convenience helper — returns the recommended priority fee in microlamports
   * for a given priority level, suitable for use with ComputeBudgetProgram.
   */
  getPriorityFee(priority: TransactionPriority): number {
    return PRIORITY_FEES[priority];
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Execute a single record, managing the full retry lifecycle.
   * Updates the record in-place so that any external references remain valid.
   */
  private async executeRecord(
    record: TransactionRecord,
    executor: (record: TransactionRecord) => Promise<TransactionResult>,
  ): Promise<void> {
    const maxRetries = record.request.maxRetries ?? this.defaultRetries;

    record.status = 'processing';
    this.emit('transaction:processing', record);

    while (record.attempts <= maxRetries) {
      if (record.attempts > 0) {
        const delay = this.calculateBackoffDelay(record.attempts - 1, BASE_BACKOFF_MS);
        this.metrics.totalRetries += 1;
        this.emit('transaction:retry', record, record.attempts, delay);
        await this.sleep(delay);
      }

      record.attempts += 1;

      try {
        const result = await executor(record);
        record.result = result;

        if (result.status === 'confirmed' || result.status === 'finalized') {
          record.status = 'completed';
          record.completedAt = Date.now();
          this.updateMetrics(record);
          this.addToHistory(record);
          this.emit('transaction:completed', record);
          return;
        }

        // Treat non-terminal statuses (e.g. 'failed', 'timeout') as retryable
        // until retries are exhausted.
        if (record.attempts > maxRetries) {
          break;
        }
      } catch (err: unknown) {
        // Executor threw synchronously or the promise rejected.
        // Patch a minimal result so the record carries the error context.
        const errorMessage = err instanceof Error ? err.message : String(err);
        record.result = {
          id: record.id,
          signature: '',
          status: 'failed',
          slot: 0,
          blockTime: null,
          fee: 0,
          error: errorMessage,
          logs: [],
          duration: 0,
        };

        if (record.attempts > maxRetries) {
          break;
        }
      }
    }

    // All attempts exhausted without a successful outcome.
    record.status = 'failed';
    record.completedAt = Date.now();
    this.updateMetrics(record);
    this.addToHistory(record);
    this.emit('transaction:failed', record);
  }

  /**
   * Append a completed/failed record to history, evicting the oldest entry
   * when the cap is exceeded.
   */
  private addToHistory(record: TransactionRecord): void {
    this.history.push(record);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  /**
   * Update aggregate counters and the rolling average confirmation time.
   * Called once per record immediately after its terminal state is set.
   */
  private updateMetrics(record: TransactionRecord): void {
    if (record.status === 'completed') {
      this.metrics.totalConfirmed += 1;

      if (record.result?.fee) {
        this.metrics.totalFeePaid += record.result.fee;
      }

      if (record.completedAt !== null) {
        const duration = record.completedAt - record.createdAt;
        const prevTotal = this.metrics.averageConfirmationTime * (this.metrics.totalConfirmed - 1);
        this.metrics.averageConfirmationTime =
          (prevTotal + duration) / this.metrics.totalConfirmed;
      }
    } else if (record.status === 'failed') {
      this.metrics.totalFailed += 1;
    }
  }

  /**
   * Pop the next record from the highest-priority non-empty bucket.
   * Returns `undefined` when all buckets are empty.
   */
  private getNextFromQueue(): TransactionRecord | undefined {
    for (const priority of PRIORITY_ORDER) {
      const bucket = this.queue.get(priority)!;
      if (bucket.length > 0) {
        return bucket.shift();
      }
    }
    return undefined;
  }

  /**
   * Exponential backoff: baseDelay × 2^attempt, capped at MAX_BACKOFF_MS.
   *
   * @param attempt  Zero-based retry index (0 = first retry).
   * @param baseDelay  Starting delay in milliseconds.
   */
  private calculateBackoffDelay(attempt: number, baseDelay: number): number {
    const delay = baseDelay * Math.pow(2, attempt);
    return Math.min(delay, MAX_BACKOFF_MS);
  }

  /** Thin wrapper around `setTimeout` returning a cancellable promise. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
