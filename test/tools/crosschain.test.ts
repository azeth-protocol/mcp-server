import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzethError, AZETH_CONTRACTS, SUPPORTED_CHAINS } from '@azeth/common';
import { createMockMcpServer, TEST_PRIVATE_KEY } from '../helpers.js';
import { registerCrosschainTools } from '../../src/tools/crosschain.js';

// Mock the SDK boundary — the tools delegate all proof/read logic to these stateless fns.
vi.mock('@azeth/sdk', () => ({
  buildL2UsdDeltaProof: vi.fn(),
  proveL2UsdDelta: vi.fn(),
  getCrossChainReputation: vi.fn(),
}));

// Mock viem client construction (the tools build raw clients via dynamic import).
// `http` echoes its URL so tests can assert which RPC each client received.
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ kind: 'publicClient' })),
    createWalletClient: vi.fn(() => ({ kind: 'walletClient' })),
    http: vi.fn((url?: string) => ({ url })),
  };
});

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({ address: '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266' })),
}));

import { buildL2UsdDeltaProof, proveL2UsdDelta, getCrossChainReputation } from '@azeth/sdk';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const mockedBuild = vi.mocked(buildL2UsdDeltaProof);
const mockedProve = vi.mocked(proveL2UsdDelta);
const mockedGetReputation = vi.mocked(getCrossChainReputation);
const mockedCreatePublicClient = vi.mocked(createPublicClient);
const mockedCreateWalletClient = vi.mocked(createWalletClient);
const mockedHttp = vi.mocked(http);
const mockedPrivateKeyToAccount = vi.mocked(privateKeyToAccount);

function parseResult(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    parsed: JSON.parse(r.content[0]!.text),
    isError: r.isError,
  };
}

const PAYER = '0x1111111111111111111111111111111111111111';
const PAYEE = '0x2222222222222222222222222222222222222222';
const TEST_TX_HASH = `0x${'ab'.repeat(32)}`;
const ANCHOR_ROOT = `0x${'42'.repeat(32)}`;
/** $12.34 in 18-decimal USD WAD */
const USD_12_34 = 12_340_000_000_000_000_000n;

const MOCK_PROOF = {
  chainId: 84532n,
  account0: PAYER,
  account1: PAYEE,
  stateRootProof: `0x${'11'.repeat(128)}`,
  accountProof: [`0x${'a1'.repeat(4)}`, `0x${'a2'.repeat(4)}`, `0x${'a3'.repeat(4)}`],
  storageProof: [`0x${'b1'.repeat(4)}`, `0x${'b2'.repeat(4)}`],
  anchor: { root: ANCHOR_ROOT, l2BlockNumber: 42329663n },
  outputRootPreimage: {
    version: `0x${'00'.repeat(32)}`,
    stateRoot: `0x${'aa'.repeat(32)}`,
    messagePasserStorageRoot: `0x${'bb'.repeat(32)}`,
    latestBlockhash: `0x${'cc'.repeat(32)}`,
  },
  slot: `0x${'05'.repeat(32)}`,
  baseSlot: 6n,
  rawSlotValue: `0x${'00'.repeat(24)}ab3034a482f78000`,
  usdDelta: USD_12_34,
};

const SIMULATED_RESULT = {
  status: 'simulated' as const,
  account0: PAYER,
  account1: PAYEE,
  chainId: 84532n,
  usdDelta: USD_12_34,
  anchorL2BlockNumber: 42329663n,
};

const HAPPY_REPUTATION = {
  from: PAYER,
  to: PAYEE,
  totalNetPaidUSD: USD_12_34,
  chains: [
    {
      chainId: 84532n,
      chainName: 'Base Sepolia',
      netPaidUSD: USD_12_34,
      proven: true,
      l2BlockNumber: 42329663n,
      provenAt: 1781049600n,
    },
  ],
  registeredChainIds: [84532n],
};

const ZERO_REPUTATION = {
  from: PAYER,
  to: PAYEE,
  totalNetPaidUSD: 0n,
  chains: [
    {
      chainId: 84532n,
      chainName: 'Base Sepolia',
      netPaidUSD: 0n,
      proven: false,
      l2BlockNumber: 0n,
      provenAt: 0n,
    },
  ],
  registeredChainIds: [84532n],
};

/** Env vars the tools read — saved/cleared per test, restored after */
const ENV_KEYS = [
  'AZETH_PRIVATE_KEY',
  'AZETH_CHAIN',
  'AZETH_ARCHIVE_RPC_URL_BASE_SEPOLIA',
  'AZETH_RPC_URL_BASE_SEPOLIA',
  'AZETH_RPC_URL_ETH_SEPOLIA',
] as const;

describe('crosschain tools', () => {
  const server = createMockMcpServer();
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    registerCrosschainTools(server);
    // Happy-path defaults — individual tests override as needed
    mockedBuild.mockResolvedValue(MOCK_PROOF as never);
    mockedProve.mockResolvedValue(SIMULATED_RESULT as never);
    mockedGetReputation.mockResolvedValue(HAPPY_REPUTATION as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  // 1
  it('registers exactly azeth_prove_reputation and azeth_get_cross_chain_reputation', () => {
    const freshServer = createMockMcpServer();
    registerCrosschainTools(freshServer);
    expect(freshServer.tools.size).toBe(2);
    expect(freshServer.tools.has('azeth_prove_reputation')).toBe(true);
    expect(freshServer.tools.has('azeth_get_cross_chain_reputation')).toBe(true);
  });

  // ──────────────────────────────────────────────
  // azeth_prove_reputation
  // ──────────────────────────────────────────────

  describe('azeth_prove_reputation', () => {
    // 2
    it('builds + simulates by default without any private key (broadcast=false)', async () => {
      expect(process.env['AZETH_PRIVATE_KEY']).toBeUndefined();

      const tool = server.tools.get('azeth_prove_reputation')!;
      const result = await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: false });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.status).toBe('simulated');
      expect(parsed.data.note).toContain('broadcast=true');
      expect(parsed.data.l2Chain).toBe('baseSepolia');
      expect(parsed.data.l2ChainId).toBe('84532');
      expect(parsed.data.l1Chain).toBe('ethereumSepolia');
      expect(parsed.data.trustL2Reader).toBe(AZETH_CONTRACTS.ethereumSepolia.trustL2Reader);
      expect(parsed.data.usdDelta).toBe(USD_12_34.toString());
      expect(parsed.data.usdDeltaFormatted).toBe('$12.34');
      expect(parsed.data.direction).toBe('payer→payee');
      expect(parsed.data.anchor).toEqual({ l2BlockNumber: '42329663', outputRoot: ANCHOR_ROOT });
      expect(parsed.data.proof).toEqual({
        stateRootProofBytes: 128,
        accountProofNodes: 3,
        storageProofNodes: 2,
        slot: MOCK_PROOF.slot,
        baseSlot: '6',
      });

      expect(mockedBuild).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        AZETH_CONTRACTS.ethereumSepolia.trustL2Reader,
        { chainId: 84532n, accountA: PAYER, accountB: PAYEE },
      );
      expect(mockedProve).toHaveBeenCalledWith(
        expect.anything(),
        AZETH_CONTRACTS.ethereumSepolia.trustL2Reader,
        MOCK_PROOF,
        expect.objectContaining({ broadcast: false }),
      );
      expect(mockedCreateWalletClient).not.toHaveBeenCalled();
    });

    // 3
    it('rejects broadcast=true without AZETH_PRIVATE_KEY (UNAUTHORIZED, mentions L1 ETH)', async () => {
      const tool = server.tools.get('azeth_prove_reputation')!;
      const result = await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: true });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
      expect(parsed.error.message).toContain('L1 ETH');
      expect(parsed.error.suggestion).toContain('broadcast=false');
      expect(mockedCreateWalletClient).not.toHaveBeenCalled();
      expect(mockedProve).not.toHaveBeenCalled();
    });

    // 4
    it('broadcasts with a valid AZETH_PRIVATE_KEY and surfaces txHash', async () => {
      process.env['AZETH_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
      mockedProve.mockResolvedValue({
        ...SIMULATED_RESULT,
        status: 'broadcast',
        gasEstimate: 250000n,
        txHash: TEST_TX_HASH,
      } as never);

      const tool = server.tools.get('azeth_prove_reputation')!;
      const result = await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: true });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.status).toBe('broadcast');
      expect(parsed.data.txHash).toBe(TEST_TX_HASH);
      expect(parsed.meta.txHash).toBe(TEST_TX_HASH);
      expect(parsed.data.note).toBeUndefined();

      expect(mockedPrivateKeyToAccount).toHaveBeenCalledWith(TEST_PRIVATE_KEY);
      expect(mockedCreateWalletClient).toHaveBeenCalledTimes(1);
      const walletClient = mockedCreateWalletClient.mock.results[0]!.value;
      expect(mockedProve).toHaveBeenCalledWith(
        expect.anything(),
        AZETH_CONTRACTS.ethereumSepolia.trustL2Reader,
        MOCK_PROOF,
        expect.objectContaining({ broadcast: true, l1WalletClient: walletClient }),
      );
    });

    // 4b
    it('surfaces receiptStatus pending WITH the txHash when the receipt wait timed out after broadcast', async () => {
      process.env['AZETH_PRIVATE_KEY'] = TEST_PRIVATE_KEY;
      mockedProve.mockResolvedValue({
        ...SIMULATED_RESULT,
        status: 'broadcast',
        gasEstimate: 250000n,
        txHash: TEST_TX_HASH,
        receiptStatus: 'pending',
      } as never);

      const tool = server.tools.get('azeth_prove_reputation')!;
      const result = await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: true });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.data.status).toBe('broadcast');
      expect(parsed.data.receiptStatus).toBe('pending');
      // the agent MUST still get the hash so it can track instead of re-submitting
      expect(parsed.data.txHash).toBe(TEST_TX_HASH);
      expect(parsed.meta.txHash).toBe(TEST_TX_HASH);
      expect(parsed.data.note).toContain('do NOT re-run');

      // and a confirmed receipt carries no warning note
      mockedProve.mockResolvedValue({
        ...SIMULATED_RESULT,
        status: 'broadcast',
        gasEstimate: 250000n,
        txHash: TEST_TX_HASH,
        receiptStatus: 'confirmed',
      } as never);
      const confirmed = parseResult(await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: true }));
      expect(confirmed.parsed.data.receiptStatus).toBe('confirmed');
      expect(confirmed.parsed.data.note).toBeUndefined();
    });

    // 5
    it('maps SDK INSUFFICIENT_BALANCE (L1 gas missing) with a funding suggestion', async () => {
      mockedProve.mockRejectedValue(
        new AzethError(
          'L1 wallet has insufficient ETH on Sepolia for proof submission: balance 100 wei, required ~200000 wei. Fund it with Sepolia ETH or run with broadcast=false',
          'INSUFFICIENT_BALANCE',
          { balance: 100n, required: 200000n, chain: 'Sepolia' },
        ),
      );

      const tool = server.tools.get('azeth_prove_reputation')!;
      const result = await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: false });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INSUFFICIENT_BALANCE');
      expect(parsed.error.suggestion).toContain('Fund');
    });

    // 6
    it('maps builder PROOF_INVALID ZERO_DELTA with the zero-delta suggestion', async () => {
      mockedBuild.mockRejectedValue(
        new AzethError(
          `transferDeltaUSD[${PAYER}][${PAYEE}] is zero at anchor block 42329663 on chain 84532 — zero values cannot be proven (exclusion proofs revert on-chain)`,
          'PROOF_INVALID',
          { reason: 'ZERO_DELTA', slot: MOCK_PROOF.slot, anchorL2BlockNumber: 42329663n },
        ),
      );

      const tool = server.tools.get('azeth_prove_reputation')!;
      const result = await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: false });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('PROOF_INVALID');
      expect(parsed.error.suggestion).toContain('zero values cannot be proven');
      expect(mockedProve).not.toHaveBeenCalled();
    });

    // 7
    it('rejects an L1 chain as the L2 argument (INVALID_INPUT)', async () => {
      const tool = server.tools.get('azeth_prove_reputation')!;
      const result = await tool.handler({
        chain: 'ethereumSepolia',
        payer: PAYER,
        payee: PAYEE,
        broadcast: false,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('not a supported L2');
      expect(parsed.error.suggestion).toContain('baseSepolia');
      expect(mockedBuild).not.toHaveBeenCalled();
    });

    // 8
    it('rejects payer === payee (case-insensitive, INVALID_INPUT)', async () => {
      const tool = server.tools.get('azeth_prove_reputation')!;
      const result = await tool.handler({
        payer: PAYER,
        payee: PAYER.toUpperCase().replace('0X', '0x'),
        broadcast: false,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(mockedBuild).not.toHaveBeenCalled();
    });

    // 9
    it('returns NETWORK_ERROR when TrustL2Reader is not deployed on the L1', async () => {
      const record = AZETH_CONTRACTS.ethereumSepolia as { trustL2Reader: string };
      const saved = record.trustL2Reader;
      record.trustL2Reader = '';
      try {
        const tool = server.tools.get('azeth_prove_reputation')!;
        const result = await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: false });

        const { parsed, isError } = parseResult(result);
        expect(isError).toBe(true);
        expect(parsed.error.code).toBe('NETWORK_ERROR');
        expect(parsed.error.message).toContain('TrustL2Reader not deployed');
        expect(mockedBuild).not.toHaveBeenCalled();
      } finally {
        record.trustL2Reader = saved;
      }
    });

    // 10
    it('resolves the L2 archive RPC from AZETH_ARCHIVE_RPC_URL_BASE_SEPOLIA, then the regular RPC var, then the default', async () => {
      const tool = server.tools.get('azeth_prove_reputation')!;
      const l2ClientCall = () => {
        const call = mockedCreatePublicClient.mock.calls.find(
          (c) => (c[0] as { chain: { id: number } }).chain.id === 84532,
        );
        return call?.[0] as { transport: { url: string } };
      };

      // Archive var wins
      process.env['AZETH_ARCHIVE_RPC_URL_BASE_SEPOLIA'] = 'https://archive.example';
      process.env['AZETH_RPC_URL_BASE_SEPOLIA'] = 'https://l2-rpc.example';
      await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: false });
      expect(mockedHttp).toHaveBeenCalledWith('https://archive.example');
      expect(l2ClientCall().transport.url).toBe('https://archive.example');

      // Falls back to the regular per-chain RPC var
      mockedCreatePublicClient.mockClear();
      mockedHttp.mockClear();
      delete process.env['AZETH_ARCHIVE_RPC_URL_BASE_SEPOLIA'];
      await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: false });
      expect(l2ClientCall().transport.url).toBe('https://l2-rpc.example');

      // Falls back to the chain default
      mockedCreatePublicClient.mockClear();
      mockedHttp.mockClear();
      delete process.env['AZETH_RPC_URL_BASE_SEPOLIA'];
      await tool.handler({ payer: PAYER, payee: PAYEE, broadcast: false });
      expect(l2ClientCall().transport.url).toBe(SUPPORTED_CHAINS.baseSepolia.rpcDefault);
    });
  });

  // ──────────────────────────────────────────────
  // azeth_get_cross_chain_reputation
  // ──────────────────────────────────────────────

  describe('azeth_get_cross_chain_reputation', () => {
    // 11
    it('returns the aggregate, per-chain breakdown, and summary without any private key', async () => {
      expect(process.env['AZETH_PRIVATE_KEY']).toBeUndefined();

      const tool = server.tools.get('azeth_get_cross_chain_reputation')!;
      const result = await tool.handler({ from: PAYER, to: PAYEE });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.from).toBe(PAYER);
      expect(parsed.data.to).toBe(PAYEE);
      expect(parsed.data.l1Chain).toBe('ethereumSepolia');
      expect(parsed.data.trustL2Reader).toBe(AZETH_CONTRACTS.ethereumSepolia.trustL2Reader);
      expect(parsed.data.totalNetPaidUSD).toBe(USD_12_34.toString());
      expect(parsed.data.totalNetPaidUSDFormatted).toBe('$12.34');
      expect(parsed.data.registeredChainIds).toEqual(['84532']);
      expect(parsed.data.chains).toHaveLength(1);
      const row = parsed.data.chains[0];
      expect(row.chainId).toBe('84532');
      expect(row.chainName).toBe('Base Sepolia');
      expect(row.netPaidUSD).toBe(USD_12_34.toString());
      expect(row.netPaidUSDFormatted).toBe('$12.34');
      expect(row.proven).toBe(true);
      expect(row.l2BlockNumber).toBe('42329663');
      expect(row.provenAt).toBe('1781049600');
      expect(row.provenAtISO).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/);
      expect(parsed.data.summary).toContain('$12.34');
      expect(parsed.data.summary).toContain('Base Sepolia');
      expect(parsed.data.summary).toContain('proven at L2 block 42329663');

      expect(mockedGetReputation).toHaveBeenCalledWith(
        expect.anything(),
        AZETH_CONTRACTS.ethereumSepolia.trustL2Reader,
        PAYER,
        PAYEE,
      );
      expect(mockedCreateWalletClient).not.toHaveBeenCalled();
    });

    // 12
    it('returns NETWORK_ERROR when the requested l1Chain has no TrustL2Reader', async () => {
      const tool = server.tools.get('azeth_get_cross_chain_reputation')!;
      const result = await tool.handler({ from: PAYER, to: PAYEE, l1Chain: 'baseSepolia' });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('NETWORK_ERROR');
      expect(parsed.error.message).toContain('TrustL2Reader not deployed');
      expect(mockedGetReputation).not.toHaveBeenCalled();
    });

    // 13
    it('describes a zero-proof pair and suggests azeth_prove_reputation', async () => {
      mockedGetReputation.mockResolvedValue(ZERO_REPUTATION as never);

      const tool = server.tools.get('azeth_get_cross_chain_reputation')!;
      const result = await tool.handler({ from: PAYER, to: PAYEE });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.totalNetPaidUSD).toBe('0');
      expect(parsed.data.summary.startsWith('No L1-proven cross-chain payments')).toBe(true);
      expect(parsed.data.summary).toContain('azeth_prove_reputation');
      expect(parsed.data.chains[0].proven).toBe(false);
      expect(parsed.data.chains[0].provenAtISO).toBeNull();
    });

    // 14
    it('rejects from === to (INVALID_INPUT)', async () => {
      const tool = server.tools.get('azeth_get_cross_chain_reputation')!;
      const result = await tool.handler({ from: PAYER, to: PAYER });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(mockedGetReputation).not.toHaveBeenCalled();
    });

    // 15
    it('returns a sanitized error envelope when the SDK read throws a generic Error', async () => {
      mockedGetReputation.mockRejectedValue(
        new Error('connection refused: https://secret-l1.example.com/v3/apikey123'),
      );

      const tool = server.tools.get('azeth_get_cross_chain_reputation')!;
      const result = await tool.handler({ from: PAYER, to: PAYEE });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('UNKNOWN_ERROR');
      expect(parsed.error.message).toContain('[redacted-url]');
      expect(parsed.error.message).not.toContain('secret-l1.example.com');
    });
  });
});
