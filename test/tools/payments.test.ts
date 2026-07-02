import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError, formatTokenAmount } from '@azeth/common';
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
import dns from 'node:dns/promises';

const mockedCreateClient = vi.mocked(createClient);
const mockedLookup = vi.mocked(dns.lookup);

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

    it('rejects a URL whose host resolves to a private IP (SSRF, via getaddrinfo)', async () => {
      // Guard resolves via dns.lookup; a private result must be rejected before any network call.
      mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);

      const tool = server.tools.get('azeth_pay')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        url: 'https://rebind.example.com/data',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toMatch(/private or reserved/i);
      // createClient must never be reached when the SSRF guard rejects.
      expect(mockedCreateClient).not.toHaveBeenCalled();
    });

    it('rejects when the hostname does not resolve (ENOTFOUND → INVALID_INPUT)', async () => {
      mockedLookup.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));

      const tool = server.tools.get('azeth_pay')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        url: 'https://nonexistent.example.com/data',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toMatch(/hostname not found/i);
    });

    it('fails closed when DNS resolution errors (EAI_AGAIN → NETWORK_ERROR)', async () => {
      mockedLookup.mockRejectedValueOnce(Object.assign(new Error('temporary failure'), { code: 'EAI_AGAIN' }));

      const tool = server.tools.get('azeth_pay')!;
      const result = await tool.handler({
        privateKey: TEST_PRIVATE_KEY,
        chain: 'baseSepolia',
        url: 'https://flaky-dns.example.com/data',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('NETWORK_ERROR');
      expect(parsed.error.message).toMatch(/cannot verify URL safety/i);
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
        expect.objectContaining({
          method: 'POST',
          body: '{"key": "value"}',
          maxAmount: undefined,
          // F9: azeth_pay injects an SSRF guard (validate + connection pin + redirect policy)
          secureGuard: expect.any(Function),
        }),
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

    it('renders a human-readable amountFormatted on a paid settlement (A1)', async () => {
      const mockResponse = mockResponseWithBody('{"price":1777}', 200);
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        fetch402: vi.fn().mockResolvedValue({
          paymentMade: true,
          amount: 10000n, // 0.01 USDC (6-dec)
          paymentMethod: 'smart-account',
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

      const { parsed } = parseResult(result);
      expect(parsed.data.amount).toBe('10000');
      expect(parsed.data.amountFormatted).toBe('0.01 USDC');
    });

    it('surfaces paymentMethod "agreement" when the SDK reports agreement-granted access (F4)', async () => {
      const mockResponse = mockResponseWithBody('{"price":1777}', 200);
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        fetch402: vi.fn().mockResolvedValue({
          paymentMade: false, // access granted by the on-chain agreement — no fresh settlement
          amount: undefined,
          paymentMethod: 'agreement',
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
      expect(parsed.data.paid).toBe(false);
      expect(parsed.data.paymentMethod).toBe('agreement');
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

      // Stub the discovery fetch to return no matches → resolution fails fast and
      // deterministically. (A real network call hangs in CI until the test timeout.)
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }) as never;
      try {
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
        // No match → SERVICE_NOT_FOUND (or ACCOUNT_NOT_FOUND/NETWORK_ERROR).
        expect(['NETWORK_ERROR', 'SERVICE_NOT_FOUND', 'ACCOUNT_NOT_FOUND']).toContain(parsed.error.code);
      } finally {
        globalThis.fetch = originalFetch;
      }
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
        // C3: count cap without explicit totalCap → default hard cap amount × maxExecutions × 3
        totalCap: parseUnits('0.01', 18) * 12n * 3n,
        endTime: undefined,
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

    // ── C3: totalCap + endTime ────────────────────
    describe('totalCap and endTime (C3)', () => {
      function mockAgreementClient() {
        const mockClient = {
          address: MOCK_SMART_ACCOUNT,
          createPaymentAgreement: vi.fn().mockResolvedValue({
            agreementId: 7n,
            txHash: '0xcap',
          }),
          destroy: vi.fn(),
        };
        mockedCreateClient.mockResolvedValue(mockClient as never);
        return mockClient;
      }

      it('[REGRESSION C3] without totalCap (maxExecutions=3): defaults totalCap = amount × 3 × 3 and displays the effective cap', async () => {
        // Live finding: agreement #7 (0.50 USDC × maxExecutions 3) paid 3.699999 USDC via
        // pro-rata accrual. The default cap makes that implicit ×3 worst case explicit
        // and on-chain enforced: 0.50 × 3 × 3 = 4.50 USDC.
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'base', // TEST_USDC_ADDRESS is Base-mainnet USDC → symbol resolves to "USDC"
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.50',
          intervalSeconds: 3600,
          maxExecutions: 3,
        });

        expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith(
          expect.objectContaining({
            amount: 500000n,
            maxExecutions: 3,
            totalCap: 4500000n, // 0.50 × 3 × 3 (MAX_ACCRUAL_MULTIPLIER)
          }),
        );

        const { parsed, isError } = parseResult(result);
        expect(isError).toBeUndefined();
        expect(parsed.data.agreement.totalCap).toBe('4500000');
        expect(parsed.data.agreement.totalCapFormatted).toBe(`${formatTokenAmount(4500000n, 6)} USDC`);
        expect(parsed.data.agreement.totalCapSource).toBe('default');
        expect(parsed.data.agreement.capNote).toMatch(/never totalCap/);
      });

      it('[REGRESSION C3] with explicit totalCap: passes it verbatim and displays it', async () => {
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'base', // TEST_USDC_ADDRESS is Base-mainnet USDC → symbol resolves to "USDC"
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.50',
          intervalSeconds: 3600,
          maxExecutions: 3,
          totalCap: '1.50',
        });

        expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith(
          expect.objectContaining({
            maxExecutions: 3,
            totalCap: 1500000n, // verbatim "1.50", NOT the ×3 default
          }),
        );

        const { parsed } = parseResult(result);
        expect(parsed.data.agreement.totalCap).toBe('1500000');
        expect(parsed.data.agreement.totalCapFormatted).toBe(`${formatTokenAmount(1500000n, 6)} USDC`);
        expect(parsed.data.agreement.totalCapSource).toBe('explicit');
        expect(parsed.data.agreement.capNote).toMatch(/never totalCap/);
      });

      it('rejects totalCap "0" with INVALID_INPUT', async () => {
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'baseSepolia',
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.50',
          intervalSeconds: 3600,
          totalCap: '0',
        });

        const { parsed, isError } = parseResult(result);
        expect(isError).toBe(true);
        expect(parsed.error.code).toBe('INVALID_INPUT');
        expect(parsed.error.message).toMatch(/totalCap must be greater than 0/);
        expect(mockClient.createPaymentAgreement).not.toHaveBeenCalled();
      });

      it('rejects malformed totalCap with INVALID_INPUT', async () => {
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'baseSepolia',
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.50',
          intervalSeconds: 3600,
          totalCap: 'lots-of-money',
        });

        const { parsed, isError } = parseResult(result);
        expect(isError).toBe(true);
        expect(parsed.error.code).toBe('INVALID_INPUT');
        expect(parsed.error.message).toMatch(/Invalid totalCap format/);
        expect(mockClient.createPaymentAgreement).not.toHaveBeenCalled();
      });

      it('rejects a past endTime with INVALID_INPUT', async () => {
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'baseSepolia',
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.50',
          intervalSeconds: 3600,
          endTime: Math.floor(Date.now() / 1000) - 60,
        });

        const { parsed, isError } = parseResult(result);
        expect(isError).toBe(true);
        expect(parsed.error.code).toBe('INVALID_INPUT');
        expect(parsed.error.message).toMatch(/endTime must be a future unix timestamp/);
        expect(mockClient.createPaymentAgreement).not.toHaveBeenCalled();
      });

      it('[REGRESSION] rejects an endTime beyond 100 years BEFORE creating on-chain (no duplicate-baiting RangeError)', async () => {
        // Reproduced failure: endTime 9e12 s landed on-chain, then
        // `new Date(9e12 * 1000).toISOString()` threw RangeError in the SUCCESS response —
        // the tool reported failure for a successful create and a retry minted a duplicate
        // recurring authorization. The upper bound must reject it pre-flight.
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'baseSepolia',
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.50',
          intervalSeconds: 3600,
          endTime: 9_000_000_000_000, // > Date-representable range when ISO-formatted
        });

        const { parsed, isError } = parseResult(result);
        expect(isError).toBe(true);
        expect(parsed.error.code).toBe('INVALID_INPUT');
        expect(parsed.error.message).toMatch(/within 100 years/);
        expect(parsed.error.suggestion).toMatch(/SECONDS/);
        expect(mockClient.createPaymentAgreement).not.toHaveBeenCalled();
      });

      it('rejects a millisecond endTime (agent passed Date.now()) with the seconds hint', async () => {
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'baseSepolia',
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.50',
          intervalSeconds: 3600,
          endTime: Date.now() + 86_400_000, // milliseconds, not seconds — ~56,000 years away
        });

        const { parsed, isError } = parseResult(result);
        expect(isError).toBe(true);
        expect(parsed.error.code).toBe('INVALID_INPUT');
        expect(parsed.error.message).toMatch(/within 100 years/);
        expect(mockClient.createPaymentAgreement).not.toHaveBeenCalled();
      });

      it('rejects an endTime that expires before the first interval (guaranteed on-chain revert)', async () => {
        // PaymentAgreementModule requires endTime >= block.timestamp + interval; an endTime
        // in (now, now + interval) previously burned a UserOp on a revert that decoded
        // misleadingly as "agreement is invalid (already cancelled or completed)".
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'baseSepolia',
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.50',
          intervalSeconds: 3600,
          endTime: Math.floor(Date.now() / 1000) + 600, // future, but < now + interval
        });

        const { parsed, isError } = parseResult(result);
        expect(isError).toBe(true);
        expect(parsed.error.code).toBe('INVALID_INPUT');
        expect(parsed.error.message).toMatch(/at least one full interval/);
        expect(mockClient.createPaymentAgreement).not.toHaveBeenCalled();
      });

      it('passes a future endTime to the SDK as bigint and displays it', async () => {
        const mockClient = mockAgreementClient();
        const future = Math.floor(Date.now() / 1000) + 86400;

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'baseSepolia',
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.50',
          intervalSeconds: 3600,
          endTime: future,
        });

        expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith(
          expect.objectContaining({ endTime: BigInt(future) }),
        );

        const { parsed } = parseResult(result);
        expect(parsed.data.agreement.endTime).toBe(future);
        expect(parsed.data.agreement.endTimeISO).toBe(new Date(future * 1000).toISOString());
      });

      it('with neither cap: SDK called without totalCap, response shows the amount × 365 effective cap', async () => {
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'base', // TEST_USDC_ADDRESS is Base-mainnet USDC → symbol resolves to "USDC"
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '10.00',
          intervalSeconds: 86400,
        });

        // The SDK applies its own amount × 365 default — the tool must not invent one here.
        const callArg = mockClient.createPaymentAgreement.mock.calls[0]![0] as { totalCap?: bigint };
        expect(callArg.totalCap).toBeUndefined();

        const { parsed } = parseResult(result);
        const expected = parseUnits('10.00', 6) * 365n;
        expect(parsed.data.agreement.totalCap).toBe(expected.toString());
        expect(parsed.data.agreement.totalCapFormatted).toBe(`${formatTokenAmount(expected, 6)} USDC`);
        expect(parsed.data.agreement.totalCapSource).toBe('default');
      });

      it('parses totalCap with the tool decimals, not hard-coded 6', async () => {
        const mockClient = mockAgreementClient();

        const tool = server.tools.get('azeth_create_payment_agreement')!;
        const result = await tool.handler({
          privateKey: TEST_PRIVATE_KEY,
          chain: 'baseSepolia',
          payee: TEST_ADDRESS,
          token: TEST_USDC_ADDRESS,
          amount: '0.01',
          intervalSeconds: 3600,
          decimals: 18,
          totalCap: '0.05',
        });

        expect(mockClient.createPaymentAgreement).toHaveBeenCalledWith(
          expect.objectContaining({
            amount: parseUnits('0.01', 18),
            totalCap: parseUnits('0.05', 18),
          }),
        );

        const { parsed } = parseResult(result);
        expect(parsed.data.agreement.totalCap).toBe(parseUnits('0.05', 18).toString());
        expect(parsed.data.agreement.totalCapFormatted).toBe(`${formatTokenAmount(parseUnits('0.05', 18), 18)} TOKEN`);
      });
    });
  });
});
