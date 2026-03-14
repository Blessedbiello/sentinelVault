// SentinelVault — ArbitrageAgent Tests

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgenticWallet } from '../src/core/wallet';
import { ArbitrageAgent } from '../src/agents/arbitrage-agent';
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

(global as any).fetch = jest.fn().mockRejectedValue(new Error('No network in tests'));

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
const ALT_DEX_SPREAD_RANGE = 0.03;

function makeConfig(): AgentConfig {
  return {
    id: 'arb-test-1',
    name: 'TestArbitrageur',
    type: 'arbitrageur',
    walletConfig: {
      id: 'aw1',
      label: 'ArbWallet',
      password: 'test-pass',
      cluster: 'devnet',
    },
    strategy: {
      name: 'arbitrage',
      type: 'dca',
      params: { targetAddress: SYSTEM_PROGRAM },
      riskLevel: 'moderate',
      maxPositionSize: 0.01,
      cooldownMs: 60_000,
    },
    securityPolicy: {
      spendingLimits: { perTransaction: 1, hourly: 5, daily: 20, weekly: 100, monthly: 500 },
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

async function buildAgent(): Promise<{ agent: ArbitrageAgent; wallet: AgenticWallet }> {
  const config = makeConfig();
  const wallet = new AgenticWallet(config.walletConfig);
  await wallet.initialize();
  const agent = new ArbitrageAgent(config, wallet);
  return { agent, wallet };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ArbitrageAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBalance.mockResolvedValue(2 * LAMPORTS_PER_SOL);
  });

  it('observe returns price data with spread', async () => {
    const { agent } = await buildAgent();
    const obs = await (agent as any).observe();
    expect(obs).toHaveProperty('jupiterPrice');
    expect(obs).toHaveProperty('altDexPrice');
    expect(obs).toHaveProperty('spread');
    expect(typeof obs.spread).toBe('number');
    expect(obs.spread).toBeGreaterThanOrEqual(0);
  });

  it('analyze returns "arbitrage" when spread > threshold', async () => {
    const { agent } = await buildAgent();
    const decision = await (agent as any).analyze({
      price: 150,
      priceSource: 'simulated',
      jupiterPrice: 150,
      altDexPrice: 150 * 1.02, // 2% spread > 1% threshold
      spread: 0.02,
      balance: 2.0,
      timestamp: Date.now(),
    });
    expect(decision.action).toBe('arbitrage');
    expect(decision.confidence).toBeGreaterThan(0.5);
  });

  it('analyze returns "hold" when spread < threshold', async () => {
    const { agent } = await buildAgent();
    const decision = await (agent as any).analyze({
      price: 150,
      priceSource: 'simulated',
      jupiterPrice: 150,
      altDexPrice: 150 * 1.005, // 0.5% spread < 1% threshold
      spread: 0.005,
      balance: 2.0,
      timestamp: Date.now(),
    });
    expect(decision.action).toBe('hold');
    expect(decision.confidence).toBe(0.3);
  });

  it('execute transfers SOL and sends memo for arbitrage decision', async () => {
    const { agent } = await buildAgent();
    const decision: AgentDecision = {
      id: 'arb-dec-1',
      agentId: 'arb-test-1',
      timestamp: Date.now(),
      marketConditions: {
        jupiterPrice: 150,
        altDexPrice: 153,
        spread: 0.02,
      },
      analysis: 'test',
      action: 'arbitrage',
      confidence: 0.8,
      reasoning: 'test',
      executed: false,
    };

    const action = await (agent as any).execute(decision);
    expect(action).not.toBeNull();
    expect(action.type).toBe('arbitrage');
    expect(action.details.amountSol).toBe(0.005);
    expect(mockSendRawTransaction).toHaveBeenCalled();
  });

  it('execute returns null for hold decision', async () => {
    const { agent } = await buildAgent();
    const decision: AgentDecision = {
      id: 'arb-hold-1',
      agentId: 'arb-test-1',
      timestamp: Date.now(),
      marketConditions: {},
      analysis: 'test',
      action: 'hold',
      confidence: 0.3,
      reasoning: 'test',
      executed: false,
    };
    const action = await (agent as any).execute(decision);
    expect(action).toBeNull();
  });

  it('confidence scales with spread size', async () => {
    const { agent } = await buildAgent();

    const smallSpread = await (agent as any).analyze({
      price: 150, priceSource: 'simulated',
      jupiterPrice: 150, altDexPrice: 150 * 1.015,
      spread: 0.015, balance: 2.0, timestamp: Date.now(),
    });

    const bigSpread = await (agent as any).analyze({
      price: 150, priceSource: 'simulated',
      jupiterPrice: 150, altDexPrice: 150 * 1.04,
      spread: 0.04, balance: 2.0, timestamp: Date.now(),
    });

    expect(bigSpread.confidence).toBeGreaterThan(smallSpread.confidence);
  });

  it('reasoning chain includes [Spread], [Jupiter], [AltDex]', async () => {
    const { agent } = await buildAgent();
    const decision = await (agent as any).analyze({
      price: 150, priceSource: 'simulated',
      jupiterPrice: 150, altDexPrice: 153,
      spread: 0.02, balance: 2.0, timestamp: Date.now(),
    });

    const chain = decision.marketConditions.reasoningChain as string[];
    expect(chain.some((s: string) => s.includes('[Jupiter]'))).toBe(true);
    expect(chain.some((s: string) => s.includes('[AltDex]'))).toBe(true);
    expect(chain.some((s: string) => s.includes('[Spread]'))).toBe(true);
  });

  it('spread calculation is correct: spread = |jupiterPrice - altDexPrice| / jupiterPrice', async () => {
    const { agent } = await buildAgent();

    // Manually call analyze with known prices and verify spread in reasoningChain
    const jupiterPrice = 200;
    const altDexPrice = 204; // 2% higher
    const expectedSpread = Math.abs(jupiterPrice - altDexPrice) / jupiterPrice; // 0.02

    const decision = await (agent as any).analyze({
      price: jupiterPrice,
      priceSource: 'simulated',
      jupiterPrice,
      altDexPrice,
      spread: expectedSpread,
      balance: 2.0,
      timestamp: Date.now(),
    });

    const chain = decision.marketConditions.reasoningChain as string[];
    // The [Spread] entry should report 2.000%
    const spreadEntry = chain.find((s: string) => s.includes('[Spread]'));
    expect(spreadEntry).toBeDefined();
    expect(spreadEntry).toContain('2.000%');
  });

  it('does NOT execute when spread is below PROFIT_THRESHOLD (0.01)', async () => {
    const { agent } = await buildAgent();

    // 0.5% spread is below the 1% threshold
    const decision = await (agent as any).analyze({
      price: 150,
      priceSource: 'simulated',
      jupiterPrice: 150,
      altDexPrice: 150 * 1.005,
      spread: 0.005,
      balance: 2.0,
      timestamp: Date.now(),
    });

    expect(decision.action).toBe('hold');
    // execute should return null for hold
    const action = await (agent as any).execute(decision);
    expect(action).toBeNull();
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  it('reasoning chain includes spread percentage value', async () => {
    const { agent } = await buildAgent();

    const decision = await (agent as any).analyze({
      price: 150,
      priceSource: 'simulated',
      jupiterPrice: 150,
      altDexPrice: 153,
      spread: 0.02,
      balance: 2.0,
      timestamp: Date.now(),
    });

    const chain = decision.marketConditions.reasoningChain as string[];
    const spreadEntry = chain.find((s: string) => s.includes('[Spread]'));
    expect(spreadEntry).toBeDefined();
    // Should contain the formatted percentage (2.000%)
    expect(spreadEntry).toMatch(/\d+\.\d+%/);
  });

  // ── AMM Pool Integration ─────────────────────────────────────────────────

  it('setPoolMint stores mint and authority', async () => {
    const { agent } = await buildAgent();
    (agent as any).setPoolMint('TestPoolMint', 'TestAuthority');
    expect((agent as any).poolMint).toBe('TestPoolMint');
    expect((agent as any).poolAuthority).toBe('TestAuthority');
  });

  it('execute uses swapSolForToken when pool is configured and oracle > pool price', async () => {
    const { agent, wallet } = await buildAgent();

    const mockSwap = jest.fn().mockResolvedValue('arb-swap-sig');
    (wallet as any).swapSolForToken = mockSwap;
    (agent as any).poolMint = 'TestMint';
    (agent as any).poolPrice = 145;

    const decision = {
      id: 'arb-swap-test',
      agentId: 'arb-test-1',
      timestamp: Date.now(),
      marketConditions: {
        jupiterPrice: 150,
        altDexPrice: 145, // pool price < oracle → buy from pool
        spread: 0.033,
      },
      analysis: 'test',
      action: 'arbitrage',
      confidence: 0.8,
      reasoning: 'test',
      executed: false,
    };

    const action = await (agent as any).execute(decision);
    expect(action).not.toBeNull();
    expect(action.type).toBe('arbitrage:swap_sol_for_token');
    expect(mockSwap).toHaveBeenCalled();
  });

  it('execute falls back to transferSOL when swap fails', async () => {
    const { agent, wallet } = await buildAgent();

    (wallet as any).swapSolForToken = jest.fn().mockRejectedValue(new Error('swap failed'));
    (agent as any).poolMint = 'TestMint';
    (agent as any).poolPrice = 145;

    const decision = {
      id: 'arb-fallback-test',
      agentId: 'arb-test-1',
      timestamp: Date.now(),
      marketConditions: {
        jupiterPrice: 150,
        altDexPrice: 145,
        spread: 0.033,
      },
      analysis: 'test',
      action: 'arbitrage',
      confidence: 0.8,
      reasoning: 'test',
      executed: false,
    };

    const action = await (agent as any).execute(decision);
    expect(action).not.toBeNull();
    expect(action.type).toBe('arbitrage'); // fell back
    expect(mockSendRawTransaction).toHaveBeenCalled();
  });

  it('evaluate queues pending outcome', async () => {
    const { agent } = await buildAgent();
    const decision: AgentDecision = {
      id: 'arb-dec-eval',
      agentId: 'arb-test-1',
      timestamp: Date.now(),
      marketConditions: {},
      analysis: 'test',
      action: 'arbitrage',
      confidence: 0.8,
      reasoning: 'test',
      executed: true,
    };
    const action = {
      id: 'act-1',
      agentId: 'arb-test-1',
      timestamp: Date.now(),
      type: 'arbitrage',
      details: { amountSol: 0.005 },
    };

    await (agent as any).evaluate(action, decision);
    expect((agent as any).pendingOutcomes.length).toBe(1);
  });

  // ── EMA Spread Model ──────────────────────────────────────────────────

  it('altDexPrice uses persistent EMA spread when pool is not configured', async () => {
    const { agent } = await buildAgent();
    const agentAny = agent as any;

    // No pool configured, so alt DEX price uses EMA spread
    expect(agentAny.poolMint).toBeNull();

    // Run multiple observe cycles — spread should persist and drift slowly
    const spreads: number[] = [];
    for (let i = 0; i < 5; i++) {
      await (agent as any).observe();
      const spread = Math.abs(agentAny.altDexPrice - agentAny.currentPrice) / agentAny.currentPrice;
      spreads.push(spread);
    }

    // All spreads should be small (EMA-decayed, not big random jumps)
    for (const s of spreads) {
      expect(s).toBeLessThan(ALT_DEX_SPREAD_RANGE + 0.01);
    }

    // altDexSpread field should exist and be bounded
    expect(Math.abs(agentAny.altDexSpread)).toBeLessThanOrEqual(ALT_DEX_SPREAD_RANGE);
  });

  // ── processPendingOutcomes ────────────────────────────────────────────

  it('processPendingOutcomes evaluates arbitrage by spread convergence', async () => {
    const { agent } = await buildAgent();
    const agentAny = agent as any;

    // Manually add a pending outcome
    agentAny.pendingOutcomes = [{
      decisionId: 'test-arb-po',
      action: 'arbitrage',
      entryPrice: 150,
      confidence: 0.8,
      ticksRemaining: 1,
      decision: {
        id: 'test-arb-po',
        agentId: 'arb-test-1',
        timestamp: Date.now(),
        marketConditions: {},
        analysis: 'test',
        action: 'arbitrage',
        confidence: 0.8,
        reasoning: 'test',
        executed: true,
      },
    }];

    // Price barely moved (< 2%) → should be a "win" for arb
    agentAny.processPendingOutcomes(151); // 0.67% change < 2%
    expect(agentAny.pendingOutcomes.length).toBe(0);
    expect(agent.getWeightHistory().length).toBeGreaterThanOrEqual(1);
  });

  // ── DexScreener Price Source ──────────────────────────────────────────

  it('uses DexScreener price when available', async () => {
    const { agent } = await buildAgent();
    const agentAny = agent as any;

    // Build a minimal DexScreener client mock that returns a valid price
    const mockDexScreenerPrice = {
      price: 175.5,
      source: 'dexscreener:raydium',
      pairAddress: 'MockPairAddr',
      dexId: 'raydium',
      liquidity: 500_000,
    };

    const mockDexClient = {
      getSOLPrice: jest.fn().mockResolvedValue(mockDexScreenerPrice),
      isAvailable: jest.fn().mockReturnValue(true),
      getCachedPrice: jest.fn().mockReturnValue(mockDexScreenerPrice),
      clearCache: jest.fn(),
    };

    agent.setDexScreenerClient(mockDexClient as any);

    // Stub the price feed so the oracle price is predictable
    agentAny.priceFeed.getSOLPrice = jest.fn().mockResolvedValue({ price: 175, source: 'pyth' });

    const obs = await agentAny.observe();

    // altDexPrice should come from DexScreener
    expect(obs.altDexPrice).toBe(175.5);
    expect(obs.altDexSource).toContain('dexscreener');
    expect(mockDexClient.getSOLPrice).toHaveBeenCalledTimes(1);
  });

  it('falls back to AMM pool when DexScreener unavailable', async () => {
    const { agent } = await buildAgent();
    const agentAny = agent as any;

    // DexScreener is set to null (not configured)
    agent.setDexScreenerClient(null as any);

    // Configure an AMM pool
    agentAny.poolMint = 'TestPoolMint';
    agentAny.poolAuthority = 'TestPoolAuth';

    // Stub wallet.getPoolState to return a pool with reserves
    const mockPoolState = { solReserve: 10, tokenReserve: 100, price: 150 };
    agentAny.wallet.getPoolState = jest.fn().mockResolvedValue(mockPoolState);
    agentAny.priceFeed.getSOLPrice = jest.fn().mockResolvedValue({ price: 150, source: 'pyth' });

    const obs = await agentAny.observe();

    // Pool price: (solReserve / tokenReserve) * oraclePrice = (10/100)*150 = 15
    expect(obs.altDexSource).toBe('amm_pool');
    expect(agentAny.wallet.getPoolState).toHaveBeenCalledWith('TestPoolMint');
  });

  it('falls back to EMA when both DexScreener and AMM pool are unavailable', async () => {
    const { agent } = await buildAgent();
    const agentAny = agent as any;

    // No DexScreener, no pool
    agentAny.dexScreenerClient = null;
    agentAny.poolMint = null;

    agentAny.priceFeed.getSOLPrice = jest.fn().mockResolvedValue({ price: 150, source: 'pyth' });

    const obs = await agentAny.observe();

    // Should use EMA simulation
    expect(obs.altDexSource).toBe('simulated_ema');
    // altDexSpread must stay within the bounded range
    expect(Math.abs(agentAny.altDexSpread)).toBeLessThanOrEqual(ALT_DEX_SPREAD_RANGE + 0.01);
  });
});
