import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError } from '@azeth/common';
import { createMockMcpServer, TEST_ADDRESS, MOCK_SMART_ACCOUNT } from '../helpers.js';
import { registerMessagingTools } from '../../src/tools/messaging.js';

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

describe('messaging tools', () => {
  const server = createMockMcpServer();

  beforeEach(() => {
    vi.clearAllMocks();
    registerMessagingTools(server);
  });

  it('registers two messaging tools', () => {
    expect(server.tools.has('azeth_send_message')).toBe(true);
    expect(server.tools.has('azeth_check_reachability')).toBe(true);
  });

  // ──────────────────────────────────────────────
  // azeth_send_message
  // ──────────────────────────────────────────────

  describe('azeth_send_message', () => {
    it('returns error when recipient name cannot be resolved', async () => {
      // "not-an-address" is treated as a name lookup — fails because server is unreachable in test
      mockedCreateClient.mockResolvedValueOnce({
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`,
        resolveSmartAccount: vi.fn().mockResolvedValue('0x1234567890AbcdEF1234567890aBcdef12345678'),
        getSmartAccounts: vi.fn().mockResolvedValue(['0x1234567890AbcdEF1234567890aBcdef12345678']),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_send_message')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        to: 'not-an-address',
        content: 'Hello agent!',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(['NETWORK_ERROR', 'SERVICE_NOT_FOUND']).toContain(parsed.error.code);
    });

    it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
      mockedCreateClient.mockRejectedValueOnce(
        new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
      );

      const tool = server.tools.get('azeth_send_message')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        to: TEST_ADDRESS,
        content: 'Hello!',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });

    it('sends message and returns conversation ID', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        sendMessage: vi.fn().mockResolvedValue('conv-abc-123'),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_send_message')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        to: TEST_ADDRESS,
        content: 'Hello agent!',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.conversationId).toBe('conv-abc-123');
      expect(parsed.data.to).toBe(TEST_ADDRESS);
      expect(parsed.data.sent).toBe(true);

      expect(mockClient.sendMessage).toHaveBeenCalledWith({
        to: TEST_ADDRESS,
        content: 'Hello agent!',
        contentType: undefined,
      });
    });

    it('passes contentType to sendMessage', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        sendMessage: vi.fn().mockResolvedValue('conv-xyz'),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_send_message')!;
      await tool.handler({
        chain: 'base',
        to: TEST_ADDRESS,
        content: '{"action": "ping"}',
        contentType: 'application/json',
      });

      expect(mockClient.sendMessage).toHaveBeenCalledWith({
        to: TEST_ADDRESS,
        content: '{"action": "ping"}',
        contentType: 'application/json',
      });
    });

    it('handles SERVICE_NOT_FOUND error (unreachable recipient)', async () => {
      mockedCreateClient.mockResolvedValue({
        sendMessage: vi.fn().mockRejectedValue(
          new AzethError('Recipient is not reachable on the XMTP network', 'SERVICE_NOT_FOUND'),
        ),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_send_message')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        to: TEST_ADDRESS,
        content: 'Hello!',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('SERVICE_NOT_FOUND');
    });

    it('handles NETWORK_ERROR (XMTP not initialized)', async () => {
      mockedCreateClient.mockResolvedValue({
        sendMessage: vi.fn().mockRejectedValue(
          new AzethError('XMTP client not initialized', 'NETWORK_ERROR'),
        ),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_send_message')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        to: TEST_ADDRESS,
        content: 'Hello!',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('NETWORK_ERROR');
      expect(parsed.error.suggestion).toContain('network request failed');
    });

    it('calls destroy on the client after success', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        sendMessage: vi.fn().mockResolvedValue('conv-1'),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_send_message')!;
      await tool.handler({
        chain: 'baseSepolia',
        to: TEST_ADDRESS,
        content: 'Test',
      });

      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('calls destroy on the client after error', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        sendMessage: vi.fn().mockRejectedValue(new Error('boom')),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_send_message')!;
      await tool.handler({
        chain: 'baseSepolia',
        to: TEST_ADDRESS,
        content: 'Test',
      });

      expect(mockClient.destroy).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // azeth_check_reachability
  // ──────────────────────────────────────────────

  describe('azeth_check_reachability', () => {
    it('returns error when address name cannot be resolved', async () => {
      // "bad-addr" is treated as a name lookup — fails because server is unreachable in test
      mockedCreateClient.mockResolvedValueOnce({
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as `0x${string}`,
        resolveSmartAccount: vi.fn().mockResolvedValue('0x1234567890AbcdEF1234567890aBcdef12345678'),
        getSmartAccounts: vi.fn().mockResolvedValue(['0x1234567890AbcdEF1234567890aBcdef12345678']),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_check_reachability')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        address: 'bad-addr',
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(['NETWORK_ERROR', 'SERVICE_NOT_FOUND']).toContain(parsed.error.code);
    });

    it('returns error when AZETH_PRIVATE_KEY is missing', async () => {
      mockedCreateClient.mockRejectedValueOnce(
        new AzethError('AZETH_PRIVATE_KEY environment variable is required.', 'UNAUTHORIZED'),
      );

      const tool = server.tools.get('azeth_check_reachability')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        address: TEST_ADDRESS,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('UNAUTHORIZED');
    });

    it('returns reachable=true when address is on XMTP', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        canReach: vi.fn().mockResolvedValue(true),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_check_reachability')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        address: TEST_ADDRESS,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.address).toBe(TEST_ADDRESS);
      expect(parsed.data.reachable).toBe(true);

      expect(mockClient.canReach).toHaveBeenCalledWith(TEST_ADDRESS);
    });

    it('returns reachable=false when address is not on XMTP', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        canReach: vi.fn().mockResolvedValue(false),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_check_reachability')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        address: TEST_ADDRESS,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.data.reachable).toBe(false);
    });

    it('handles NETWORK_ERROR from canReach', async () => {
      mockedCreateClient.mockResolvedValue({
        canReach: vi.fn().mockRejectedValue(
          new AzethError('XMTP client not initialized', 'NETWORK_ERROR'),
        ),
        destroy: vi.fn(),
      } as never);

      const tool = server.tools.get('azeth_check_reachability')!;
      const result = await tool.handler({
        chain: 'baseSepolia',
        address: TEST_ADDRESS,
      });

      const { parsed, isError } = parseResult(result);
      expect(isError).toBe(true);
      expect(parsed.error.code).toBe('NETWORK_ERROR');
    });

    it('calls destroy on the client after success', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        canReach: vi.fn().mockResolvedValue(true),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_check_reachability')!;
      await tool.handler({
        chain: 'baseSepolia',
        address: TEST_ADDRESS,
      });

      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('calls destroy on the client after error', async () => {
      const mockClient = {
        address: MOCK_SMART_ACCOUNT,
        canReach: vi.fn().mockRejectedValue(new Error('network down')),
        destroy: vi.fn(),
      };
      mockedCreateClient.mockResolvedValue(mockClient as never);

      const tool = server.tools.get('azeth_check_reachability')!;
      await tool.handler({
        chain: 'baseSepolia',
        address: TEST_ADDRESS,
      });

      expect(mockClient.destroy).toHaveBeenCalled();
    });
  });
});
