// SentinelVault — AIAdvisor Test Suite
// Tests LLM integration with mocked global.fetch, provider detection,
// graceful fallback, and response parsing.

import { AIAdvisor } from '../src/integrations/ai-advisor';

// ── Mock global.fetch ────────────────────────────────────────────────────────

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// ── Helpers ──────────────────────────────────────────────────────────────────

const testContext = {
  solPrice: 172.45,
  priceSource: 'jupiter',
  priceHistory: [170, 171, 172, 172.5, 172.45],
  balance: 2.0,
  strategy: 'momentum',
  quantitativeSignal: { action: 'buy', confidence: 0.72 },
};

function anthropicResponse(text: string) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text }],
    }),
  };
}

function openaiResponse(text: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: text } }],
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AIAdvisor', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    mockFetch.mockReset();
  });

  describe('availability', () => {
    it('isAvailable returns false when no API key is set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const advisor = new AIAdvisor();

      expect(advisor.isAvailable()).toBe(false);
      expect(advisor.getProvider()).toBeNull();
    });

    it('isAvailable returns true with ANTHROPIC_API_KEY', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      expect(advisor.isAvailable()).toBe(true);
      expect(advisor.getProvider()).toBe('anthropic');
    });

    it('isAvailable returns true with OPENAI_API_KEY', () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      expect(advisor.isAvailable()).toBe(true);
      expect(advisor.getProvider()).toBe('openai');
    });

    it('prefers Anthropic when both keys are set', () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.OPENAI_API_KEY = 'openai-key';
      const advisor = new AIAdvisor();

      expect(advisor.getProvider()).toBe('anthropic');
    });
  });

  describe('getTradeRecommendation', () => {
    it('returns null when no API key is set', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const advisor = new AIAdvisor();

      const result = await advisor.getTradeRecommendation(testContext);

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('parses Anthropic response correctly', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      mockFetch.mockResolvedValueOnce(
        anthropicResponse('{"action": "buy", "confidence": 0.85, "reasoning": "Strong uptrend"}'),
      );

      const result = await advisor.getTradeRecommendation(testContext);

      expect(result).not.toBeNull();
      expect(result!.action).toBe('buy');
      expect(result!.confidence).toBe(0.85);
      expect(result!.reasoning).toBe('Strong uptrend');
    });

    it('parses OpenAI response correctly', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      mockFetch.mockResolvedValueOnce(
        openaiResponse('{"action": "sell", "confidence": 0.65, "reasoning": "Bearish divergence"}'),
      );

      const result = await advisor.getTradeRecommendation(testContext);

      expect(result).not.toBeNull();
      expect(result!.action).toBe('sell');
      expect(result!.confidence).toBe(0.65);
    });

    it('handles markdown code blocks in response', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      mockFetch.mockResolvedValueOnce(
        anthropicResponse('```json\n{"action": "hold", "confidence": 0.5, "reasoning": "Neutral"}\n```'),
      );

      const result = await advisor.getTradeRecommendation(testContext);

      expect(result).not.toBeNull();
      expect(result!.action).toBe('hold');
    });

    it('returns null on API failure', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });

      const result = await advisor.getTradeRecommendation(testContext);

      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      mockFetch.mockRejectedValueOnce(new Error('Connection timeout'));

      const result = await advisor.getTradeRecommendation(testContext);

      expect(result).toBeNull();
    });

    it('returns null on invalid JSON response', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      mockFetch.mockResolvedValueOnce(
        anthropicResponse('I think you should buy but I cannot format JSON'),
      );

      const result = await advisor.getTradeRecommendation(testContext);

      expect(result).toBeNull();
    });

    it('rejects invalid action values', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      mockFetch.mockResolvedValueOnce(
        anthropicResponse('{"action": "yolo", "confidence": 0.9, "reasoning": "test"}'),
      );

      const result = await advisor.getTradeRecommendation(testContext);

      expect(result).toBeNull();
    });

    it('rejects out-of-range confidence', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const advisor = new AIAdvisor();

      mockFetch.mockResolvedValueOnce(
        anthropicResponse('{"action": "buy", "confidence": 1.5, "reasoning": "test"}'),
      );

      const result = await advisor.getTradeRecommendation(testContext);

      expect(result).toBeNull();
    });
  });
});
