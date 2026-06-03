import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMcpServer, MOCK_SMART_ACCOUNT } from '../helpers.js';
import { registerGuardianTools } from '../../src/tools/guardian.js';

vi.mock('../../src/utils/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/client.js')>();
  return {
    ...actual,
    createClient: vi.fn(),
    resolveChain: vi.fn().mockReturnValue('baseSepolia'),
  };
});

import { createClient } from '../../src/utils/client.js';

const mockedCreateClient = vi.mocked(createClient);

function parseResult(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { parsed: JSON.parse(r.content[0].text), isError: r.isError };
}

const ZERO32 = ('0x' + '00'.repeat(32)) as `0x${string}`;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as `0x${string}`;

/** A mock AzethKit whose on-chain reads return a plausible guardrails snapshot. */
function makeGuardianClient() {
  return {
    resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
    publicClient: {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case 'getGuardrails':
            return {
              maxTxAmountUSD: 100_000000000000000000n,
              dailySpendLimitUSD: 1000_000000000000000000n,
              guardianMaxTxAmountUSD: 500_000000000000000000n,
              guardianDailySpendLimitUSD: 5000_000000000000000000n,
              guardian: '0x1111111111111111111111111111111111111111',
              emergencyWithdrawTo: '0x2222222222222222222222222222222222222222',
            };
          case 'getDailySpentUSD':
            return 0n;
          case 'getPendingChange':
            return { changeHash: ZERO32, executeAfter: 0n, exists: false };
          case 'getPendingEmergency':
            return { token: ZERO_ADDR, executeAfter: 0n, exists: false };
          case 'isTokenWhitelisted':
            return true;
          default:
            return 0n;
        }
      }),
    },
    destroy: vi.fn(),
  };
}

describe('guardian tools', () => {
  const server = createMockMcpServer();

  beforeEach(() => {
    vi.clearAllMocks();
    registerGuardianTools(server);
  });

  it('registers azeth_get_guardrails', () => {
    expect(server.tools.has('azeth_get_guardrails')).toBe(true);
  });

  it('reports core modules under installedModules, not protocolWhitelist (OBS-3)', async () => {
    mockedCreateClient.mockResolvedValue(makeGuardianClient() as never);

    const tool = server.tools.get('azeth_get_guardrails')!;
    const result = await tool.handler({ chain: 'baseSepolia' });

    const { parsed, isError } = parseResult(result);
    expect(isError).toBeUndefined();

    // Installed executor modules are surfaced as installedModules (with addresses) —
    // they are not external protocols, so they no longer appear as a misleading
    // protocolWhitelist:false.
    expect(parsed.data.installedModules).toBeDefined();
    expect(parsed.data.installedModules.PaymentAgreementModule).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(parsed.data.installedModules.ReputationModule).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(parsed.data.protocolWhitelist).toBeUndefined();

    // The token whitelist is unchanged.
    expect(parsed.data.tokenWhitelist).toEqual({ ETH: true, USDC: true, WETH: true });
  });
});
