import { describe, it, expect, vi, afterEach } from 'vitest';
import { AzethError } from '@azeth/common';
import { success, error, handleError } from '../../src/utils/response.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('success', () => {
  it('returns CallToolResult with success structure', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T12:00:00.000Z'));

    const result = success({ balance: '100' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: expect.any(String),
    });

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ balance: '100' });
    expect(parsed.meta.timestamp).toBe('2026-02-17T12:00:00.000Z');
  });

  it('includes txHash and blockNumber in meta when provided', () => {
    const result = success(
      { id: '1' },
      { txHash: '0xabc123', blockNumber: 42 },
    );

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.meta.txHash).toBe('0xabc123');
    expect(parsed.meta.blockNumber).toBe(42);
  });

  it('omits txHash and blockNumber from meta when not provided', () => {
    const result = success({ ok: true });

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.meta.txHash).toBeUndefined();
    expect(parsed.meta.blockNumber).toBeUndefined();
  });

  it('serializes bigint values as strings', () => {
    const result = success({ amount: 100000000n, gas: 21000n });

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.data.amount).toBe('100000000');
    expect(parsed.data.gas).toBe('21000');
  });

  it('formats JSON with 2-space indentation', () => {
    const result = success({ x: 1 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('\n');
    expect(text).toContain('  ');
  });

  it('always includes a timestamp in meta', () => {
    const result = success({ ok: true });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    // Timestamp should be a valid ISO string
    expect(new Date(parsed.meta.timestamp).toISOString()).toBe(
      parsed.meta.timestamp,
    );
  });
});

describe('error', () => {
  it('returns CallToolResult with isError: true', () => {
    const result = error('INVALID_INPUT', 'Bad value');

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: expect.any(String),
    });
  });

  it('includes code and message in error body', () => {
    const result = error('NETWORK_ERROR', 'Connection failed');

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe('NETWORK_ERROR');
    expect(parsed.error.message).toBe('Connection failed');
  });

  it('includes suggestion when provided', () => {
    const result = error('INSUFFICIENT_BALANCE', 'No funds', 'Add more ETH');

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toBe('Add more ETH');
  });

  it('omits suggestion when not provided', () => {
    const result = error('UNKNOWN_ERROR', 'Something broke');

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toBeUndefined();
  });
});

describe('handleError', () => {
  it('converts AzethError to structured error with suggestion', () => {
    const err = new AzethError('Budget exceeded', 'BUDGET_EXCEEDED');
    const result = handleError(err);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('BUDGET_EXCEEDED');
    expect(parsed.error.message).toBe('Budget exceeded');
    expect(parsed.error.suggestion).toBe(
      'Reduce the transaction amount or increase your daily spending limit via the guardian.',
    );
  });

  it('provides suggestion for GUARDIAN_REJECTED (default)', () => {
    const err = new AzethError('Blocked', 'GUARDIAN_REJECTED');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('guardrails');
  });

  it('provides specific suggestion for GUARDIAN_REJECTED EXCEEDS_TX_LIMIT', () => {
    const err = new AzethError('Exceeds limit', 'GUARDIAN_REJECTED', {
      reason: 'EXCEEDS_TX_LIMIT',
      maxTxAmountUSD: '$2,000.00',
    });
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('per-tx USD limit');
    expect(parsed.error.suggestion).toContain('$2,000.00');
  });

  it('provides specific suggestion for GUARDIAN_REJECTED EXCEEDS_DAILY_LIMIT', () => {
    const err = new AzethError('Exceeds daily', 'GUARDIAN_REJECTED', {
      reason: 'EXCEEDS_DAILY_LIMIT',
      dailySpendLimitUSD: '$10,000.00',
      dailySpentUSD: '$8,500.00',
    });
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('daily spend');
    expect(parsed.error.suggestion).toContain('$8,500.00');
  });

  it('provides specific suggestion for GUARDIAN_REJECTED TARGET_NOT_WHITELISTED', () => {
    const err = new AzethError('Not whitelisted', 'GUARDIAN_REJECTED', {
      reason: 'TARGET_NOT_WHITELISTED',
    });
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('whitelist');
  });

  it('provides specific suggestion for GUARDIAN_REJECTED ORACLE_STALE', () => {
    const err = new AzethError('Oracle stale', 'GUARDIAN_REJECTED', {
      reason: 'ORACLE_STALE',
    });
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('oracle');
  });

  it('includes balance in INSUFFICIENT_BALANCE suggestion when available', () => {
    const err = new AzethError('Not enough', 'INSUFFICIENT_BALANCE', {
      balance: '50 USDC',
    });
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('50 USDC');
  });

  it('uses generic INSUFFICIENT_BALANCE suggestion when no balance detail', () => {
    const err = new AzethError('Not enough', 'INSUFFICIENT_BALANCE');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toBe('Fund your account before retrying.');
  });

  it('provides suggestion for SESSION_EXPIRED', () => {
    const err = new AzethError('Expired', 'SESSION_EXPIRED');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('session key');
  });

  it('provides suggestion for PAYMENT_FAILED', () => {
    const err = new AzethError('Payment failed', 'PAYMENT_FAILED');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('USDC');
  });

  it('provides suggestion for SERVICE_NOT_FOUND', () => {
    const err = new AzethError('Not found', 'SERVICE_NOT_FOUND');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('discovery');
  });

  it('provides suggestion for REGISTRY_ERROR', () => {
    const err = new AzethError('Registry down', 'REGISTRY_ERROR');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('registry');
  });

  it('provides suggestion for CONTRACT_ERROR', () => {
    const err = new AzethError('Revert', 'CONTRACT_ERROR');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('contract execution failed');
  });

  it('provides AA-specific suggestion for CONTRACT_ERROR with AA23', () => {
    const err = new AzethError('AA23 gas estimation failed', 'CONTRACT_ERROR', {
      aaErrorCode: 'AA23',
    });
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('AA23');
    expect(parsed.error.suggestion).toContain('gas estimation');
  });

  it('provides suggestion for ACCOUNT_NOT_FOUND', () => {
    const err = new AzethError('Not found', 'ACCOUNT_NOT_FOUND');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('azeth_accounts');
  });

  it('provides suggestion for NETWORK_ERROR', () => {
    const err = new AzethError('Timeout', 'NETWORK_ERROR');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('network request failed');
  });

  it('provides suggestion for INVALID_INPUT', () => {
    const err = new AzethError('Bad input', 'INVALID_INPUT');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('input parameters');
  });

  it('provides suggestion for UNAUTHORIZED', () => {
    const err = new AzethError('Not authorized', 'UNAUTHORIZED');
    const result = handleError(err);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.suggestion).toContain('private key');
  });

  it('converts generic Error to UNKNOWN_ERROR', () => {
    const err = new Error('Something unexpected');
    const result = handleError(err);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('UNKNOWN_ERROR');
    expect(parsed.error.message).toBe('Something unexpected');
    expect(parsed.error.suggestion).toBeUndefined();
  });

  it('converts string error to UNKNOWN_ERROR', () => {
    const result = handleError('raw string error');

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('UNKNOWN_ERROR');
    expect(parsed.error.message).toBe('raw string error');
  });

  it('converts number error to UNKNOWN_ERROR', () => {
    const result = handleError(42);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('UNKNOWN_ERROR');
    expect(parsed.error.message).toBe('42');
  });

  it('converts null to UNKNOWN_ERROR', () => {
    const result = handleError(null);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error.code).toBe('UNKNOWN_ERROR');
    expect(parsed.error.message).toBe('null');
  });
});
