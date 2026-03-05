import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError } from '@azeth/common';
import { parseEther, parseUnits } from 'viem';
import { createMockMcpServer, TEST_PRIVATE_KEY, TEST_ADDRESS, TEST_USDC_ADDRESS, MOCK_SMART_ACCOUNT } from '../helpers.js';
import { registerTransferTools } from '../../src/tools/transfer.js';

vi.mock('../../src/utils/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/client.js')>();
  return {
    ...actual,
    createClient: vi.fn(),
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

describe('azeth_transfer', () => {
  const server = createMockMcpServer();

  beforeEach(() => {
    vi.clearAllMocks();
    registerTransferTools(server);
  });

  it('registers the azeth_transfer tool', () => {
    expect(server.tools.has('azeth_transfer')).toBe(true);
  });

  it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
    mockedCreateClient.mockRejectedValueOnce(
      new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
    );

    const tool = server.tools.get('azeth_transfer')!;
    const result = await tool.handler({
      chain: 'baseSepolia',
      to: TEST_ADDRESS,
      amount: '1.0',
    });

    const { parsed, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(parsed.error.code).toBe('UNAUTHORIZED');
  });

  it('returns error when recipient name cannot be resolved', async () => {
    // "not-an-address" is treated as a name lookup — fails because server is unreachable in test
    mockedCreateClient.mockResolvedValueOnce({
      address: TEST_ADDRESS as `0x${string}`,
      resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
      getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
      destroy: vi.fn(),
    } as never);

    const tool = server.tools.get('azeth_transfer')!;
    const result = await tool.handler({
      privateKey: TEST_PRIVATE_KEY,
      chain: 'baseSepolia',
      to: 'not-an-address',
      amount: '1.0',
    });

    const { parsed, isError } = parseResult(result);
    expect(isError).toBe(true);
    // Name resolution fails with NETWORK_ERROR (server unreachable), SERVICE_NOT_FOUND, or ACCOUNT_NOT_FOUND
    expect(['NETWORK_ERROR', 'SERVICE_NOT_FOUND', 'ACCOUNT_NOT_FOUND']).toContain(parsed.error.code);
  });

  it('returns error for invalid token address', async () => {
    const tool = server.tools.get('azeth_transfer')!;
    const result = await tool.handler({
      privateKey: TEST_PRIVATE_KEY,
      chain: 'baseSepolia',
      to: TEST_ADDRESS,
      amount: '100',
      token: 'bad-token',
    });

    const { parsed, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(parsed.error.code).toBe('INVALID_INPUT');
    expect(parsed.error.message).toContain('token address');
  });

  it('transfers ETH with parseEther', async () => {
    const mockClient = {
      address: MOCK_SMART_ACCOUNT,
      transfer: vi.fn().mockResolvedValue({
        txHash: '0xethtx',
        from: MOCK_SMART_ACCOUNT,
        to: TEST_ADDRESS,
        token: undefined,
      }),
      destroy: vi.fn(),
    };
    mockedCreateClient.mockResolvedValue(mockClient as never);

    const tool = server.tools.get('azeth_transfer')!;
    const result = await tool.handler({
      privateKey: TEST_PRIVATE_KEY,
      chain: 'baseSepolia',
      to: TEST_ADDRESS,
      amount: '1.5',
    });

    // Verify transfer was called with parseEther amount (18 decimals)
    expect(mockClient.transfer).toHaveBeenCalledWith(
      {
        to: TEST_ADDRESS,
        amount: parseEther('1.5'),
        token: undefined,
      },
      undefined, // fromAccount — defaults to first smart account
    );

    const { parsed } = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.data.txHash).toBe('0xethtx');
    expect(parsed.data.from).toBe(MOCK_SMART_ACCOUNT);
    expect(parsed.data.to).toBe(TEST_ADDRESS);
    expect(parsed.data.amount).toBe('1.5');
    expect(parsed.meta.txHash).toBe('0xethtx');
    expect(mockClient.destroy).toHaveBeenCalled();
  });

  it('transfers ERC-20 token with explicit 6 decimals (USDC)', async () => {
    const mockClient = {
      address: MOCK_SMART_ACCOUNT,
      transfer: vi.fn().mockResolvedValue({
        txHash: '0xerc20tx',
        from: MOCK_SMART_ACCOUNT,
        to: TEST_ADDRESS,
        token: TEST_USDC_ADDRESS,
      }),
      destroy: vi.fn(),
    };
    mockedCreateClient.mockResolvedValue(mockClient as never);

    const tool = server.tools.get('azeth_transfer')!;
    await tool.handler({
      chain: 'base',
      to: TEST_ADDRESS,
      amount: '100',
      token: TEST_USDC_ADDRESS,
      decimals: 6,
    });

    expect(mockClient.transfer).toHaveBeenCalledWith(
      {
        to: TEST_ADDRESS,
        amount: parseUnits('100', 6),
        token: TEST_USDC_ADDRESS,
      },
      undefined,
    );
  });

  it('transfers ERC-20 token with custom decimals', async () => {
    const mockClient = {
      address: MOCK_SMART_ACCOUNT,
      transfer: vi.fn().mockResolvedValue({
        txHash: '0xtx18',
        from: MOCK_SMART_ACCOUNT,
        to: TEST_ADDRESS,
        token: TEST_USDC_ADDRESS,
      }),
      destroy: vi.fn(),
    };
    mockedCreateClient.mockResolvedValue(mockClient as never);

    const tool = server.tools.get('azeth_transfer')!;
    await tool.handler({
      privateKey: TEST_PRIVATE_KEY,
      chain: 'base',
      to: TEST_ADDRESS,
      amount: '0.5',
      token: TEST_USDC_ADDRESS,
      decimals: 18,
    });

    expect(mockClient.transfer).toHaveBeenCalledWith(
      {
        to: TEST_ADDRESS,
        amount: parseUnits('0.5', 18),
        token: TEST_USDC_ADDRESS,
      },
      undefined,
    );
  });

  it('handles BUDGET_EXCEEDED error', async () => {
    mockedCreateClient.mockResolvedValue({
      transfer: vi.fn().mockRejectedValue(
        new AzethError('Daily limit exceeded', 'BUDGET_EXCEEDED'),
      ),
      destroy: vi.fn(),
    } as never);

    const tool = server.tools.get('azeth_transfer')!;
    const result = await tool.handler({
      privateKey: TEST_PRIVATE_KEY,
      chain: 'baseSepolia',
      to: TEST_ADDRESS,
      amount: '999999',
    });

    const { parsed, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(parsed.error.code).toBe('BUDGET_EXCEEDED');
    expect(parsed.error.suggestion).toContain('spending limit');
  });

  it('handles INSUFFICIENT_BALANCE error', async () => {
    mockedCreateClient.mockResolvedValue({
      transfer: vi.fn().mockRejectedValue(
        new AzethError('Insufficient funds', 'INSUFFICIENT_BALANCE', {
          balance: '10 USDC',
        }),
      ),
      destroy: vi.fn(),
    } as never);

    const tool = server.tools.get('azeth_transfer')!;
    const result = await tool.handler({
      privateKey: TEST_PRIVATE_KEY,
      chain: 'baseSepolia',
      to: TEST_ADDRESS,
      amount: '100',
    });

    const { parsed } = parseResult(result);
    expect(parsed.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(parsed.error.suggestion).toContain('10 USDC');
  });
});
