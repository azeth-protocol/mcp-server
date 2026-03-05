import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient } from '../utils/client.js';
import { success, error, handleError } from '../utils/response.js';
import {
  tryParseGuardianRequest,
  tryParseGuardianResponse,
  getPendingApproval,
  type GuardianApprovalRequest,
  type GuardianApprovalResponse,
} from '@azeth/sdk';

/** Register guardian approval MCP tools: azeth_guardian_approve, azeth_guardian_status */
export function registerGuardianApprovalTools(server: McpServer): void {
  // ──────────────────────────────────────────────
  // azeth_guardian_approve
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_guardian_approve',
    {
      description: [
        'Review and approve or reject guardian approval requests from agents you protect.',
        '',
        'Azeth smart accounts have a guardian who co-signs high-value operations.',
        'When an agent exceeds its autonomous spending limits, it sends you (the guardian)',
        'an approval request via XMTP. Use this tool to review and respond to those requests.',
        '',
        'Three modes:',
        '  1. No request_id: Lists all pending guardian approval requests from your XMTP inbox',
        '  2. request_id + decision "approve": Co-signs the userOpHash and sends approval via XMTP',
        '  3. request_id + decision "reject": Sends rejection with optional reason via XMTP',
        '',
        'When approving, this tool signs the userOpHash with your AZETH_PRIVATE_KEY (which is',
        'the guardian key on your MCP instance) and sends the signature back to the requesting agent.',
        '',
        'Returns: List of pending requests (mode 1), or confirmation of approve/reject (mode 2/3).',
        '',
        'Example (list): { }',
        'Example (approve): { "request_id": "abc-123", "decision": "approve" }',
        'Example (reject): { "request_id": "abc-123", "decision": "reject", "reason": "Amount too high" }',
      ].join('\n'),
      inputSchema: z.object({
        request_id: z.string().optional().describe(
          'The request ID to approve or reject. If omitted, lists all pending guardian approval requests from your XMTP messages.',
        ),
        decision: z.enum(['approve', 'reject']).optional().describe(
          'Decision: "approve" to co-sign the operation, "reject" to deny it. Required when request_id is provided.',
        ),
        reason: z.string().optional().describe(
          'Optional reason for rejection. Only used when decision is "reject".',
        ),
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        if (!args.request_id) {
          // ── Mode 1: List pending requests from XMTP ──
          const conversations = await client.getConversations();
          const pendingRequests: Array<{
            requestId: string;
            from: string;
            account: string;
            operation: GuardianApprovalRequest['operation'];
            reason: string;
            limits: GuardianApprovalRequest['limits'];
            expiresAt: string;
            userOpHash: string;
          }> = [];

          for (const conv of conversations) {
            try {
              const messages = await client.getMessages(conv.peerAddress as `0x${string}`, 20);
              for (const msg of messages) {
                const parsed = tryParseGuardianRequest(msg.content);
                if (!parsed) continue;

                // Skip expired requests
                const expiresAtMs = new Date(parsed.expiresAt).getTime();
                if (Date.now() > expiresAtMs) continue;

                pendingRequests.push({
                  requestId: parsed.requestId,
                  from: conv.peerAddress,
                  account: parsed.account,
                  operation: parsed.operation,
                  reason: parsed.reason,
                  limits: parsed.limits,
                  expiresAt: parsed.expiresAt,
                  userOpHash: parsed.userOpHash,
                });
              }
            } catch {
              // Skip conversations that fail to load
            }
          }

          if (pendingRequests.length === 0) {
            return success({
              message: 'No pending guardian approval requests found.',
              pendingCount: 0,
              requests: [],
            });
          }

          return success({
            message: `Found ${pendingRequests.length} pending guardian approval request(s).`,
            pendingCount: pendingRequests.length,
            requests: pendingRequests.map(r => ({
              requestId: r.requestId,
              from: r.from ? `${r.from.slice(0, 6)}...${r.from.slice(-4)}` : undefined,
              account: r.account ? `${r.account.slice(0, 6)}...${r.account.slice(-4)}` : undefined,
              operationType: r.operation.type,
              description: r.operation.description,
              amount: r.operation.amount,
              usdValue: r.operation.usdValue,
              to: r.operation.to,
              reason: r.reason,
              expiresAt: r.expiresAt,
              limits: r.limits,
            })),
            hint: 'To approve: { "request_id": "<id>", "decision": "approve" }. To reject: { "request_id": "<id>", "decision": "reject", "reason": "..." }',
          });
        }

        // ── Mode 2/3: Approve or reject a specific request ──

        if (!args.decision) {
          return error(
            'INVALID_INPUT',
            'When request_id is provided, decision ("approve" or "reject") is required.',
          );
        }

        // Find the request in XMTP messages
        let foundRequest: GuardianApprovalRequest | null = null;
        let senderAddress: `0x${string}` | null = null;

        const conversations = await client.getConversations();
        for (const conv of conversations) {
          try {
            const messages = await client.getMessages(conv.peerAddress as `0x${string}`, 20);
            for (const msg of messages) {
              const parsed = tryParseGuardianRequest(msg.content);
              if (parsed && parsed.requestId === args.request_id) {
                foundRequest = parsed;
                senderAddress = conv.peerAddress as `0x${string}`;
                break;
              }
            }
            if (foundRequest) break;
          } catch {
            // Skip conversations that fail to load
          }
        }

        if (!foundRequest || !senderAddress) {
          return error(
            'SERVICE_NOT_FOUND',
            'Guardian approval request not found or expired. Use this tool without request_id to list pending requests.',
          );
        }

        // Check expiry
        const expiresAtMs = new Date(foundRequest.expiresAt).getTime();
        if (Date.now() > expiresAtMs) {
          return error(
            'SESSION_EXPIRED',
            `Guardian approval request "${args.request_id}" has expired. The agent will need to retry the operation.`,
          );
        }

        if (args.decision === 'approve') {
          // Sign the userOpHash with the guardian's private key (AZETH_PRIVATE_KEY)
          const privateKey = process.env['AZETH_PRIVATE_KEY'];
          if (!privateKey) {
            return error(
              'UNAUTHORIZED',
              'AZETH_PRIVATE_KEY is required to sign guardian approvals.',
            );
          }

          // Dynamic import to avoid top-level viem dependency
          const { privateKeyToAccount } = await import('viem/accounts');
          const guardianAccount = privateKeyToAccount(privateKey as `0x${string}`);

          // Sign the userOpHash with EIP-191 personal sign (matching GuardianModule expectations)
          const signature = await guardianAccount.signMessage({
            message: { raw: foundRequest.userOpHash as `0x${string}` },
          });

          // Send approval response via XMTP
          const response: GuardianApprovalResponse = {
            type: 'azeth:guardian_response',
            version: '1.0',
            requestId: args.request_id,
            decision: 'approved',
            signature: signature as `0x${string}`,
          };

          await client.sendMessage({
            to: senderAddress,
            content: JSON.stringify(response),
          });

          return success({
            message: `Approved guardian request "${args.request_id}". Signature sent to ${senderAddress} via XMTP.`,
            requestId: args.request_id,
            decision: 'approved',
            operation: foundRequest.operation.description,
            account: foundRequest.account,
            sentTo: senderAddress,
          });
        } else {
          // Reject — send rejection response via XMTP
          const response: GuardianApprovalResponse = {
            type: 'azeth:guardian_response',
            version: '1.0',
            requestId: args.request_id,
            decision: 'rejected',
            reason: args.reason,
          };

          await client.sendMessage({
            to: senderAddress,
            content: JSON.stringify(response),
          });

          return success({
            message: `Rejected guardian request "${args.request_id}".${args.reason ? ` Reason: ${args.reason}` : ''}`,
            requestId: args.request_id,
            decision: 'rejected',
            reason: args.reason ?? 'No reason provided',
            operation: foundRequest.operation.description,
            account: foundRequest.account,
            sentTo: senderAddress,
          });
        }
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* prevent destroy from masking the original error */ }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_guardian_status
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_guardian_status',
    {
      description: [
        'Check the status of a pending guardian approval request.',
        '',
        'Use this when: You previously submitted an operation that required guardian co-signature',
        'and received a timeout with a request_id. This tool checks if the guardian has since',
        'responded via XMTP.',
        '',
        'Status outcomes:',
        '  - "approved": Guardian approved. Returns the guardian signature.',
        '    Retry your original operation — it will now succeed with the guardian co-signature.',
        '  - "rejected": Guardian rejected with a reason.',
        '  - "pending": Guardian has not responded yet. Check again later.',
        '  - "expired": Request expired after 5 minutes. Retry your original operation.',
        '',
        'Returns: Current status and relevant details (signature if approved, reason if rejected).',
        '',
        'Example: { "request_id": "abc-123" }',
      ].join('\n'),
      inputSchema: z.object({
        request_id: z.string().describe('The guardian approval request ID returned by a previous operation.'),
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
      }),
    },
    async (args) => {
      let client;
      try {
        // Check in-memory pending approvals store first
        const pending = getPendingApproval(args.request_id);

        if (!pending) {
          return error(
            'SERVICE_NOT_FOUND',
            `No guardian approval request found with ID "${args.request_id}". ` +
            'The request may have been made in a different process or session.',
            'Guardian approval state is stored in-memory per process. If the MCP server restarted, the request state is lost. Retry the original operation.',
          );
        }

        if (pending.status === 'expired') {
          return success({
            requestId: args.request_id,
            status: 'expired',
            message: 'Request expired after 5 minutes. Retry your original operation to send a new approval request.',
            operation: pending.operation,
          });
        }

        if (pending.status === 'approved') {
          const combinedSignature = (pending.ownerSignature + pending.guardianSignature!.slice(2)) as `0x${string}`;
          return success({
            requestId: args.request_id,
            status: 'approved',
            message: 'Guardian approved! Retry your original operation — it will succeed with the guardian co-signature.',
            guardianSignature: pending.guardianSignature,
            combinedSignature,
            operation: pending.operation,
          });
        }

        if (pending.status === 'rejected') {
          return success({
            requestId: args.request_id,
            status: 'rejected',
            message: `Guardian rejected the request.${pending.rejectionReason ? ` Reason: ${pending.rejectionReason}` : ''}`,
            reason: pending.rejectionReason,
            operation: pending.operation,
          });
        }

        // Status is 'pending' — check XMTP for new response
        client = await createClient(args.chain);

        const messages = await client.getMessages(pending.guardianAddress, 20);
        for (const msg of messages) {
          if (msg.timestamp < pending.createdAt) continue;

          const parsed = tryParseGuardianResponse(msg.content);
          if (parsed && parsed.requestId === args.request_id) {
            if (parsed.decision === 'approved' && parsed.signature) {
              pending.status = 'approved';
              pending.guardianSignature = parsed.signature;
              const combinedSignature = (pending.ownerSignature + parsed.signature.slice(2)) as `0x${string}`;

              return success({
                requestId: args.request_id,
                status: 'approved',
                message: 'Guardian approved! Retry your original operation — it will succeed with the guardian co-signature.',
                guardianSignature: parsed.signature,
                combinedSignature,
                operation: pending.operation,
              });
            } else {
              pending.status = 'rejected';
              pending.rejectionReason = parsed.reason;

              return success({
                requestId: args.request_id,
                status: 'rejected',
                message: `Guardian rejected the request.${parsed.reason ? ` Reason: ${parsed.reason}` : ''}`,
                reason: parsed.reason,
                operation: pending.operation,
              });
            }
          }
        }

        // No response yet
        return success({
          requestId: args.request_id,
          status: 'pending',
          message: 'Guardian has not responded yet. Check again later.',
          guardianAddress: pending.guardianAddress,
          operation: pending.operation,
          expiresAt: new Date(pending.expiresAt).toISOString(),
        });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* prevent destroy from masking the original error */ }
      }
    },
  );
}
