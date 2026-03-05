import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError } from '@azeth/common';
import { createMockMcpServer, TEST_ADDRESS, MOCK_SMART_ACCOUNT } from '../helpers.js';
import { registerAgreementTools } from '../../src/tools/agreements.js';

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

/** Create a mock agreement object matching the PaymentAgreement type */
function mockAgreement(overrides?: Partial<{
  id: bigint;
  payee: string;
  token: string;
  amount: bigint;
  interval: bigint;
  endTime: bigint;
  lastExecuted: bigint;
  maxExecutions: bigint;
  executionCount: bigint;
  totalCap: bigint;
  totalPaid: bigint;
  active: boolean;
}>) {
  return {
    id: 0n,
    payee: TEST_ADDRESS as `0x${string}`,
    token: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    amount: 10000000000000n, // 0.00001 ETH
    interval: 60n,
    endTime: 0n,
    lastExecuted: BigInt(Math.floor(Date.now() / 1000) - 30),
    maxExecutions: 5n,
    executionCount: 1n,
    totalCap: 50000000000000n, // 0.00005 ETH
    totalPaid: 9722222222222n,
    active: true,
    ...overrides,
  };
}

/** Create a mock getAgreementData return value */
function mockAgreementData(
  agreement: ReturnType<typeof mockAgreement>,
  overrides?: Partial<{
    executable: boolean;
    reason: string;
    isDue: boolean;
    nextExecutionTime: bigint;
    count: bigint;
  }>,
) {
  return {
    agreement,
    executable: overrides?.executable ?? false,
    reason: overrides?.reason ?? 'interval not elapsed',
    isDue: overrides?.isDue ?? false,
    nextExecutionTime: overrides?.nextExecutionTime ?? BigInt(Math.floor(Date.now() / 1000) + 30),
    count: overrides?.count ?? 1n,
  };
}

describe('agreement tools', () => {
  const server = createMockMcpServer();

  beforeEach(() => {
    vi.clearAllMocks();
    registerAgreementTools(server);
  });

  it('registers all agreement tools', () => {
    expect(server.tools.has('azeth_execute_agreement')).toBe(true);
    expect(server.tools.has('azeth_cancel_agreement')).toBe(true);
    expect(server.tools.has('azeth_get_agreement')).toBe(true);
    expect(server.tools.has('azeth_list_agreements')).toBe(true);
    expect(server.tools.has('azeth_get_due_agreements')).toBe(true);
  });

  // ──────────────────────────────────────────────
  // azeth_execute_agreement
  // ──────────────────────────────────────────────

  describe('azeth_execute_agreement', () => {
    it('successfully executes a due agreement', async () => {
      const postExecAgreement = mockAgreement({
        executionCount: 2n,
        totalPaid: 19444444444444n,
      });

      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        canExecutePayment: vi.fn().mockResolvedValue({ executable: true, reason: '' }),
        executeAgreement: vi.fn().mockResolvedValue('0xtxhash123'),
        getAgreement: vi.fn().mockResolvedValue(postExecAgreement),
        getNextExecutionTime: vi.fn().mockResolvedValue(BigInt(Math.floor(Date.now() / 1000) + 60)),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_execute_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        account: MOCK_SMART_ACCOUNT,
        agreementId: 0,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.agreementId).toBe('0');
      expect(parsed.data.tokenSymbol).toBe('ETH');
      expect(parsed.data.executionCount).toBe('2');
      expect(parsed.data.maxExecutions).toBe('5');
      expect(parsed.data.active).toBe(true);
      expect(parsed.meta.txHash).toBe('0xtxhash123');
      expect(mockClient.canExecutePayment).toHaveBeenCalledWith(0n, MOCK_SMART_ACCOUNT);
      expect(mockClient.executeAgreement).toHaveBeenCalledWith(0n, MOCK_SMART_ACCOUNT);
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('returns error when agreement is not yet due', async () => {
      const futureTime = BigInt(Math.floor(Date.now() / 1000) + 300);
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        canExecutePayment: vi.fn().mockResolvedValue({ executable: false, reason: 'interval not elapsed' }),
        getNextExecutionTime: vi.fn().mockResolvedValue(futureTime),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_execute_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        account: MOCK_SMART_ACCOUNT,
        agreementId: 0,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('not due yet');
      expect(parsed.error.message).toContain('Next execution');
    });

    it('returns error when agreement does not exist', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        canExecutePayment: vi.fn().mockRejectedValue(new Error('revert')),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_execute_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        account: MOCK_SMART_ACCOUNT,
        agreementId: 999,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('not found');
    });

    it('returns error when agreement is cancelled/completed', async () => {
      const cancelledAgreement = mockAgreement({ active: false, executionCount: 0n });
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        canExecutePayment: vi.fn().mockResolvedValue({ executable: false, reason: 'not active' }),
        getAgreement: vi.fn().mockResolvedValue(cancelledAgreement),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_execute_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        account: MOCK_SMART_ACCOUNT,
        agreementId: 0,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('cancelled');
    });

    it('resolves account from "me"', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        canExecutePayment: vi.fn().mockResolvedValue({ executable: true, reason: '' }),
        executeAgreement: vi.fn().mockResolvedValue('0xtxhash456'),
        getAgreement: vi.fn().mockResolvedValue(mockAgreement()),
        getNextExecutionTime: vi.fn().mockResolvedValue(BigInt(Math.floor(Date.now() / 1000) + 60)),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_execute_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        account: 'me',
        agreementId: 0,
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(mockClient.canExecutePayment).toHaveBeenCalledWith(0n, MOCK_SMART_ACCOUNT);
    });
  });

  // ──────────────────────────────────────────────
  // azeth_cancel_agreement
  // ──────────────────────────────────────────────

  describe('azeth_cancel_agreement', () => {
    it('successfully cancels an active agreement', async () => {
      const activeAgreement = mockAgreement({ active: true });
      const cancelledAgreement = mockAgreement({ active: false });

      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreement: vi.fn()
          .mockResolvedValueOnce(activeAgreement)
          .mockResolvedValueOnce(cancelledAgreement),
        cancelAgreement: vi.fn().mockResolvedValue('0xcancel123'),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_cancel_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        agreementId: 0,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.agreementId).toBe('0');
      expect(parsed.data.status).toBe('cancelled');
      expect(parsed.data.tokenSymbol).toBe('ETH');
      expect(parsed.meta.txHash).toBe('0xcancel123');
      expect(mockClient.cancelAgreement).toHaveBeenCalledWith(0n, MOCK_SMART_ACCOUNT);
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('returns error when cancelling already cancelled agreement', async () => {
      const cancelledAgreement = mockAgreement({ active: false, executionCount: 0n });
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreement: vi.fn().mockResolvedValue(cancelledAgreement),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_cancel_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        agreementId: 0,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('already cancelled');
    });

    it('returns error when cancelling completed agreement', async () => {
      const completedAgreement = mockAgreement({
        active: false,
        maxExecutions: 5n,
        executionCount: 5n,
      });
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreement: vi.fn().mockResolvedValue(completedAgreement),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_cancel_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        agreementId: 0,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('already completed');
    });
  });

  // ──────────────────────────────────────────────
  // azeth_get_agreement (uses getAgreementData — 1 RPC)
  // ──────────────────────────────────────────────

  describe('azeth_get_agreement', () => {
    it('returns full agreement details', async () => {
      const agreement = mockAgreement();
      const nextTime = BigInt(Math.floor(Date.now() / 1000) + 45);

      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn().mockResolvedValue(
          mockAgreementData(agreement, {
            executable: false,
            reason: 'interval not elapsed',
            isDue: false,
            nextExecutionTime: nextTime,
          }),
        ),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_get_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        account: MOCK_SMART_ACCOUNT,
        agreementId: 0,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.agreementId).toBe('0');
      expect(parsed.data.status).toBe('active');
      expect(parsed.data.tokenSymbol).toBe('ETH');
      expect(parsed.data.intervalHuman).toBe('every minute');
      expect(parsed.data.executionCount).toBe('1');
      expect(parsed.data.maxExecutions).toBe('5');
      expect(parsed.data.expiresAt).toBe('never');
      expect(parsed.data.canExecute).toBe(false);
      expect(parsed.data.canExecuteReason).toBe('interval not elapsed');
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('returns error for non-existent agreement', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn().mockRejectedValue(new Error('revert')),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_get_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        account: MOCK_SMART_ACCOUNT,
        agreementId: 999,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain('not found');
    });

    it('formats interval correctly for daily agreements', async () => {
      const agreement = mockAgreement({ interval: 86400n });
      const nextTime = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn().mockResolvedValue(
          mockAgreementData(agreement, {
            executable: false,
            reason: 'interval not elapsed',
            nextExecutionTime: nextTime,
          }),
        ),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_get_agreement')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        account: MOCK_SMART_ACCOUNT,
        agreementId: 0,
      });

      const { parsed } = parseResult(result);
      expect(parsed.data.intervalHuman).toBe('daily');
    });
  });

  // ──────────────────────────────────────────────
  // azeth_list_agreements (uses getAgreementData — 1 RPC per agreement)
  // ──────────────────────────────────────────────

  describe('azeth_list_agreements', () => {
    it('lists all agreements newest first', async () => {
      const agreement0 = mockAgreement({ id: 0n, amount: 10000000000000n, active: true });
      const agreement1 = mockAgreement({ id: 1n, amount: 20000000000000n, active: false, executionCount: 0n });

      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn()
          .mockImplementation(async (id: bigint) => {
            if (id === 0n) return mockAgreementData(agreement0, { count: 2n });
            return mockAgreementData(agreement1, { count: 2n });
          }),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_list_agreements')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.totalAgreements).toBe(2);
      expect(parsed.data.showing).toBe(2);
      expect(parsed.data.agreements).toHaveLength(2);
      // Newest first (id 1 before id 0)
      expect(parsed.data.agreements[0].agreementId).toBe('1');
      expect(parsed.data.agreements[1].agreementId).toBe('0');
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('filters by status "active"', async () => {
      const agreement0 = mockAgreement({ active: true });
      const agreement1 = mockAgreement({ active: false, executionCount: 0n });

      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn()
          .mockImplementation(async (id: bigint) => {
            if (id === 0n) return mockAgreementData(agreement0, { count: 2n });
            return mockAgreementData(agreement1, { count: 2n });
          }),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_list_agreements')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        status: 'active',
      });

      const { parsed } = parseResult(result);
      expect(parsed.data.showing).toBe(1);
      expect(parsed.data.filter).toBe('active');
      expect(parsed.data.agreements[0].status).toBe('active');
    });

    it('filters by status "due"', async () => {
      const agreement0 = mockAgreement({ active: true });
      const agreement1 = mockAgreement({ active: true });

      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn()
          .mockImplementation(async (id: bigint) => {
            if (id === 1n) return mockAgreementData(agreement1, {
              executable: true,
              reason: '',
              isDue: true,
              nextExecutionTime: BigInt(Math.floor(Date.now() / 1000) - 10),
              count: 2n,
            });
            return mockAgreementData(agreement0, {
              executable: false,
              reason: 'interval not elapsed',
              count: 2n,
            });
          }),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_list_agreements')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        status: 'due',
      });

      const { parsed } = parseResult(result);
      expect(parsed.data.filter).toBe('due');
      expect(parsed.data.showing).toBe(1);
      expect(parsed.data.agreements[0].agreementId).toBe('1');
    });

    it('returns empty list for account with zero agreements', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn().mockResolvedValue(
          mockAgreementData(mockAgreement(), { count: 0n }),
        ),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_list_agreements')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.totalAgreements).toBe(0);
      expect(parsed.data.agreements).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────
  // azeth_get_due_agreements (uses getAgreementData — 1 RPC per agreement)
  // ──────────────────────────────────────────────

  describe('azeth_get_due_agreements', () => {
    it('returns due agreements from a single account', async () => {
      const dueAgreement = mockAgreement({ active: true });
      const notDueAgreement = mockAgreement({ active: true });

      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn()
          .mockImplementation(async (id: bigint) => {
            if (id === 0n) return mockAgreementData(dueAgreement, {
              executable: true,
              reason: '',
              isDue: true,
              nextExecutionTime: BigInt(Math.floor(Date.now() / 1000) - 120),
              count: 2n,
            });
            return mockAgreementData(notDueAgreement, {
              executable: false,
              reason: 'interval not elapsed',
              count: 2n,
            });
          }),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_get_due_agreements')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.scannedAccounts).toBe(1);
      expect(parsed.data.scannedAgreements).toBe(2);
      expect(parsed.data.dueAgreements).toHaveLength(1);
      expect(parsed.data.dueAgreements[0].agreementId).toBe('0');
      expect(parsed.data.dueAgreements[0].tokenSymbol).toBe('ETH');
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('scans multiple accounts', async () => {
      const account2 = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
      const agreement = mockAgreement({ active: true });

      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn().mockResolvedValue(
          mockAgreementData(agreement, {
            executable: true,
            reason: '',
            isDue: true,
            nextExecutionTime: BigInt(Math.floor(Date.now() / 1000) - 60),
            count: 1n,
          }),
        ),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_get_due_agreements')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        accounts: [MOCK_SMART_ACCOUNT, account2],
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.scannedAccounts).toBe(2);
      expect(parsed.data.dueAgreements.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty when no agreements are due', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        publicClient: { readContract: vi.fn() },
        addresses: {},
        getAgreementData: vi.fn().mockResolvedValue(
          mockAgreementData(mockAgreement({ active: true }), {
            executable: false,
            reason: 'interval not elapsed',
            count: 1n,
          }),
        ),
        resolveSmartAccount: vi.fn().mockResolvedValue(MOCK_SMART_ACCOUNT),
        getSmartAccounts: vi.fn().mockResolvedValue([MOCK_SMART_ACCOUNT]),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_get_due_agreements')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
      });

      const { parsed } = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.dueAgreements).toHaveLength(0);
    });
  });
});
