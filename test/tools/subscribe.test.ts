import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError } from '@azeth/common';
import { createMockMcpServer, TEST_PRIVATE_KEY } from '../helpers.js';
import { registerPaymentTools } from '../../src/tools/payments.js';

vi.mock('../../src/utils/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/client.js')>();
  return {
    ...actual,
    createClient: vi.fn(),
  };
});

// Mock DNS resolution to return a public IP so SSRF validation passes in tests
vi.mock('node:dns/promises', () => ({
  default: {
    resolve4: vi.fn().mockResolvedValue(['93.184.216.34']),
    resolve6: vi.fn().mockResolvedValue(['2606:2800:220:1:248:1893:25c8:1946']),
  },
}));

import { createClient } from '../../src/utils/client.js';

const mockedCreateClient = vi.mocked(createClient);

function parseResult(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    parsed: JSON.parse(r.content[0].text),
    isError: r.isError,
  };
}

/** Build a 402 response body with payment-agreement extension */
function make402ResponseHeaders(terms?: {
  payee?: string;
  token?: string;
  moduleAddress?: string;
  minAmountPerInterval?: string;
  suggestedInterval?: number;
}) {
  const requirement = {
    accepts: [{
      scheme: 'exact',
      network: 'base-sepolia',
      amount: '5000',
      payTo: terms?.payee ?? '0x2222222222222222222222222222222222222222',
      asset: terms?.token ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    }],
    extensions: {
      'payment-agreement': {
        acceptsAgreements: true,
        terms: {
          payee: terms?.payee ?? '0x2222222222222222222222222222222222222222',
          token: terms?.token ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          moduleAddress: terms?.moduleAddress ?? '0x9999999999999999999999999999999999999999',
          minAmountPerInterval: terms?.minAmountPerInterval ?? '5000',
          suggestedInterval: terms?.suggestedInterval ?? 86400,
        },
      },
    },
  };

  return { 'PAYMENT-REQUIRED': btoa(JSON.stringify(requirement)) };
}

/** Build a 402 response without the payment-agreement extension */
function make402NoAgreement() {
  const requirement = {
    accepts: [{
      scheme: 'exact',
      network: 'base-sepolia',
      amount: '5000',
      payTo: '0x2222222222222222222222222222222222222222',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    }],
  };
  return { 'PAYMENT-REQUIRED': btoa(JSON.stringify(requirement)) };
}

describe('azeth_subscribe_service', () => {
  const server = createMockMcpServer();

  beforeEach(() => {
    vi.clearAllMocks();
    registerPaymentTools(server);
  });

  it('registers the subscribe_service tool', () => {
    expect(server.tools.has('azeth_subscribe_service')).toBe(true);
  });

  it('parses agreement terms from 402 response and creates agreement', async () => {
    const mockClient = {
      createPaymentAgreement: vi.fn().mockResolvedValue({
        agreementId: 1n,
        txHash: '0xabc123' + '0'.repeat(58),
      }),
      destroy: vi.fn(),
    };
    mockedCreateClient.mockResolvedValueOnce(mockClient as any);

    // Mock fetch: return 402 with payment-agreement extension
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 402,
      headers: new Headers(make402ResponseHeaders()),
    }) as any;

    try {
      const tool = server.tools.get('azeth_subscribe_service')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        url: 'https://api.example.com/data',
        maxExecutions: 30,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeFalsy();
      expect(parsed.data.agreementId).toBe('1');
      expect(parsed.data.subscription.payee).toBe('0x2222222222222222222222222222222222222222');
      expect(parsed.data.subscription.intervalSeconds).toBe(86400);
      expect(parsed.data.subscription.maxExecutions).toBe(30);

      expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith({
        payee: '0x2222222222222222222222222222222222222222',
        token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        amount: 5000n,
        interval: 86400,
        maxExecutions: 30,
        totalCap: undefined,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects non-402 response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
    }) as any;

    try {
      const tool = server.tools.get('azeth_subscribe_service')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        url: 'https://api.example.com/data',
        maxExecutions: 30,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('did not return 402');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects 402 without payment-agreement extension', async () => {
    const mockClient = { destroy: vi.fn() };
    mockedCreateClient.mockResolvedValueOnce(mockClient as any);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 402,
      headers: new Headers(make402NoAgreement()),
    }) as any;

    try {
      const tool = server.tools.get('azeth_subscribe_service')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        url: 'https://api.example.com/data',
        maxExecutions: 10,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('does not advertise payment-agreement');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('validates cap requirement — rejects when neither maxExecutions nor totalCap provided', async () => {
    const tool = server.tools.get('azeth_subscribe_service')!;
    const result = await tool.handler({
      chain: 'baseSepolia',
      url: 'https://api.example.com/data',
      // No maxExecutions, no totalCap
    });

    const { parsed, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(parsed.error.code).toBe('INVALID_INPUT');
    expect(parsed.error.message).toContain('At least one limit is required');
  });

  it('accepts maxExecutions=0 as "no cap" — still triggers cap validation', async () => {
    const tool = server.tools.get('azeth_subscribe_service')!;
    const result = await tool.handler({
      chain: 'baseSepolia',
      url: 'https://api.example.com/data',
      maxExecutions: 0,
      // No totalCap either — both are falsy
    });

    const { parsed, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(parsed.error.code).toBe('INVALID_INPUT');
    expect(parsed.error.message).toContain('At least one limit is required');
  });

  it('respects user interval override', async () => {
    const mockClient = {
      createPaymentAgreement: vi.fn().mockResolvedValue({
        agreementId: 2n,
        txHash: '0xdef456' + '0'.repeat(58),
      }),
      destroy: vi.fn(),
    };
    mockedCreateClient.mockResolvedValueOnce(mockClient as any);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 402,
      headers: new Headers(make402ResponseHeaders({ suggestedInterval: 86400 })),
    }) as any;

    try {
      const tool = server.tools.get('azeth_subscribe_service')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        url: 'https://api.example.com/data',
        intervalSeconds: 604800, // Weekly instead of daily
        maxExecutions: 4,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeFalsy();
      expect(parsed.data.subscription.intervalSeconds).toBe(604800);

      // Verify the SDK was called with the user's override, not the suggested interval
      expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith(
        expect.objectContaining({ interval: 604800 }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects interval below 60 seconds', async () => {
    const tool = server.tools.get('azeth_subscribe_service')!;
    const result = await tool.handler({
      chain: 'baseSepolia',
      url: 'https://api.example.com/data',
      intervalSeconds: 30,
      maxExecutions: 100,
    });

    const { parsed, isError } = parseResult(result);
    expect(isError).toBe(true);
    expect(parsed.error.code).toBe('INVALID_INPUT');
    expect(parsed.error.message).toContain('at least 60');
  });

  it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
    mockedCreateClient.mockRejectedValueOnce(
      new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 402,
      headers: new Headers(make402ResponseHeaders()),
    }) as any;

    try {
      const tool = server.tools.get('azeth_subscribe_service')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        url: 'https://api.example.com/data',
        maxExecutions: 10,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
