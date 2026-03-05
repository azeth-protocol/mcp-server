import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient } from '../utils/client.js';
import { resolveAddress } from '../utils/resolve.js';
import { success, error, handleError } from '../utils/response.js';

/** Register XMTP messaging MCP tools: azeth_send_message, azeth_check_reachability, azeth_receive_messages, azeth_list_conversations, azeth_discover_agent_capabilities */
export function registerMessagingTools(server: McpServer): void {
  // ──────────────────────────────────────────────
  // azeth_send_message
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_send_message',
    {
      description: [
        'Send an encrypted message to another participant via the XMTP messaging network.',
        '',
        'Use this when: You need to communicate with another agent or service using end-to-end encrypted messaging.',
        'The recipient must be reachable on the XMTP network (use azeth_check_reachability first if unsure).',
        '',
        'The "to" field accepts: an Ethereum address, a participant name, "me", or "#N" (account index).',
        '',
        'Returns: The conversation ID and recipient address confirming delivery.',
        '',
        'Note: This is NOT idempotent — each call sends a new message. The sender account is determined',
        'by the AZETH_PRIVATE_KEY environment variable. Messages are limited to 10,000 characters.',
        '',
        'Example: { "to": "Alice", "content": "Hello, I would like to use your price-feed service." }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        to: z.string().describe('Recipient: Ethereum address, participant name, "me", or "#N" (account index).'),
        content: z.string().min(1).max(10_000).describe('Message text content (1-10,000 characters).'),
        contentType: z.string().max(100).optional().describe('Content type hint. Defaults to "text/plain".'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        // Resolve "to": address, name, "me", "#N"
        let toResolved;
        try {
          toResolved = await resolveAddress(args.to, client);
        } catch (resolveErr) {
          return handleError(resolveErr);
        }

        const conversationId = await client.sendMessage({
          to: toResolved.address,
          content: args.content,
          contentType: args.contentType,
        });

        return success({
          conversationId,
          to: toResolved.address,
          ...(toResolved.resolvedFrom ? { resolvedTo: `"${toResolved.resolvedFrom}" → ${toResolved.address}` } : {}),
          sent: true,
        });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* M-10: prevent destroy from masking the original error */ }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_check_reachability
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_check_reachability',
    {
      description: [
        'Check if an Ethereum address is reachable on the XMTP messaging network.',
        '',
        'Use this when: You want to verify a participant can receive XMTP messages before sending.',
        'This is a read-like operation and safe to retry.',
        '',
        'The "address" field accepts: an Ethereum address, a participant name, "me", or "#N" (account index).',
        '',
        'Returns: The address and whether it is reachable (boolean).',
        '',
        'Note: Reachability is cached for 5 minutes. An address is reachable if it has an active XMTP identity.',
        'The checking account is determined by the AZETH_PRIVATE_KEY environment variable.',
        '',
        'Example: { "address": "Alice" } or { "address": "0x1234567890abcdef1234567890abcdef12345678" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        address: z.string().describe('Address to check: Ethereum address, participant name, "me", or "#N".'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        // Resolve address: address, name, "me", "#N"
        let resolved;
        try {
          resolved = await resolveAddress(args.address, client);
        } catch (resolveErr) {
          return handleError(resolveErr);
        }

        const reachable = await client.canReach(resolved.address);

        return success({
          address: resolved.address,
          ...(resolved.resolvedFrom ? { resolvedFrom: `"${resolved.resolvedFrom}" → ${resolved.address}` } : {}),
          reachable,
        });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* M-10: prevent destroy from masking the original error */ }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_receive_messages
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_receive_messages',
    {
      description: [
        'Read incoming encrypted messages from the XMTP messaging network.',
        '',
        'Use this when: You want to check for messages from other agents or services.',
        'This is the "inbox" view — it lets you read what others have sent you.',
        '',
        'Two modes:',
        '  1. With "from": Read messages from a specific sender (up to "limit" messages)',
        '  2. Without "from": Read the latest message from each conversation (inbox overview)',
        '',
        'The "from" field accepts: an Ethereum address, a participant name, "me", or "#N" (account index).',
        '',
        'Returns: Array of messages with sender address, content, timestamp, and conversation ID.',
        '',
        'Note: XMTP messages are end-to-end encrypted. The account reading messages is determined',
        'by the AZETH_PRIVATE_KEY environment variable. First call may be slow due to XMTP initialization.',
        '',
        'Example: { "from": "Alice", "limit": 10 } or { } (all conversations)',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        from: z.string().optional().describe('Read messages from a specific sender. Accepts: address, name, "me", "#N". Omit for inbox overview.'),
        limit: z.coerce.number().int().min(1).max(100).optional().describe('Maximum messages to return. Defaults to 20. Max 100.'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);
        const limit = args.limit ?? 20;

        if (args.from) {
          // Mode 1: Messages from specific sender
          let fromResolved;
          try {
            fromResolved = await resolveAddress(args.from, client);
          } catch (resolveErr) {
            return handleError(resolveErr);
          }

          const messages = await client.getMessages(fromResolved.address, limit);

          return success({
            from: fromResolved.address,
            ...(fromResolved.resolvedFrom ? { resolvedFrom: `"${fromResolved.resolvedFrom}" → ${fromResolved.address}` } : {}),
            messageCount: messages.length,
            messages: messages.map(msg => ({
              sender: msg.sender,
              content: msg.content,
              timestamp: new Date(msg.timestamp).toISOString(),
              conversationId: msg.conversationId,
            })),
          });
        } else {
          // Mode 2: Inbox overview — latest message per conversation
          const conversations = await client.getConversations();

          // For each conversation, get the latest message
          const inbox = [];
          for (const conv of conversations.slice(0, limit)) {
            try {
              const messages = await client.getMessages(conv.peerAddress, 1);
              inbox.push({
                conversationId: conv.id,
                peerAddress: conv.peerAddress,
                createdAt: new Date(conv.createdAt).toISOString(),
                latestMessage: messages.length > 0 ? {
                  content: messages[0]!.content,
                  sender: messages[0]!.sender,
                  timestamp: new Date(messages[0]!.timestamp).toISOString(),
                } : null,
              });
            } catch {
              // Skip conversations that fail to load
              inbox.push({
                conversationId: conv.id,
                peerAddress: conv.peerAddress,
                createdAt: new Date(conv.createdAt).toISOString(),
                latestMessage: null,
              });
            }
          }

          return success({
            conversationCount: conversations.length,
            showing: inbox.length,
            inbox,
          });
        }
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* M-10: prevent destroy from masking the original error */ }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_list_conversations
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_list_conversations',
    {
      description: [
        'List all active XMTP messaging conversations.',
        '',
        'Use this when: You want to see who you have been communicating with,',
        'or check if a conversation exists with a specific peer.',
        '',
        'Returns: Array of conversations with peer address and creation time.',
        '',
        'Note: First call may be slow due to XMTP initialization.',
        '',
        'Example: { }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        const conversations = await client.getConversations();

        return success({
          conversationCount: conversations.length,
          conversations: conversations.map(conv => ({
            id: conv.id,
            peerAddress: conv.peerAddress,
            createdAt: new Date(conv.createdAt).toISOString(),
          })),
        });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* M-10: prevent destroy from masking the original error */ }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_discover_agent_capabilities
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_discover_agent_capabilities',
    {
      description: [
        'Discover what services an agent offers by sending them a capabilities request over XMTP.',
        '',
        'Use this when: You want to find out what services another agent provides, their pricing,',
        'and how to use them — before making a service request or payment.',
        '',
        'Sends a JSON capabilities request to the target agent and waits for their response.',
        'The target agent must be online and have a MessageRouter configured to respond.',
        '',
        'The "agentAddress" field accepts: an Ethereum address, a participant name, "me", or "#N" (account index).',
        '',
        'Returns: The agent\'s capabilities including services, pricing, and usage instructions.',
        'If no response within the timeout, returns an error indicating the agent may be offline.',
        '',
        'Example: { "agentAddress": "0x1234567890abcdef1234567890abcdef12345678" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        agentAddress: z.string().describe('Target agent: Ethereum address, participant name, "me", or "#N" (account index).'),
        timeoutMs: z.coerce.number().int().min(1000).max(60_000).optional().describe('Timeout in milliseconds to wait for response. Defaults to 15000 (15 seconds). Max 60000.'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);
        const timeoutMs = args.timeoutMs ?? 15_000;

        // Resolve target address
        let resolved;
        try {
          resolved = await resolveAddress(args.agentAddress, client);
        } catch (resolveErr) {
          return handleError(resolveErr);
        }

        // Send capabilities request
        const capabilitiesRequest = JSON.stringify({ type: 'capabilities' });
        await client.sendMessage({
          to: resolved.address,
          content: capabilitiesRequest,
        });

        // Poll for response within timeout
        const startTime = Date.now();
        const pollIntervalMs = 2_000;

        while (Date.now() - startTime < timeoutMs) {
          // Wait before polling
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

          const messages = await client.getMessages(resolved.address, 5);
          if (messages.length > 0) {
            // Look for a capabilities response among recent messages
            for (const msg of messages) {
              // Skip messages older than our request
              if (msg.timestamp < startTime) continue;

              try {
                const parsed: unknown = JSON.parse(msg.content);
                if (
                  typeof parsed === 'object' &&
                  parsed !== null &&
                  'type' in parsed &&
                  (parsed as { type: string }).type === 'capabilities'
                ) {
                  return success({
                    agentAddress: resolved.address,
                    ...(resolved.resolvedFrom ? { resolvedFrom: `"${resolved.resolvedFrom}" → ${resolved.address}` } : {}),
                    capabilities: parsed,
                  });
                }
              } catch {
                // Not valid JSON — skip
              }
            }
          }
        }

        // Timeout — no response received
        return error(
          'NETWORK_ERROR',
          `No capabilities response received from ${resolved.address} within ${timeoutMs}ms. ` +
          'The agent may be offline or does not have a MessageRouter configured.',
        );
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* M-10: prevent destroy from masking the original error */ }
      }
    },
  );
}
