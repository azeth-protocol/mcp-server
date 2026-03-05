import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError } from '@azeth/common';
import { createMockMcpServer, TEST_PRIVATE_KEY, MOCK_SMART_ACCOUNT } from '../helpers.js';
import { registerAccountTools } from '../../src/tools/account.js';

// Mock the client utility so we never hit real chains
vi.mock('../../src/utils/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/client.js')>();
  return {
    ...actual,
    createClient: vi.fn(),
    validateAddress: actual.validateAddress,
  };
});

import { createClient } from '../../src/utils/client.js';

const mockedCreateClient = vi.mocked(createClient);

function parseResult(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    parsed: JSON.parse(r.content[0].text),
    isError: r.isError,
  };
}

describe('account tools', () => {
  const server = createMockMcpServer();

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-register (safe — Map overwrites duplicates)
    registerAccountTools(server);
  });

  it('registers four account tools', () => {
    expect(server.tools.has('azeth_create_account')).toBe(true);
    expect(server.tools.has('azeth_balance')).toBe(true);
    expect(server.tools.has('azeth_history')).toBe(true);
    expect(server.tools.has('azeth_deposit')).toBe(true);
  });

  // ──────────────────────────────────────────────
  // azeth_create_account
  // ──────────────────────────────────────────────

  describe('azeth_create_account', () => {
    it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
      mockedCreateClient.mockRejectedValueOnce(
        new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
      );

      const tool = server.tools.get('azeth_create_account')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        name: 'TestAgent',
        entityType: 'agent',
        description: 'A test agent',
        capabilities: ['test'],
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });

    it('returns success with account address and tokenId', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        createAccount: vi.fn().mockResolvedValue({
          account: '0xDeployedAccount1234567890123456789012345678',
          tokenId: 42n,
          txHash: '0xtxhash123',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_create_account')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        name: 'TestAgent',
        entityType: 'agent',
        description: 'A test agent',
        capabilities: ['swap'],
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.account).toBe('0xDeployedAccount1234567890123456789012345678');
      expect(parsed.data.tokenId).toBe('42');
      expect(parsed.data.txHash).toBe('0xtxhash123');
      expect(parsed.meta.txHash).toBe('0xtxhash123');
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('passes correct arguments to createAccount', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        createAccount: vi.fn().mockResolvedValue({
          account: '0xDeployedAccount1234567890123456789012345678',
          tokenId: 1n,
          txHash: '0xabc',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_create_account')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'base',
        name: 'MyService',
        entityType: 'service',
        description: 'Price feed',
        capabilities: ['price-feed', 'oracle'],
        endpoint: 'https://api.example.com',
      });

      expect(mockClient.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: MOCK_SMART_ACCOUNT,
          registry: {
            name: 'MyService',
            description: 'Price feed',
            entityType: 'service',
            capabilities: ['price-feed', 'oracle'],
            endpoint: 'https://api.example.com',
          },
        }),
      );
    });

    it('handles AzethError from SDK', async () => {
      mockedCreateClient.mockRejectedValue(
        new AzethError('Network unreachable', 'NETWORK_ERROR'),
      );

      const tool = server.tools.get('azeth_create_account')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        name: 'Test',
        entityType: 'agent',
        description: 'Test',
        capabilities: ['test'],
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('NETWORK_ERROR');
      expect(parsed.error.suggestion).toContain('network request failed');
    });

    it('handles unexpected errors from SDK', async () => {
      mockedCreateClient.mockRejectedValue(new Error('Unexpected failure'));

      const tool = server.tools.get('azeth_create_account')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        name: 'Test',
        entityType: 'agent',
        description: 'Test',
        capabilities: ['test'],
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNKNOWN_ERROR');
      expect(parsed.error.message).toBe('Unexpected failure');
    });
  });

  // ──────────────────────────────────────────────
  // azeth_balance
  // ──────────────────────────────────────────────

  describe('azeth_balance', () => {
    it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
      mockedCreateClient.mockRejectedValueOnce(
        new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
      );

      const tool = server.tools.get('azeth_balance')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });

    it('returns multi-account USD breakdown', async () => {
      const mockClient = {
        address: '0xEOA0000000000000000000000000000000000000',
        smartAccount: MOCK_SMART_ACCOUNT,
        getAllBalances: vi.fn().mockResolvedValue({
          accounts: [
            {
              account: '0xEOA0000000000000000000000000000000000000',
              label: 'EOA',
              balances: [
                { token: '0x0000000000000000000000000000000000000000', symbol: 'ETH', balance: 50000000000000000n, balanceFormatted: '0.05', usdValue: 123450000000000000000n, usdFormatted: '$123.45' },
              ],
              totalUSD: 123450000000000000000n,
              totalUSDFormatted: '$123.45',
            },
            {
              account: MOCK_SMART_ACCOUNT,
              label: 'Smart Account #1',
              balances: [
                { token: '0x0000000000000000000000000000000000000000', symbol: 'ETH', balance: 1500000000000000000n, balanceFormatted: '1.5', usdValue: 3600000000000000000000n, usdFormatted: '$3600.00' },
                { token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', symbol: 'USDC', balance: 1000000000n, balanceFormatted: '1000.0', usdValue: 1000000000000000000000n, usdFormatted: '$1000.00' },
              ],
              totalUSD: 4600000000000000000000n,
              totalUSDFormatted: '$4600.00',
            },
          ],
          grandTotalUSD: 4723450000000000000000n,
          grandTotalUSDFormatted: '$4723.45',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_balance')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.owner).toBe('0xEOA0000000000000000000000000000000000000');
      expect(parsed.data.grandTotalUSD).toBe('$4723.45');
      expect(parsed.data.accounts).toHaveLength(2);
      expect(parsed.data.accounts[0].label).toBe('EOA');
      expect(parsed.data.accounts[0].balances[0].token).toBe('ETH');
      expect(parsed.data.accounts[1].label).toBe('Smart Account #1');
      expect(parsed.data.accounts[1].totalUSD).toBe('$4600.00');
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('returns empty accounts when no smart accounts exist', async () => {
      const mockClient = {
        address: '0xEOA0000000000000000000000000000000000000',
        smartAccount: null,
        getAllBalances: vi.fn().mockResolvedValue({
          accounts: [
            {
              account: '0xEOA0000000000000000000000000000000000000',
              label: 'EOA',
              balances: [
                { token: '0x0000000000000000000000000000000000000000', symbol: 'ETH', balance: 50000000000000000n, balanceFormatted: '0.05', usdValue: 0n, usdFormatted: '$0.00' },
              ],
              totalUSD: 0n,
              totalUSDFormatted: '$0.00',
            },
          ],
          grandTotalUSD: 0n,
          grandTotalUSDFormatted: '$0.00',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_balance')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'base',
      });

      const { parsed } = parseResult(result);
      expect(parsed.data.accounts).toHaveLength(1);
      expect(parsed.data.accounts[0].label).toBe('EOA');
    });
  });

  // ──────────────────────────────────────────────
  // azeth_history
  // ──────────────────────────────────────────────

  describe('azeth_history', () => {
    it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
      mockedCreateClient.mockRejectedValueOnce(
        new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
      );

      const tool = server.tools.get('azeth_history')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });

    it('returns transaction history with default limit', async () => {
      const mockTx = {
        hash: '0xtx1',
        from: '0xfrom',
        to: '0xto',
        value: 1000000n,
        blockNumber: 12345n,
        timestamp: '2026-02-17T10:00:00Z',
      };
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        smartAccount: MOCK_SMART_ACCOUNT,
        getHistory: vi.fn().mockResolvedValue([mockTx]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_history')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.smartAccount).toBe(MOCK_SMART_ACCOUNT);
      expect(parsed.data.transactions).toHaveLength(1);
      expect(parsed.data.transactions[0].hash).toBe('0xtx1');
      expect(parsed.data.transactions[0].value).toBe('1000000');
      expect(parsed.data.transactions[0].blockNumber).toBe('12345');
      // Default limit = 10
      expect(mockClient.getHistory).toHaveBeenCalledWith({ limit: 10 }, undefined);
    });

    it('passes custom limit to getHistory', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        smartAccount: MOCK_SMART_ACCOUNT,
        getHistory: vi.fn().mockResolvedValue([]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_history')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        limit: 25,
      });

      expect(mockClient.getHistory).toHaveBeenCalledWith({ limit: 25 }, undefined);
    });

    it('handles empty history', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        smartAccount: MOCK_SMART_ACCOUNT,
        getHistory: vi.fn().mockResolvedValue([]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_history')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
      });

      const { parsed } = parseResult(result);
      expect(parsed.data.transactions).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────
  // azeth_deposit
  // ──────────────────────────────────────────────

  describe('azeth_deposit', () => {
    it('returns success with deposit details', async () => {
      const mockClient = {
        address: '0xEOA0000000000000000000000000000000000000',
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        deposit: vi.fn().mockResolvedValue({
          txHash: '0xdeposithash',
          from: '0xEOA0000000000000000000000000000000000000',
          to: MOCK_SMART_ACCOUNT,
          amount: 10000000000000000n,
          token: 'ETH',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_deposit')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        amount: '0.01',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.txHash).toBe('0xdeposithash');
      expect(parsed.data.to).toBe(MOCK_SMART_ACCOUNT);
      expect(parsed.data.amount).toBe('0.01');
      expect(parsed.data.token).toBe('ETH');
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('returns error for invalid token address', async () => {
      const tool = server.tools.get('azeth_deposit')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        amount: '100',
        token: 'not-an-address',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
    });

    it('returns error when token provided without decimals', async () => {
      const tool = server.tools.get('azeth_deposit')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        amount: '100',
        token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('decimals');
    });

    it('handles unauthorized deposit error', async () => {
      const mockClient = {
        address: '0xEOA0000000000000000000000000000000000000',
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        deposit: vi.fn().mockRejectedValue(
          new AzethError('Cannot deposit to a smart account you do not own', 'UNAUTHORIZED'),
        ),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_deposit')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        amount: '0.01',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });
  });
});
