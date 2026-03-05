import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError } from '@azeth/common';
import { parseUnits } from 'viem';
import { createMockMcpServer, TEST_PRIVATE_KEY, TEST_ADDRESS, TEST_USDC_ADDRESS, MOCK_SMART_ACCOUNT } from '../helpers.js';
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

/** Create a mock Response object with a ReadableStream body for the streaming reader */
function mockResponseWithBody(body: string, status = 200) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return { status, body: stream, text: vi.fn().mockResolvedValue(body) };
}

function parseResult(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    parsed: JSON.parse(r.content[0].text),
    isError: r.isError,
  };
}

describe('payment tools', () => {
  const server = createMockMcpServer();

  beforeEach(() => {
    vi.clearAllMocks();
    registerPaymentTools(server);
  });

  it('registers payment tools', () => {
    expect(server.tools.has('azeth_pay')).toBe(true);
    expect(server.tools.has('azeth_smart_pay')).toBe(true);
    expect(server.tools.has('azeth_create_payment_agreement')).toBe(true);
  });

  // ──────────────────────────────────────────────
  // azeth_pay
  // ──────────────────────────────────────────────

  describe('azeth_pay', () => {
    it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
      mockedCreateClient.mockRejectedValueOnce(
        new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
      );

      const tool = server.tools.get('azeth_pay')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        url: 'https://api.example.com/data',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });

    it('returns success with payment data', async () => {
      const mockResponse = mockResponseWithBody('{"result": "data"}', 200);
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        fetch402: vi.fn().mockResolvedValue({
          paymentMade: true,
          amount: 500000n,
          response: mockResponse,
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_pay')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        url: 'https://api.example.com/data',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.paid).toBe(true);
      expect(parsed.data.amount).toBe('500000');
      expect(parsed.data.statusCode).toBe(200);
      expect(parsed.data.body).toBe('{"result": "data"}');
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('passes method and body to fetch402', async () => {
      const mockResponse = mockResponseWithBody('created', 201);
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        fetch402: vi.fn().mockResolvedValue({
          paymentMade: false,
          amount: undefined,
          response: mockResponse,
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_pay')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'base',
        url: 'https://api.example.com/submit',
        method: 'POST',
        body: '{"key": "value"}',
      });

      expect(mockClient.fetch402).toHaveBeenCalledWith(
        'https://api.example.com/submit',
        {
          method: 'POST',
          body: '{"key": "value"}',
          maxAmount: undefined,
        },
      );
    });

    it('passes parsed maxAmount to fetch402', async () => {
      const mockResponse = mockResponseWithBody('ok', 200);
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        fetch402: vi.fn().mockResolvedValue({
          paymentMade: true,
          amount: 5000000n,
          response: mockResponse,
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_pay')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        url: 'https://api.example.com',
        maxAmount: '5.00',
      });

      // 5.00 USDC with 6 decimals = 5000000
      expect(mockClient.fetch402).toHaveBeenCalledWith(
        'https://api.example.com',
        expect.objectContaining({
          maxAmount: parseUnits('5.00', 6),
        }),
      );
    });

    it('handles when no payment was required', async () => {
      const mockResponse = mockResponseWithBody('free content', 200);
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        fetch402: vi.fn().mockResolvedValue({
          paymentMade: false,
          amount: undefined,
          response: mockResponse,
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_pay')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        url: 'https://free.example.com',
      });

      const { parsed } = parseResult(result);
      expect(parsed.data.paid).toBe(false);
      expect(parsed.data.amount).toBeUndefined();
    });

    it('handles PAYMENT_FAILED error', async () => {
      mockedCreateClient.mockResolvedValue({
        fetch402: vi.fn().mockRejectedValue(
          new AzethError('Payment rejected', 'PAYMENT_FAILED'),
        ),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_pay')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        url: 'https://api.example.com',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('PAYMENT_FAILED');
      expect(parsed.error.suggestion).toContain('USDC');
    });
  });

  // ──────────────────────────────────────────────
  // azeth_smart_pay
  // ──────────────────────────────────────────────

  describe('azeth_smart_pay', () => {
    it('returns service metadata alongside response', async () => {
      const mockResponse = mockResponseWithBody('{"price": "1234.56"}', 200);
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        smartFetch402: vi.fn().mockResolvedValue({
          paymentMade: true,
          amount: 100000n,
          paymentMethod: 'x402',
          response: mockResponse,
          service: {
            name: 'PriceFeedService',
            endpoint: 'https://price.example.com/api',
            tokenId: 42n,
            reputation: 92,
          },
          attemptsCount: 1,
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_smart_pay')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        capability: 'price-feed',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.paid).toBe(true);
      expect(parsed.data.service.name).toBe('PriceFeedService');
      expect(parsed.data.service.tokenId).toBe('42');
      expect(parsed.data.service.reputation).toBe(92);
      expect(parsed.data.attemptsCount).toBe(1);
      expect(parsed.data.body).toBe('{"price": "1234.56"}');
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('handles no services found gracefully', async () => {
      mockedCreateClient.mockResolvedValue({
        smartFetch402: vi.fn().mockRejectedValue(
          new AzethError('No services found for capability "exotic-thing"', 'SERVICE_NOT_FOUND'),
        ),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_smart_pay')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        capability: 'exotic-thing',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('SERVICE_NOT_FOUND');
      expect(parsed.error.suggestion).toContain('broader discovery');
    });

    it('passes minReputation and maxAmount through', async () => {
      const mockResponse = mockResponseWithBody('ok', 200);
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        smartFetch402: vi.fn().mockResolvedValue({
          paymentMade: true,
          amount: 500000n,
          paymentMethod: 'x402',
          response: mockResponse,
          service: { name: 'Svc', endpoint: 'https://s.com', tokenId: 1n, reputation: 80 },
          attemptsCount: 1,
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_smart_pay')!;
      await tool.handler({
        chain: 'base',
        capability: 'market-data',
        method: 'POST',
        body: '{"query": "BTC/USD"}',
        maxAmount: '2.00',
        minReputation: 70,
      });

      expect(mockClient.smartFetch402).toHaveBeenCalledWith('market-data', expect.objectContaining({
        method: 'POST',
        body: '{"query": "BTC/USD"}',
        maxAmount: 2_000_000n,
        minReputation: 70,
      }));
    });
  });

  // ──────────────────────────────────────────────
  // azeth_create_payment_agreement
  // ──────────────────────────────────────────────

  describe('azeth_create_payment_agreement', () => {
    it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
      mockedCreateClient.mockRejectedValueOnce(
        new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
      );

      const tool = server.tools.get('azeth_create_payment_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        payee: TEST_ADDRESS,
        token: TEST_USDC_ADDRESS,
        amount: '10.00',
        intervalSeconds: 86400,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });

    it('returns error when payee name cannot be resolved', async () => {
      // "not-address" is treated as a name lookup — fails because server is unreachable in test
      mockedCreateClient.mockResolvedValueOnce({
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`,
        resolveSmartAccount: vi.fn().mockResolvedValue('0x1234567890AbcdEF1234567890aBcdef12345678'),
        getSmartAccounts: vi.fn().mockResolvedValue(['0x1234567890AbcdEF1234567890aBcdef12345678']),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_create_payment_agreement')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        payee: 'not-address',
        token: TEST_USDC_ADDRESS,
        amount: '10.00',
        intervalSeconds: 86400,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      // Name resolution fails with NETWORK_ERROR (server unreachable), SERVICE_NOT_FOUND, or ACCOUNT_NOT_FOUND
      expect(['NETWORK_ERROR', 'SERVICE_NOT_FOUND', 'ACCOUNT_NOT_FOUND']).toContain(parsed.error.code);
    });

    it('returns error for invalid token address', async () => {
      const tool = server.tools.get('azeth_create_payment_agreement')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        payee: TEST_ADDRESS,
        token: 'bad-token',
        amount: '10.00',
        intervalSeconds: 86400,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('token address');
    });

    it('creates payment agreement with default 6 decimals', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        createPaymentAgreement: vi.fn().mockResolvedValue({
          agreementId: 7n,
          txHash: '0xagree123',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_create_payment_agreement')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        payee: TEST_ADDRESS,
        token: TEST_USDC_ADDRESS,
        amount: '10.00',
        intervalSeconds: 86400,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.agreementId).toBe('7');
      expect(parsed.data.txHash).toBe('0xagree123');
      expect(parsed.meta.txHash).toBe('0xagree123');

      expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith({
        payee: TEST_ADDRESS,
        token: TEST_USDC_ADDRESS,
        amount: parseUnits('10.00', 6),
        interval: 86400,
        maxExecutions: undefined,
      });
    });

    it('creates payment agreement with custom decimals and maxExecutions', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        createPaymentAgreement: vi.fn().mockResolvedValue({
          agreementId: 8n,
          txHash: '0xagree456',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_create_payment_agreement')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'base',
        payee: TEST_ADDRESS,
        token: TEST_USDC_ADDRESS,
        amount: '0.01',
        intervalSeconds: 604800,
        maxExecutions: 12,
        decimals: 18,
      });

      expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith({
        payee: TEST_ADDRESS,
        token: TEST_USDC_ADDRESS,
        amount: parseUnits('0.01', 18),
        interval: 604800,
        maxExecutions: 12,
      });
    });

    it('calls destroy on the client', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        createPaymentAgreement: vi.fn().mockResolvedValue({
          agreementId: 1n,
          txHash: '0xcleanup',
        }),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_create_payment_agreement')!;
      await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        payee: TEST_ADDRESS,
        token: TEST_USDC_ADDRESS,
        amount: '5.00',
        intervalSeconds: 3600,
      });

      expect(mockClient.destroy).toHaveBeenCalled();
    });
  });
});
