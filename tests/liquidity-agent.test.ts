import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgenticWallet } from '../src/core/wallet';
import { LiquidityAgent } from '../src/agents/liquidity-agent';
import { AgentConfig, AgentDecision } from '../src/types';

// ── Mock KeystoreManager ────────────────────────────────────────────────────

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

// ── Mock @solana/web3.js Connection ─────────────────────────────────────────

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

function makeConfig(): AgentConfig {
  return {
    id: 'liq-test-1',
    name: 'TestLPAgent',
    type: 'liquidity_provider',
    walletConfig: {
      id: 'lw1',
      label: 'LPWallet',
      password: 'test-pass',
      cluster: 'devnet',
    },
    strategy: {
      name: 'liquidity_provision',
      type: 'liquidity_provision',
      params: { targetAddress: '11111111111111111111111111111111' },
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
      allowedPrograms: ['11111111111111111111111111111111'],
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

function makeObservations(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenABalance: 10,
    tokenBBalance: 10000,
    price: 1.0,
    tvl: 20,
    apy: 8,
    utilization: 65,
    imbalance: 0.05,
    feesEarned: 0,
    walletBalanceSol: 2,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    id: 'dec-1',
    agentId: 'liq-test-1',
    timestamp: Date.now(),
    marketConditions: {},
    analysis: 'test',
    action: 'hold',
    confidence: 0.4,
    reasoning: 'test',
    executed: false,
    ...overrides,
  };
}

async function createAgent(): Promise<{ agent: LiquidityAgent; wallet: AgenticWallet }> {
  const wallet = new AgenticWallet(makeConfig().walletConfig);
  await wallet.initialize();
  const agent = new LiquidityAgent(makeConfig(), wallet);
  return { agent, wallet };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('LiquidityAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Pool Dynamics ──────────────────────────────────────────────────────────

  describe('simulatePoolDynamics', () => {
    it('changes pool values from their initial state', async () => {
      const { agent } = await createAgent();

      // Capture initial pool state before any simulation step.
      const initialPool = agent.getPoolState();

      // Run many iterations to ensure at least one fluctuation changes a value.
      // A single call can theoretically return the same values (rand === 0),
      // so we run 50 iterations and check that not everything stayed identical.
      let changed = false;
      for (let i = 0; i < 50; i++) {
        (agent as any).simulatePoolDynamics();
        const current = agent.getPoolState();
        if (
          current.apy !== initialPool.apy ||
          current.utilization !== initialPool.utilization ||
          current.imbalance !== initialPool.imbalance
        ) {
          changed = true;
          break;
        }
      }

      expect(changed).toBe(true);
    });

    it('keeps pool values within valid ranges after 100 iterations', async () => {
      const { agent } = await createAgent();

      for (let i = 0; i < 100; i++) {
        (agent as any).simulatePoolDynamics();
      }

      const pool = agent.getPoolState();
      expect(pool.apy).toBeGreaterThanOrEqual(0);
      expect(pool.apy).toBeLessThanOrEqual(50);
      expect(pool.utilization).toBeGreaterThanOrEqual(0);
      expect(pool.utilization).toBeLessThanOrEqual(100);
      expect(pool.imbalance).toBeGreaterThanOrEqual(0);
      expect(pool.imbalance).toBeLessThanOrEqual(1);
    });
  });

  // ── Analyze Decisions ──────────────────────────────────────────────────────

  describe('analyze', () => {
    it('returns rebalance with confidence 0.8 when imbalance > 0.15', async () => {
      const { agent } = await createAgent();
      (agent as any).pool.imbalance = 0.20;

      const observations = makeObservations({ imbalance: 0.20 });
      const decision: AgentDecision = await (agent as any).analyze(observations);

      expect(decision.action).toBe('rebalance');
      expect(decision.confidence).toBe(0.8);
      expect(decision.agentId).toBe('liq-test-1');
      expect(decision.executed).toBe(false);
    });

    it('returns add_liquidity with confidence 0.7 when APY > 10 and utilization < 80', async () => {
      const { agent } = await createAgent();
      (agent as any).pool.apy = 12;
      (agent as any).pool.utilization = 60;
      (agent as any).pool.imbalance = 0.05;

      const observations = makeObservations({ apy: 12, utilization: 60, imbalance: 0.05 });
      const decision: AgentDecision = await (agent as any).analyze(observations);

      expect(decision.action).toBe('add_liquidity');
      expect(decision.confidence).toBe(0.7);
    });

    it('returns remove_liquidity with confidence 0.75 when imbalance > 0.10 and APY < 3', async () => {
      const { agent } = await createAgent();
      (agent as any).pool.imbalance = 0.12;
      (agent as any).pool.apy = 2;

      const observations = makeObservations({ imbalance: 0.12, apy: 2, utilization: 65 });
      const decision: AgentDecision = await (agent as any).analyze(observations);

      expect(decision.action).toBe('remove_liquidity');
      expect(decision.confidence).toBe(0.75);
    });

    it('returns hold with confidence 0.4 when all metrics are within normal bounds', async () => {
      const { agent } = await createAgent();
      (agent as any).pool.imbalance = 0.05;
      (agent as any).pool.apy = 8;
      (agent as any).pool.utilization = 65;

      const observations = makeObservations({ imbalance: 0.05, apy: 8, utilization: 65 });
      const decision: AgentDecision = await (agent as any).analyze(observations);

      expect(decision.action).toBe('hold');
      expect(decision.confidence).toBe(0.4);
    });
  });

  // ── Execute ────────────────────────────────────────────────────────────────

  describe('execute', () => {
    it('rebalance: transfers 0.005 SOL and halves imbalance', async () => {
      const { agent } = await createAgent();
      (agent as any).pool.imbalance = 0.20;

      const transferSpy = jest.spyOn((agent as any).wallet, 'transferSOL');

      const decision = makeDecision({ action: 'rebalance', confidence: 0.8 });
      const action = await (agent as any).execute(decision);

      expect(transferSpy).toHaveBeenCalledTimes(1);
      expect(transferSpy).toHaveBeenCalledWith('11111111111111111111111111111111', 0.005);

      const pool = agent.getPoolState();
      expect(pool.imbalance).toBeCloseTo(0.10, 10);

      expect(action).not.toBeNull();
      expect(action!.type).toBe('rebalance');
      expect(action!.details.amountSol).toBe(0.005);
      expect(action!.details.newImbalance).toBeCloseTo(0.10, 10);
    });

    it('add_liquidity: transfers 0.005 SOL and increases tokenABalance by 0.005', async () => {
      const { agent } = await createAgent();
      const initialTokenA = agent.getPoolState().tokenABalance; // 10

      const transferSpy = jest.spyOn((agent as any).wallet, 'transferSOL');

      const decision = makeDecision({ action: 'add_liquidity', confidence: 0.7 });
      const action = await (agent as any).execute(decision);

      expect(transferSpy).toHaveBeenCalledTimes(1);
      expect(transferSpy).toHaveBeenCalledWith('11111111111111111111111111111111', 0.005);

      const pool = agent.getPoolState();
      expect(pool.tokenABalance).toBeCloseTo(initialTokenA + 0.005, 10);

      expect(action).not.toBeNull();
      expect(action!.type).toBe('add_liquidity');
      expect(action!.details.newTokenABalance).toBeCloseTo(initialTokenA + 0.005, 10);
    });

    it('remove_liquidity: reduces reserves by 10% and does not transfer SOL', async () => {
      const { agent } = await createAgent();
      const { tokenABalance: initialA, tokenBBalance: initialB } = agent.getPoolState();

      const transferSpy = jest.spyOn((agent as any).wallet, 'transferSOL');

      const decision = makeDecision({ action: 'remove_liquidity', confidence: 0.75 });
      const action = await (agent as any).execute(decision);

      expect(transferSpy).not.toHaveBeenCalled();

      const pool = agent.getPoolState();
      expect(pool.tokenABalance).toBeCloseTo(initialA * 0.9, 10);
      expect(pool.tokenBBalance).toBeCloseTo(initialB * 0.9, 10);

      expect(action).not.toBeNull();
      expect(action!.type).toBe('remove_liquidity');
      expect(action!.details.simulated).toBe(true);
      expect(action!.details.removedTokenA).toBeCloseTo(initialA * 0.1, 10);
      expect(action!.details.removedTokenB).toBeCloseTo(initialB * 0.1, 10);
    });

    it('hold: returns null without performing any operation', async () => {
      const { agent } = await createAgent();

      const transferSpy = jest.spyOn((agent as any).wallet, 'transferSOL');

      const decision = makeDecision({ action: 'hold', confidence: 0.4 });
      const action = await (agent as any).execute(decision);

      expect(action).toBeNull();
      expect(transferSpy).not.toHaveBeenCalled();
    });
  });

  // ── Accessors ──────────────────────────────────────────────────────────────

  describe('getPoolState', () => {
    it('returns a snapshot with all expected fields and initial values', async () => {
      const { agent } = await createAgent();
      const pool = agent.getPoolState();

      expect(pool).toMatchObject({
        tokenABalance: 10,
        tokenBBalance: 10_000,
        price: 1.0,
        tvl: 20.0,
        apy: 8.0,
        utilization: 65,
        imbalance: 0.05,
        feesEarned: 0,
      });
    });

    it('returns an independent copy so mutations do not affect internal state', async () => {
      const { agent } = await createAgent();
      const snapshot = agent.getPoolState() as any;

      // Mutate the snapshot; the internal pool should not change.
      snapshot.apy = 999;

      expect(agent.getPoolState().apy).toBe(8.0);
    });
  });

  describe('setTargetAddress', () => {
    it('updates the destination used for SOL transfers', async () => {
      const { agent } = await createAgent();
      const newAddress = TEST_PUBLIC_KEY;

      agent.setTargetAddress(newAddress);
      expect((agent as any).targetAddress).toBe(newAddress);
    });

    it('subsequent rebalance transfer goes to the new address', async () => {
      const { agent } = await createAgent();
      const newAddress = TEST_PUBLIC_KEY;

      (agent as any).pool.imbalance = 0.20;
      agent.setTargetAddress(newAddress);

      const transferSpy = jest.spyOn((agent as any).wallet, 'transferSOL');

      const decision = makeDecision({ action: 'rebalance', confidence: 0.8 });
      await (agent as any).execute(decision);

      expect(transferSpy).toHaveBeenCalledWith(newAddress, 0.005);
    });
  });
});
