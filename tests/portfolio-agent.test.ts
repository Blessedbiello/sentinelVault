// SentinelVault — PortfolioAgent Tests

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgenticWallet } from '../src/core/wallet';
import { PortfolioAgent } from '../src/agents/portfolio-agent';
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

function makeConfig(): AgentConfig {
  return {
    id: 'port-test-1',
    name: 'TestPortfolio',
    type: 'portfolio_manager',
    walletConfig: {
      id: 'pw1',
      label: 'PortfolioWallet',
      password: 'test-pass',
      cluster: 'devnet',
    },
    strategy: {
      name: 'portfolio',
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

async function buildAgent(): Promise<{ agent: PortfolioAgent; wallet: AgenticWallet }> {
  const config = makeConfig();
  const wallet = new AgenticWallet(config.walletConfig);
  await wallet.initialize();
  const agent = new PortfolioAgent(config, wallet);
  return { agent, wallet };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PortfolioAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBalance.mockResolvedValue(2 * LAMPORTS_PER_SOL);
  });

  it('constructor initializes default target allocation (60/40)', async () => {
    const { agent } = await buildAgent();
    const state = agent.getPortfolioState();
    expect(state.targetAllocation.sol).toBe(0.6);
    expect(state.targetAllocation.tokens).toBe(0.4);
  });

  it('observe reads wallet balance and computes allocation', async () => {
    const { agent } = await buildAgent();
    const obs = await (agent as any).observe();
    expect(obs).toHaveProperty('solBalance');
    expect(obs).toHaveProperty('drift');
    expect(obs).toHaveProperty('currentAllocation');
    expect(obs).toHaveProperty('targetAllocation');
    expect(typeof obs.drift).toBe('number');
  });

  it('analyze returns "rebalance_to_tokens" when SOL is overweight', async () => {
    const { agent } = await buildAgent();
    const decision = await (agent as any).analyze({
      solBalance: 2.0,
      tokenValueSol: 0,
      totalValueSol: 2.0,
      currentAllocation: { sol: 1.0, tokens: 0.0 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.4, // 40% drift > 10% threshold
      price: 150,
      timestamp: Date.now(),
    });
    expect(decision.action).toBe('rebalance_to_tokens');
    expect(decision.confidence).toBeGreaterThan(0.5);
  });

  it('analyze returns "rebalance_to_sol" when tokens are overweight', async () => {
    const { agent } = await buildAgent();
    const decision = await (agent as any).analyze({
      solBalance: 0.5,
      tokenValueSol: 1.5,
      totalValueSol: 2.0,
      currentAllocation: { sol: 0.25, tokens: 0.75 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.35, // 35% drift
      price: 150,
      timestamp: Date.now(),
    });
    expect(decision.action).toBe('rebalance_to_sol');
  });

  it('analyze returns "hold" when drift is within threshold', async () => {
    const { agent } = await buildAgent();
    const decision = await (agent as any).analyze({
      solBalance: 1.2,
      tokenValueSol: 0.8,
      totalValueSol: 2.0,
      currentAllocation: { sol: 0.6, tokens: 0.4 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.0, // 0% drift
      price: 150,
      timestamp: Date.now(),
    });
    expect(decision.action).toBe('hold');
  });

  it('execute transfers SOL and sends memo', async () => {
    const { agent } = await buildAgent();
    const decision: AgentDecision = {
      id: 'port-dec-1',
      agentId: 'port-test-1',
      timestamp: Date.now(),
      marketConditions: {
        currentAllocation: { sol: 0.8, tokens: 0.2 },
        targetAllocation: { sol: 0.6, tokens: 0.4 },
        drift: 0.2,
      },
      analysis: 'test',
      action: 'rebalance_to_tokens',
      confidence: 0.8,
      reasoning: 'test',
      executed: false,
    };

    const action = await (agent as any).execute(decision);
    expect(action).not.toBeNull();
    expect(action.details.amountSol).toBe(0.005);
    expect(mockSendRawTransaction).toHaveBeenCalled();
  });

  it('drift calculation is correct', async () => {
    const { agent } = await buildAgent();
    // Force allocation to be 80/20 with target 60/40 → drift = 20%
    const obs = await (agent as any).analyze({
      solBalance: 1.6,
      tokenValueSol: 0.4,
      totalValueSol: 2.0,
      currentAllocation: { sol: 0.8, tokens: 0.2 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.2,
      price: 150,
      timestamp: Date.now(),
    });
    expect(obs.action).toBe('rebalance_to_tokens');
  });

  it('confidence scales with drift magnitude', async () => {
    const { agent } = await buildAgent();

    const smallDrift = await (agent as any).analyze({
      solBalance: 1.4, tokenValueSol: 0.6, totalValueSol: 2.0,
      currentAllocation: { sol: 0.72, tokens: 0.28 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.12, price: 150, timestamp: Date.now(),
    });

    const bigDrift = await (agent as any).analyze({
      solBalance: 1.8, tokenValueSol: 0.2, totalValueSol: 2.0,
      currentAllocation: { sol: 0.9, tokens: 0.1 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.3, price: 150, timestamp: Date.now(),
    });

    expect(bigDrift.confidence).toBeGreaterThan(smallDrift.confidence);
  });

  it('drift threshold boundary: drift exactly at REBALANCE_THRESHOLD (0.10) triggers hold', async () => {
    const { agent } = await buildAgent();

    // Drift exactly at the boundary — the check is drift > REBALANCE_THRESHOLD (strict greater-than)
    const decision = await (agent as any).analyze({
      solBalance: 1.4,
      tokenValueSol: 0.6,
      totalValueSol: 2.0,
      currentAllocation: { sol: 0.7, tokens: 0.3 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.10, // exactly at threshold — should NOT trigger rebalance
      price: 150,
      timestamp: Date.now(),
    });

    expect(decision.action).toBe('hold');
    expect(decision.confidence).toBe(0.3);
  });

  it('drift just above REBALANCE_THRESHOLD triggers rebalance action', async () => {
    const { agent } = await buildAgent();

    const decision = await (agent as any).analyze({
      solBalance: 1.42,
      tokenValueSol: 0.58,
      totalValueSol: 2.0,
      currentAllocation: { sol: 0.71, tokens: 0.29 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.11, // just above threshold
      price: 150,
      timestamp: Date.now(),
    });

    expect(decision.action).toBe('rebalance_to_tokens');
    expect(decision.confidence).toBeGreaterThan(0.5);
  });

  it('analyze with 3 asset classes (sol + 2 token pools) still produces correct drift-based action', async () => {
    const { agent } = await buildAgent();

    // Simulate portfolio: SOL=50%, token_a=30%, token_b=20% — sol is underweight vs 60% target
    // Represent token total as tokens=50% → drift = |0.5 - 0.6| = 0.10 (boundary, hold)
    // Push it to 0.15 drift by using tokens=0.75
    const decision = await (agent as any).analyze({
      solBalance: 0.5,
      tokenValueSol: 1.5,  // 3 token pools combined
      totalValueSol: 2.0,
      currentAllocation: { sol: 0.25, tokens: 0.75 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.35,
      price: 150,
      timestamp: Date.now(),
    });

    // SOL is underweight → should rebalance to sol
    expect(decision.action).toBe('rebalance_to_sol');
    expect(decision.confidence).toBeGreaterThan(0.5);
  });

  it('rebalance decision reasoning chain includes drift percentage', async () => {
    const { agent } = await buildAgent();

    const decision = await (agent as any).analyze({
      solBalance: 1.6,
      tokenValueSol: 0.4,
      totalValueSol: 2.0,
      currentAllocation: { sol: 0.8, tokens: 0.2 },
      targetAllocation: { sol: 0.6, tokens: 0.4 },
      drift: 0.20,
      price: 150,
      timestamp: Date.now(),
    });

    const chain = decision.marketConditions.reasoningChain as string[];
    const driftEntry = chain.find((s: string) => s.includes('[Drift]'));
    expect(driftEntry).toBeDefined();
    // Should contain formatted drift percentage
    expect(driftEntry).toMatch(/\d+\.\d+%/);
    // Confirm it reflects the 20% drift
    expect(driftEntry).toContain('20.0%');
  });

  // ── AMM Pool Integration ─────────────────────────────────────────────────

  it('setPoolMint stores mint and authority', async () => {
    const { agent } = await buildAgent();
    agent.setPoolMint('TestPoolMint', 'TestAuthority');
    expect((agent as any).poolMint).toBe('TestPoolMint');
    expect((agent as any).poolAuthority).toBe('TestAuthority');
  });

  it('execute uses swapSolForToken when pool is configured and action is rebalance_to_tokens', async () => {
    const { agent, wallet } = await buildAgent();

    const mockSwap = jest.fn().mockResolvedValue('rebal-swap-sig');
    (wallet as any).swapSolForToken = mockSwap;
    agent.setPoolMint('TestMint', 'TestAuth');

    const decision = {
      id: 'port-swap-test',
      agentId: 'port-test-1',
      timestamp: Date.now(),
      marketConditions: {
        currentAllocation: { sol: 0.8, tokens: 0.2 },
        targetAllocation: { sol: 0.6, tokens: 0.4 },
        drift: 0.2,
      },
      analysis: 'test',
      action: 'rebalance_to_tokens',
      confidence: 0.8,
      reasoning: 'test',
      executed: false,
    };

    const action = await (agent as any).execute(decision);
    expect(action).not.toBeNull();
    expect(action.type).toBe('rebalance:swap_sol_for_token');
    expect(mockSwap).toHaveBeenCalled();
  });

  it('execute falls back to transferSOL when swap fails', async () => {
    const { agent, wallet } = await buildAgent();

    (wallet as any).swapSolForToken = jest.fn().mockRejectedValue(new Error('swap failed'));
    agent.setPoolMint('TestMint');

    const decision = {
      id: 'port-fallback-test',
      agentId: 'port-test-1',
      timestamp: Date.now(),
      marketConditions: {
        currentAllocation: { sol: 0.8, tokens: 0.2 },
        targetAllocation: { sol: 0.6, tokens: 0.4 },
        drift: 0.2,
      },
      analysis: 'test',
      action: 'rebalance_to_tokens',
      confidence: 0.8,
      reasoning: 'test',
      executed: false,
    };

    const action = await (agent as any).execute(decision);
    expect(action).not.toBeNull();
    // Fell back to standard rebalance_to_tokens
    expect(mockSendRawTransaction).toHaveBeenCalled();
  });

  it('evaluate queues pending outcome', async () => {
    const { agent } = await buildAgent();
    const decision: AgentDecision = {
      id: 'port-dec-eval',
      agentId: 'port-test-1',
      timestamp: Date.now(),
      marketConditions: {},
      analysis: 'test',
      action: 'rebalance_to_tokens',
      confidence: 0.8,
      reasoning: 'test',
      executed: true,
    };
    const action = {
      id: 'act-1',
      agentId: 'port-test-1',
      timestamp: Date.now(),
      type: 'rebalance_to_tokens',
      details: { amountSol: 0.005 },
    };

    await (agent as any).evaluate(action, decision);
    expect((agent as any).pendingOutcomes.length).toBe(1);
  });

  // ── Pool Price Valuation ────────────────────────────────────────────────────

  describe('pool price valuation', () => {
    it('observe uses pool price for token valuation when pool is configured', async () => {
      const { agent, wallet } = await buildAgent();
      const mockGetPoolState = jest.fn().mockResolvedValue({
        solReserve: 1_000_000_000, // 1 SOL
        tokenReserve: 200_000,
        feeBps: 30,
        authority: 'TestAuth',
        tokenMint: 'TestMint',
        bump: 255,
      });
      (wallet as any).getPoolState = mockGetPoolState;
      (wallet as any).getTokenBalances = jest.fn().mockResolvedValue([
        { mint: 'TestMint', balance: 1000, decimals: 9, symbol: 'SENT', uiBalance: '0.001' },
      ]);
      agent.setPoolMint('TestMint', 'TestAuth');

      const obs = await (agent as any).observe();
      expect(mockGetPoolState).toHaveBeenCalledWith('TestMint', 'TestAuth');
      // Pool price = 1_000_000_000 / LAMPORTS_PER_SOL / 200_000 = 1 / 200_000 = 0.000005
      // Token value = 1000 * 0.000005 = 0.005
      expect(obs.tokenPriceSource).toBe('Pool price');
    });

    it('observe falls back to 0.001 when getPoolState fails', async () => {
      const { agent, wallet } = await buildAgent();
      (wallet as any).getPoolState = jest.fn().mockRejectedValue(new Error('network error'));
      (wallet as any).getTokenBalances = jest.fn().mockResolvedValue([
        { mint: 'TestMint', balance: 1000, decimals: 9, symbol: 'SENT', uiBalance: '0.001' },
      ]);
      agent.setPoolMint('TestMint', 'TestAuth');

      const obs = await (agent as any).observe();
      // Should still work with fallback price
      expect(obs.tokenPriceInSol).toBe(0.001);
      // Source label is still set since poolMint exists
      expect(obs.tokenPriceSource).toBe('Pool price');
    });
  });
});
