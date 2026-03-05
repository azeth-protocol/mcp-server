import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError } from '@azeth/common';
import { createMockMcpServer, TEST_PRIVATE_KEY, MOCK_SMART_ACCOUNT } from '../helpers.js';
import { registerReputationTools } from '../../src/tools/reputation.js';

vi.mock('../../src/utils/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/client.js')>();
  return {
    ...actual,
    createClient: vi.fn(),
  };
});

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({
      chain: { id: 84532 },
      readContract: vi.fn(),
    }),
    http: vi.fn().mockReturnValue({}),
  };
});

vi.mock('viem/chains', () => ({
  base: { id: 8453 },
  baseSepolia: { id: 84532 },
}));

import { createClient } from '../../src/utils/client.js';
import { createPublicClient } from 'viem';

const mockedCreateClient = vi.mocked(createClient);
const mockPublicClient = (createPublicClient as ReturnType<typeof vi.fn>)();

function parseResult(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    parsed: JSON.parse(r.content[0].text),
    isError: r.isError,
  };
}

describe('reputation tools', () => {
  const server = createMockMcpServer();

  beforeEach(() => {
    vi.clearAllMocks();
    registerReputationTools(server);
  });

  it('registers three reputation tools', () => {
    expect(server.tools.has('azeth_submit_opinion')).toBe(true);
    expect(server.tools.has('azeth_get_weighted_reputation')).toBe(true);
    expect(server.tools.has('azeth_get_net_paid')).toBe(true);
  });

  // ──────────────────────────────────────────────
  // azeth_submit_opinion
  // ──────────────────────────────────────────────

  describe('azeth_submit_opinion', () => {
    it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
      mockedCreateClient.mockRejectedValueOnce(
        new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
      );

      const tool = server.tools.get('azeth_submit_opinion')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        agentId: '1',
        rating: 85,
        tag1: 'quality',
        tag2: '',
        endpoint: '',
        opinionURI: '',
        opinionHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });

    it('submits opinion and returns txHash with rating info', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        submitOpinion: vi.fn().mockResolvedValue('0xopinion123'),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_submit_opinion')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        agentId: '42',
        rating: 85,
        tag1: 'quality',
        tag2: 'x402',
        endpoint: 'https://service.example.com',
        opinionURI: '',
        opinionHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.txHash).toBe('0xopinion123');
      expect(parsed.data.agentId).toBe('42');
      expect(parsed.data.rating).toBe(85);
      expect(parsed.data.ratingScale).toBe('[-100, 100]');
      expect(parsed.data.tag1).toBe('quality');
      expect(parsed.meta.txHash).toBe('0xopinion123');
    });

    it('passes WAD-encoded OnChainOpinion to client', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        submitOpinion: vi.fn().mockResolvedValue('0xabc'),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_submit_opinion')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        agentId: '100',
        rating: 75,
        tag1: 'uptime',
        tag2: 'rpc',
        endpoint: 'https://rpc.example.com',
        opinionURI: 'ipfs://Qm123',
        opinionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      });

      // rating=75 → WAD value = 75 * 1e18 = 75000000000000000000n
      expect(mockClient.submitOpinion).toHaveBeenCalledWith({
        agentId: 100n,
        value: 75000000000000000000n,
        valueDecimals: 18,
        tag1: 'uptime',
        tag2: 'rpc',
        endpoint: 'https://rpc.example.com',
        opinionURI: 'ipfs://Qm123',
        opinionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      });
    });

    it('handles REGISTRY_ERROR from SDK', async () => {
      mockedCreateClient.mockResolvedValue({
        submitOpinion: vi.fn().mockRejectedValue(
          new AzethError('Opinion failed', 'REGISTRY_ERROR'),
        ),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_submit_opinion')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        agentId: '1',
        rating: 50,
        tag1: '',
        tag2: '',
        endpoint: '',
        opinionURI: '',
        opinionHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('REGISTRY_ERROR');
    });

    it('calls destroy on the client', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        submitOpinion: vi.fn().mockResolvedValue('0x1'),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_submit_opinion')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        agentId: '1',
        rating: 50,
        tag1: '',
        tag2: '',
        endpoint: '',
        opinionURI: '',
        opinionHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      });

      expect(mockClient.destroy).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // azeth_get_weighted_reputation
  // ──────────────────────────────────────────────

  describe('azeth_get_weighted_reputation', () => {
    it('returns weighted reputation summary', async () => {
      mockPublicClient.readContract.mockResolvedValue([85n, 1000000n, 5n]);

      const tool = server.tools.get('azeth_get_weighted_reputation')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        agentId: '42',
        raters: [],
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.agentId).toBe('42');
      expect(parsed.data.weightedValue).toBe('85');
      expect(parsed.data.totalWeight).toBe('1000000');
      expect(parsed.data.opinionCount).toBe('5');
    });

    it('uses getWeightedReputation when raters are provided', async () => {
      mockPublicClient.readContract.mockResolvedValue([90n, 500000n, 2n]);

      const tool = server.tools.get('azeth_get_weighted_reputation')!;
      await tool.handler({
        chain: 'baseSepolia',
        agentId: '10',
        raters: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
      });

      expect(mockPublicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'getWeightedReputation',
          args: [10n, ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8']],
        }),
      );
    });

    it('uses getWeightedReputationAll when raters is empty', async () => {
      mockPublicClient.readContract.mockResolvedValue([0n, 0n, 0n]);

      const tool = server.tools.get('azeth_get_weighted_reputation')!;
      await tool.handler({
        chain: 'baseSepolia',
        agentId: '1',
        raters: [],
      });

      expect(mockPublicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'getWeightedReputationAll',
          args: [1n],
        }),
      );
    });

    it('does not require a private key', async () => {
      mockPublicClient.readContract.mockResolvedValue([0n, 0n, 0n]);

      const tool = server.tools.get('azeth_get_weighted_reputation')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        agentId: '1',
        raters: [],
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(mockedCreateClient).not.toHaveBeenCalled();
    });

    it('handles errors from readContract', async () => {
      mockPublicClient.readContract.mockRejectedValue(
        new AzethError('Contract call failed', 'REGISTRY_ERROR'),
      );

      const tool = server.tools.get('azeth_get_weighted_reputation')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        agentId: '999',
        raters: [],
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('REGISTRY_ERROR');
    });
  });

  // ──────────────────────────────────────────────
  // azeth_get_net_paid
  // ──────────────────────────────────────────────

  describe('azeth_get_net_paid', () => {
    it('returns per-token signed delta when token is provided', async () => {
      mockPublicClient.readContract.mockResolvedValue(5000000n);

      const tool = server.tools.get('azeth_get_net_paid')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        token: '0x0000000000000000000000000000000000000000',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.mode).toBe('perToken');
      expect(parsed.data.netPaid).toBe('5000000');
      expect(parsed.data.token).toBe('0x0000000000000000000000000000000000000000');
      expect(mockPublicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'getNetPaid',
          args: [
            '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
            '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
            '0x0000000000000000000000000000000000000000',
          ],
        }),
      );
    });

    it('returns total USD when token is omitted', async () => {
      mockPublicClient.readContract.mockResolvedValue(2500000000000000000n);

      const tool = server.tools.get('azeth_get_net_paid')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.mode).toBe('totalUSD');
      expect(parsed.data.totalNetPaidUSD).toBe('2500000000000000000');
      expect(parsed.data.token).toBeUndefined();
      expect(mockPublicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'getTotalNetPaidUSD',
          args: [
            '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
            '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
          ],
        }),
      );
    });

    it('returns 0 USD when no payments exist', async () => {
      mockPublicClient.readContract.mockResolvedValue(0n);

      const tool = server.tools.get('azeth_get_net_paid')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.mode).toBe('totalUSD');
      expect(parsed.data.totalNetPaidUSD).toBe('0');
    });

    it('does not require a private key', async () => {
      mockPublicClient.readContract.mockResolvedValue(0n);

      const tool = server.tools.get('azeth_get_net_paid')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(mockedCreateClient).not.toHaveBeenCalled();
    });
  });
});
