// SentinelVault — TradingAgent Test Suite
// Tests all OODA phases, price simulation, SMA calculation, multi-factor
// scoring, strategy variants, trade sizing, and policy estimation for the
// TradingAgent class.

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgenticWallet } from '../src/core/wallet';
import { TradingAgent } from '../src/agents/trading-agent';
import { AgentConfig, AgentDecision } from '../src/types';

// ── Mock KeystoreManager ─────────────────────────────────────────────────────

const testKeypair = Keypair.generate();
const TEST_PUBLIC_KEY = testKeypair.publicKey.toBase58();

jest.mock('../src/core/keystore', () => ({
  KeystoreManager: jest.fn().mockImplementation(() => ({
    createEncryptedWallet: jest.fn().mockResolvedValue({
      publicKey: TEST_PUBLIC_KEY,
      keystoreId: 'test-ks-id',
      path: '/tmp/test',
    }),
    decryptKeypair: jest.fn().mockReturnValue(testKeypair),
    verifyPassword: jest.fn().mockReturnValue(true),
  })),
}));

// ── Mock global.fetch (ensure integration clients fall back gracefully) ─────

(global as any).fetch = jest.fn().mockRejectedValue(new Error('No network in tests'));

// ── Mock @solana/web3.js Connection ──────────────────────────────────────────

const mockGetBalance = jest.fn().mockResolvedValue(2 * LAMPORTS_PER_SOL);
const mockGetLatestBlockhash = jest.fn().mockResolvedValue({
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
  lastValidBlockHeight: 100,
});
const mockSendRawTransaction = jest.fn().mockResolvedValue(
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQU',
);
const mockConfirmTransaction = jest.fn().mockResolvedValue({ value: {} });

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getBalance: mockGetBalance,
      getLatestBlockhash: mockGetLatestBlockhash,
      sendRawTransaction: mockSendRawTransaction,
      confirmTransaction: mockConfirmTransaction,
    })),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

function makeConfig(
  strategyType: 'dca' | 'momentum' | 'mean_reversion',
  overrides: Record<string, unknown> = {},
): AgentConfig {
  return {
    id: 'trading-test-1',
    name: 'TestTrader',
    type: 'trader',
    walletConfig: {
      id: 'tw1',
      label: 'TraderWallet',
      password: 'test-pass',
      cluster: 'devnet',
    },
    strategy: {
      name: strategyType,
      type: strategyType,
      params: { targetAddress: SYSTEM_PROGRAM, ...overrides },
      riskLevel: 'moderate',
      maxPositionSize: 0.01,
      cooldownMs: 60_000,
    },
    securityPolicy: {
      spendingLimits: {
        perTransaction: 1,
        hourly: 5,
        daily: 20,
        weekly: 100,
        monthly: 500,
      },
      allowedPrograms: [SYSTEM_PROGRAM],
      blockedAddresses: [],
      requireSimulation: false,
      maxTransactionsPerMinute: 10,
      maxTransactionsPerHour: 60,
      maxTransactionsPerDay: 500,
      alertThresholds: [],
    },
    enabled: true,
  };
}

async function buildAgent(
  strategyType: 'dca' | 'momentum' | 'mean_reversion',
  overrides: Record<string, unknown> = {},
): Promise<{ agent: TradingAgent; wallet: AgenticWallet }> {
  const config = makeConfig(strategyType, overrides);
  const wallet = new AgenticWallet(config.walletConfig);
  await wallet.initialize();
  const agent = new TradingAgent(config, wallet);
  return { agent, wallet };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TradingAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default 2 SOL balance for each test.
    mockGetBalance.mockResolvedValue(2 * LAMPORTS_PER_SOL);
  });

  // ── Price Simulation ───────────────────────────────────────────────────────

  describe('simulatePrice', () => {
    it('keeps all generated prices within [0.5 * basePrice, 1.5 * basePrice]', async () => {
      const { agent } = await buildAgent('dca');

      const BASE_PRICE = 1.0;
      const LOWER = BASE_PRICE * 0.5;
      const UPPER = BASE_PRICE * 1.5;
      const ITERATIONS = 100;

      for (let i = 0; i < ITERATIONS; i++) {
        const price = (agent as unknown as Record<string, () => number>).simulatePrice();
        expect(price).toBeGreaterThanOrEqual(LOWER);
        expect(price).toBeLessThanOrEqual(UPPER);
      }
    });
  });

  // ── SMA Calculation ────────────────────────────────────────────────────────

  describe('sma', () => {
    it('returns currentPrice when priceHistory is empty', async () => {
      const { agent } = await buildAgent('dca');
      const agentAny = agent as unknown as Record<string, unknown>;

      // Ensure history is empty and currentPrice is at its initial value.
      agentAny.priceHistory = [];
      agentAny.currentPrice = 1.0;

      const result = (agentAny.sma as (period: number) => number)(20);
      expect(result).toBe(1.0);
    });

    it('returns the correct average for the last `period` entries', async () => {
      const { agent } = await buildAgent('dca');
      const agentAny = agent as unknown as Record<string, unknown>;

      // Set a known history. sma(3) should average the last 3 entries: [3, 4, 5].
      agentAny.priceHistory = [1, 2, 3, 4, 5];

      const result = (agentAny.sma as (period: number) => number)(3);
      expect(result).toBeCloseTo(4.0, 10);
    });
  });

  // ── DCA Strategy ───────────────────────────────────────────────────────────

  describe('DCA strategy', () => {
    it('analyze always returns action "buy" with confidence >= DCA_CONFIDENCE (0.6)', async () => {
      const { agent } = await buildAgent('dca');

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);

      expect(decision.action).toBe('buy');
      expect(decision.confidence).toBeGreaterThanOrEqual(0.6);
    });
  });

  // ── Momentum Strategy ──────────────────────────────────────────────────────

  describe('Momentum strategy', () => {
    it('returns "hold" with HOLD_CONFIDENCE (0.3) when there is no clear directional signal', async () => {
      const { agent } = await buildAgent('momentum');

      // A fresh agent has an empty price history, so sma20 === sma50 === currentPrice.
      // The composite score will sit near 0.5 (neutral) triggering the hold branch.
      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);

      // Momentum's neutral path sets confidence to HOLD_CONFIDENCE = 0.3
      // and action to 'hold'. The composite with one price tick and a 2 SOL
      // balance will land in the neutral zone [0.45, 0.55].
      expect(decision.action).toBe('hold');
      expect(decision.confidence).toBe(0.3);
    });
  });

  // ── Mean Reversion Strategy ────────────────────────────────────────────────

  describe('Mean reversion strategy', () => {
    it('returns "buy" when currentPrice < 0.95 * basePrice', async () => {
      const { agent } = await buildAgent('mean_reversion');
      const agentAny = agent as unknown as Record<string, unknown>;

      // Force price below buy threshold (0.95 * 1.0 = 0.95).
      agentAny.currentPrice = 0.8;
      (agentAny.priceHistory as number[]).push(0.8);

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);

      expect(decision.action).toBe('buy');
    });

    it('returns "sell" when currentPrice > 1.05 * basePrice', async () => {
      const { agent } = await buildAgent('mean_reversion');
      const agentAny = agent as unknown as Record<string, unknown>;

      // Force price above sell threshold (1.05 * 1.0 = 1.05).
      agentAny.currentPrice = 1.2;
      (agentAny.priceHistory as number[]).push(1.2);

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);

      expect(decision.action).toBe('sell');
    });
  });

  // ── Multi-factor Scoring ───────────────────────────────────────────────────

  describe('Multi-factor scoring', () => {
    it('decision.marketConditions contains all four factor scores and compositeConfidence', async () => {
      const { agent } = await buildAgent('dca');

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);

      const mc = decision.marketConditions;
      expect(mc).toHaveProperty('trendScore');
      expect(mc).toHaveProperty('momentumScore');
      expect(mc).toHaveProperty('volatilityScore');
      expect(mc).toHaveProperty('balanceScore');
      expect(mc).toHaveProperty('compositeConfidence');

      // All scores must be numeric values in [0, 1].
      for (const key of ['trendScore', 'momentumScore', 'volatilityScore', 'balanceScore', 'compositeConfidence']) {
        const value = mc[key] as number;
        expect(typeof value).toBe('number');
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });

    it('compositeConfidence equals the weighted sum using adaptive weights', async () => {
      const { agent } = await buildAgent('dca');
      const aw = agent.getAdaptiveWeights();

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);

      const mc = decision.marketConditions;
      const expected =
        aw.trend * (mc.trendScore as number) +
        aw.momentum * (mc.momentumScore as number) +
        aw.volatility * (mc.volatilityScore as number) +
        aw.balance * (mc.balanceScore as number);

      expect(mc.compositeConfidence as number).toBeCloseTo(expected, 10);
    });
  });

  // ── Reasoning Chain ────────────────────────────────────────────────────────

  describe('Reasoning chain', () => {
    it('reasoningChain has at least 9 entries including [Regime] and [Weights]', async () => {
      const { agent } = await buildAgent('dca');

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);

      const chain = decision.marketConditions.reasoningChain as string[];
      expect(Array.isArray(chain)).toBe(true);
      expect(chain.length).toBeGreaterThanOrEqual(9);
      // Verify structural prefixes including new adaptive entries.
      expect(chain[0]).toMatch(/^\[Price\]/);
      expect(chain[1]).toMatch(/^\[Regime\]/);
      expect(chain[2]).toMatch(/^\[Trend\]/);
      expect(chain[3]).toMatch(/^\[Momentum\]/);
      expect(chain[4]).toMatch(/^\[Volatility\]/);
      expect(chain[5]).toMatch(/^\[Balance\]/);
      expect(chain[6]).toMatch(/^\[Weights\]/);
      expect(chain[7]).toMatch(/^\[Composite\]/);
      expect(chain[8]).toMatch(/^\[Decision\]/);
    });
  });

  // ── Adaptive Weights ────────────────────────────────────────────────────

  describe('Adaptive weights', () => {
    it('analyze uses adaptiveWeights instead of hard-coded values', async () => {
      const { agent } = await buildAgent('dca');

      // Modify adaptive weights to verify they're actually used
      const agentAny = agent as any;
      agentAny.adaptiveWeights = { trend: 0.7, momentum: 0.1, volatility: 0.1, balance: 0.1 };

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);

      const mc = decision.marketConditions;
      // With trend weight=0.7 instead of 0.4, composite should differ
      const expected =
        0.7 * (mc.trendScore as number) +
        0.1 * (mc.momentumScore as number) +
        0.1 * (mc.volatilityScore as number) +
        0.1 * (mc.balanceScore as number);

      expect(mc.compositeConfidence as number).toBeCloseTo(expected, 5);
    });

    it('evaluate calls updateWeights on confirmed trade', async () => {
      mockGetBalance.mockResolvedValue(2 * LAMPORTS_PER_SOL);
      const { agent } = await buildAgent('dca');

      // Seed price history with at least 2 entries
      const agentAny = agent as any;
      agentAny.priceHistory = [1.0, 1.05];

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);
      const action = await (agent as unknown as { execute(d: AgentDecision): Promise<unknown> }).execute(decision);
      await (agent as unknown as { evaluate(a: unknown, d: AgentDecision): Promise<void> }).evaluate(action, decision);

      // Weight history should have been updated
      expect(agent.getWeightHistory().length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Trade Sizing ───────────────────────────────────────────────────────────

  describe('Trade sizing', () => {
    it('caps amount at MAX_TRADE_AMOUNT_SOL (0.01) when balance is large', async () => {
      // Balance = 2.0 SOL → 10 % = 0.2, capped to 0.01.
      mockGetBalance.mockResolvedValue(2 * LAMPORTS_PER_SOL);
      const { agent } = await buildAgent('dca');

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);

      const action = await (agent as unknown as { execute(d: AgentDecision): Promise<unknown> }).execute(decision);

      expect(action).not.toBeNull();
      const details = (action as { details: Record<string, unknown> }).details;
      expect(details.amountSol).toBe(0.01);
    });

    it('skips execution and returns null when balance is below the minimum threshold', async () => {
      // Balance = 0.005 SOL → 10 % = 0.0005, below MIN_TRADE_AMOUNT_SOL (0.001).
      mockGetBalance.mockResolvedValue(0.005 * LAMPORTS_PER_SOL);
      const { agent } = await buildAgent('dca');

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);
      // Override action to 'buy' so execute does not bail out on 'hold'.
      decision.action = 'buy';

      const action = await (agent as unknown as { execute(d: AgentDecision): Promise<unknown> }).execute(decision);

      expect(action).toBeNull();
    });
  });

  // ── Execute ────────────────────────────────────────────────────────────────

  describe('execute', () => {
    it('returns AgentAction with type "transfer_sol:buy" when decision action is "buy"', async () => {
      mockGetBalance.mockResolvedValue(2 * LAMPORTS_PER_SOL);
      const { agent } = await buildAgent('dca');

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);
      // DCA always returns 'buy', but be explicit for clarity.
      decision.action = 'buy';

      const action = await (agent as unknown as { execute(d: AgentDecision): Promise<unknown> }).execute(decision);

      expect(action).not.toBeNull();
      expect((action as { type: string }).type).toBe('transfer_sol:buy');
      expect(mockSendRawTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns null without submitting a transaction when decision action is "hold"', async () => {
      const { agent } = await buildAgent('dca');

      // Construct a minimal hold decision — the balance value does not matter
      // because execute() returns immediately on 'hold'.
      const holdDecision: AgentDecision = {
        id: 'test-hold-id',
        agentId: 'trading-test-1',
        timestamp: Date.now(),
        marketConditions: { balance: 2.0, price: 1.0 },
        analysis: 'hold test',
        action: 'hold',
        confidence: 0.3,
        reasoning: 'holding',
        executed: false,
      };

      const action = await (agent as unknown as { execute(d: AgentDecision): Promise<unknown> }).execute(holdDecision);

      expect(action).toBeNull();
      expect(mockSendRawTransaction).not.toHaveBeenCalled();
    });
  });

  // ── setTargetAddress ───────────────────────────────────────────────────────

  describe('setTargetAddress', () => {
    it('updates the destination address used by estimateTransactionParams', async () => {
      mockGetBalance.mockResolvedValue(2 * LAMPORTS_PER_SOL);
      const { agent } = await buildAgent('dca');

      const newAddress = TEST_PUBLIC_KEY;
      agent.setTargetAddress(newAddress);

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);
      // Force a non-hold action so estimateTransactionParams returns a result.
      decision.action = 'buy';

      const params = (agent as unknown as { estimateTransactionParams(d: AgentDecision): unknown }).estimateTransactionParams(decision);

      expect(params).not.toBeNull();
      expect((params as { destination: string }).destination).toBe(newAddress);
    });
  });

  // ── estimateTransactionParams ──────────────────────────────────────────────

  describe('estimateTransactionParams', () => {
    it('returns correct amountSol, programId, and destination for a buy decision', async () => {
      mockGetBalance.mockResolvedValue(2 * LAMPORTS_PER_SOL);
      const { agent } = await buildAgent('dca');

      const obs = await (agent as unknown as { observe(): Promise<Record<string, unknown>> }).observe();
      const decision = await (agent as unknown as { analyze(o: Record<string, unknown>): Promise<AgentDecision> }).analyze(obs);
      decision.action = 'buy';

      const params = (agent as unknown as { estimateTransactionParams(d: AgentDecision): unknown }).estimateTransactionParams(decision);

      expect(params).not.toBeNull();
      const p = params as { amountSol: number; programId: string; destination: string };
      // balance = 2 SOL → min(0.01, 2 * 0.1) = 0.01
      expect(p.amountSol).toBe(0.01);
      // programId is always the System Program for SOL transfers.
      expect(p.programId).toBe(SYSTEM_PROGRAM);
      // destination is the targetAddress from config.
      expect(p.destination).toBe(SYSTEM_PROGRAM);
    });

    it('returns null for a hold decision', async () => {
      const { agent } = await buildAgent('dca');

      const holdDecision: AgentDecision = {
        id: 'hold-id',
        agentId: 'trading-test-1',
        timestamp: Date.now(),
        marketConditions: { balance: 2.0 },
        analysis: '',
        action: 'hold',
        confidence: 0.3,
        reasoning: '',
        executed: false,
      };

      const params = (agent as unknown as { estimateTransactionParams(d: AgentDecision): unknown }).estimateTransactionParams(holdDecision);

      expect(params).toBeNull();
    });
  });
});
