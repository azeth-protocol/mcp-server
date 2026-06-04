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

// Mock DNS resolution to return a public IP so SSRF validation passes in tests.
// The guard resolves via dns.lookup (getaddrinfo), so the mock returns LookupAddress[].
vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]),
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
      // A1: human-readable amount alongside the raw 6-decimal integer
      expect(parsed.data.subscription.amountPerIntervalFormatted).toBe('0.005 USDC');

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

  it('defaults totalCap to ~1 year when neither cap is provided (url-only) (OBS-4)', async () => {
    const mockClient = {
      createPaymentAgreement: vi.fn().mockResolvedValue({
        agreementId: 7n,
        txHash: '0xfeed' + '0'.repeat(60),
      }),
      destroy: vi.fn(),
    };
    mockedCreateClient.mockResolvedValueOnce(mockClient as any);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 402,
      headers: new Headers(make402ResponseHeaders()), // minAmountPerInterval '5000'
    } as any);

    try {
      const tool = server.tools.get('azeth_subscribe_service')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        url: 'https://api.example.com/data',
        // No maxExecutions, no totalCap — must succeed with a default cap, not reject.
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      // amountPerInterval (5000) × 365 = 1,825,000 default totalCap.
      expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith(
        expect.objectContaining({ totalCap: 1825000n }),
      );
      expect(parsed.data.subscription.totalCap).toBe('1825000');
      expect(parsed.data.subscription.totalCapFormatted).toBe('1.825 USDC'); // A1
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('defaults the cap when maxExecutions=0 (no count limit) and no totalCap (OBS-4)', async () => {
    const mockClient = {
      createPaymentAgreement: vi.fn().mockResolvedValue({
        agreementId: 8n,
        txHash: '0xab' + '0'.repeat(62),
      }),
      destroy: vi.fn(),
    };
    mockedCreateClient.mockResolvedValueOnce(mockClient as any);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 402,
      headers: new Headers(make402ResponseHeaders()),
    } as any);

    try {
      const tool = server.tools.get('azeth_subscribe_service')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        url: 'https://api.example.com/data',
        maxExecutions: 0, // no count cap — the amount cap must still be defaulted
      });

      const { isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith(
        expect.objectContaining({ totalCap: 1825000n }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
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
