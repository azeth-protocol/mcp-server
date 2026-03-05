import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError } from '@azeth/common';
import type { RegistryEntry } from '@azeth/common';
import { createMockMcpServer, TEST_PRIVATE_KEY, MOCK_SMART_ACCOUNT } from '../helpers.js';
import { registerRegistryTools } from '../../src/tools/registry.js';

vi.mock('../../src/utils/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/client.js')>();
  return {
    ...actual,
    createClient: vi.fn(),
    resolveChain: vi.fn().mockReturnValue('baseSepolia'),
  };
});

vi.mock('@azeth/sdk', () => ({
  discoverServicesWithFallback: vi.fn(),
}));

// Mock viem to avoid real RPC client creation
vi.mock('viem', () => ({
  createPublicClient: vi.fn().mockReturnValue({}),
  http: vi.fn(),
}));

vi.mock('viem/chains', () => ({
  base: { id: 8453, name: 'Base' },
  baseSepolia: { id: 84532, name: 'Base Sepolia' },
}));

import { createClient } from '../../src/utils/client.js';
import { discoverServicesWithFallback } from '@azeth/sdk';

const mockedCreateClient = vi.mocked(createClient);
const mockedDiscoverWithFallback = vi.mocked(discoverServicesWithFallback);

function parseResult(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    parsed: JSON.parse(r.content[0].text),
    isError: r.isError,
  };
}

describe('registry tools', () => {
  const server = createMockMcpServer();

  beforeEach(() => {
    vi.clearAllMocks();
    registerRegistryTools(server);
  });

  it('registers two registry tools', () => {
    expect(server.tools.has('azeth_publish_service')).toBe(true);
    expect(server.tools.has('azeth_discover_services')).toBe(true);
  });

  // ──────────────────────────────────────────────
  // azeth_publish_service
  // ──────────────────────────────────────────────

  describe('azeth_publish_service', () => {
    it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
      mockedCreateClient.mockRejectedValueOnce(
        new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
      );

      const tool = server.tools.get('azeth_publish_service')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        name: 'MyService',
        description: 'A service',
        entityType: 'service',
        capabilities: ['swap'],
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });

    it('publishes service and returns tokenId + txHash', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publishService: vi.fn().mockResolvedValue({
          tokenId: 99n,
          txHash: '0xpub789',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_publish_service')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        name: 'PriceFeed',
        description: 'Real-time prices',
        entityType: 'service',
        capabilities: ['price-feed', 'oracle'],
        endpoint: 'https://prices.example.com',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.tokenId).toBe('99');
      expect(parsed.data.txHash).toBe('0xpub789');
      expect(parsed.meta.txHash).toBe('0xpub789');
    });

    it('passes correct params to publishService', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publishService: vi.fn().mockResolvedValue({
          tokenId: 1n,
          txHash: '0x1',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_publish_service')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'base',
        name: 'Bridge',
        description: 'Cross-chain bridge',
        entityType: 'infrastructure',
        capabilities: ['bridge', 'cross-chain'],
      });

      expect(mockClient.publishService).toHaveBeenCalledWith({
        name: 'Bridge',
        description: 'Cross-chain bridge',
        entityType: 'infrastructure',
        capabilities: ['bridge', 'cross-chain'],
        endpoint: undefined,
      });
    });

    it('handles REGISTRY_ERROR from SDK', async () => {
      mockedCreateClient.mockResolvedValue({
        publishService: vi.fn().mockRejectedValue(
          new AzethError('Registry unavailable', 'REGISTRY_ERROR'),
        ),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_publish_service')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        name: 'Test',
        description: 'Test',
        entityType: 'agent',
        capabilities: ['test'],
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('REGISTRY_ERROR');
      expect(parsed.error.suggestion).toContain('registry');
    });

    it('calls destroy on the client', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publishService: vi.fn().mockResolvedValue({
          tokenId: 1n,
          txHash: '0x1',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_publish_service')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        name: 'Test',
        description: 'Test',
        entityType: 'agent',
        capabilities: ['test'],
      });

      expect(mockClient.destroy).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // azeth_discover_services
  // ──────────────────────────────────────────────

  describe('azeth_discover_services', () => {
    const mockEntries: RegistryEntry[] = [
      {
        tokenId: 1n,
        owner: '0xowner1' as `0x${string}`,
        entityType: 'service',
        name: 'PriceFeed',
        description: 'Prices',
        capabilities: ['price-feed'],
        endpoint: 'https://feed.example.com',
        active: true,
      },
      {
        tokenId: 2n,
        owner: '0xowner2' as `0x${string}`,
        entityType: 'agent',
        name: 'SwapBot',
        description: 'Swaps',
        capabilities: ['swap'],
        endpoint: '',
        active: true,
      },
    ];

    it('returns discovered services from the SDK', async () => {
      mockedDiscoverWithFallback.mockResolvedValue({
        entries: mockEntries,
        source: 'server',
      });

      const tool = server.tools.get('azeth_discover_services')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        capability: 'price-feed',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.source).toBe('server');
      expect(parsed.data.services).toHaveLength(2);
      expect(parsed.data.services[0].name).toBe('PriceFeed');
      expect(parsed.data.services[1].name).toBe('SwapBot');
    });

    it('passes correct params to discoverServicesWithFallback', async () => {
      mockedDiscoverWithFallback.mockResolvedValue({
        entries: [],
        source: 'server',
      });

      const tool = server.tools.get('azeth_discover_services')!;
      await tool.handler({
        chain: 'baseSepolia',
        capability: 'swap',
        entityType: 'service',
        minReputation: 50,
        limit: 25,
      });

      expect(mockedDiscoverWithFallback).toHaveBeenCalledWith(
        expect.any(String), // serverUrl
        expect.objectContaining({
          capability: 'swap',
          entityType: 'service',
          minReputation: 50,
          limit: 25,
        }),
        expect.anything(), // publicClient
        'baseSepolia',
      );
    });

    it('uses default limit of 10 when not specified', async () => {
      mockedDiscoverWithFallback.mockResolvedValue({
        entries: [],
        source: 'server',
      });

      const tool = server.tools.get('azeth_discover_services')!;
      await tool.handler({
        chain: 'baseSepolia',
      });

      expect(mockedDiscoverWithFallback).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          limit: 10,
        }),
        expect.anything(),
        'baseSepolia',
      );
    });

    it('uses AZETH_SERVER_URL env var', async () => {
      const envBefore = process.env.AZETH_SERVER_URL;
      process.env.AZETH_SERVER_URL = 'https://env-server.example.com';

      mockedDiscoverWithFallback.mockResolvedValue({
        entries: [],
        source: 'server',
      });

      const tool = server.tools.get('azeth_discover_services')!;
      await tool.handler({
        chain: 'baseSepolia',
      });

      expect(mockedDiscoverWithFallback).toHaveBeenCalledWith(
        'https://env-server.example.com',
        expect.anything(),
        expect.anything(),
        'baseSepolia',
      );

      // Restore
      if (envBefore === undefined) {
        delete process.env.AZETH_SERVER_URL;
      } else {
        process.env.AZETH_SERVER_URL = envBefore;
      }
    });

    it('falls back to https://api.azeth.ai when no server URL', async () => {
      const envBefore = process.env.AZETH_SERVER_URL;
      delete process.env.AZETH_SERVER_URL;

      mockedDiscoverWithFallback.mockResolvedValue({
        entries: [],
        source: 'server',
      });

      const tool = server.tools.get('azeth_discover_services')!;
      await tool.handler({
        chain: 'baseSepolia',
      });

      expect(mockedDiscoverWithFallback).toHaveBeenCalledWith(
        'https://api.azeth.ai',
        expect.anything(),
        expect.anything(),
        'baseSepolia',
      );

      // Restore
      if (envBefore !== undefined) {
        process.env.AZETH_SERVER_URL = envBefore;
      }
    });

    it('returns error when SDK throws REGISTRY_ERROR', async () => {
      mockedDiscoverWithFallback.mockRejectedValue(
        new AzethError('Discovery API error: 500', 'REGISTRY_ERROR'),
      );

      const tool = server.tools.get('azeth_discover_services')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('REGISTRY_ERROR');
    });

    it('handles SERVER_UNAVAILABLE when SDK cannot reach server or on-chain', async () => {
      mockedDiscoverWithFallback.mockRejectedValue(
        new AzethError('fetch failed', 'SERVER_UNAVAILABLE'),
      );

      const tool = server.tools.get('azeth_discover_services')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('SERVER_UNAVAILABLE');
      expect(parsed.error.suggestion).toContain('Azeth server');
    });

    it('handles non-AzethError exceptions via handleError', async () => {
      mockedDiscoverWithFallback.mockRejectedValue(
        new Error('Unexpected internal error'),
      );

      const tool = server.tools.get('azeth_discover_services')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNKNOWN_ERROR');
    });

    it('does not require a private key (createClient not called)', async () => {
      mockedDiscoverWithFallback.mockResolvedValue({
        entries: [],
        source: 'server',
      });

      const tool = server.tools.get('azeth_discover_services')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      // createClient should NOT have been called — discovery is read-only
      expect(mockedCreateClient).not.toHaveBeenCalled();
    });

    it('includes source in response when falling back to on-chain', async () => {
      mockedDiscoverWithFallback.mockResolvedValue({
        entries: mockEntries.slice(0, 1),
        source: 'on-chain',
      });

      const tool = server.tools.get('azeth_discover_services')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.source).toBe('on-chain');
      expect(parsed.data.count).toBe(1);
    });

    it('serializes tokenId as string in response', async () => {
      mockedDiscoverWithFallback.mockResolvedValue({
        entries: [{ ...mockEntries[0]!, tokenId: 42n }],
        source: 'server',
      });

      const tool = server.tools.get('azeth_discover_services')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed } = parseResult(result);
      expect(parsed.data.services[0].tokenId).toBe('42');
    });
  });
});
