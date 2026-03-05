import { z } from 'zod';
import { parseEther, parseUnits, formatEther, erc20Abi } from 'viem';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient, validateAddress } from '../utils/client.js';
import { resolveAddress, resolveSmartAccount } from '../utils/resolve.js';
import { success, error, handleError, guardianRequiredError } from '../utils/response.js';

/** Register the azeth_transfer MCP tool */
export function registerTransferTools(server: McpServer): void {
  server.registerTool(
    'azeth_transfer',
    {
      description: [
        'Send ETH or ERC-20 tokens FROM your Azeth smart account to another address.',
        '',
        'Use this when: You need to pay another participant, fund an account, or move tokens between addresses.',
        '',
        'The "to" field accepts: an Ethereum address, a participant name (resolved via trust registry),',
        '"me" (your first smart account), or "#N" (Nth account index from azeth_accounts).',
        '',
        'IMPORTANT: This sends FROM your smart account, not your EOA. Ensure your smart account is funded.',
        'Use azeth_deposit first to fund your smart account if needed.',
        'One EOA can own multiple smart accounts — specify which one, or defaults to first.',
        '',
        'Returns: Transaction hash, sender smart account address, recipient address (with resolution info), and amount sent.',
        '',
        'Note: This is a state-changing operation. The tool shows the resolved address before executing.',
        'For ETH transfers, omit the token parameter. For ERC-20 tokens, provide the token contract address AND decimals.',
        'The amount is in human-readable units (e.g., "1.5" for 1.5 ETH or "100" for 100 USDC).',
        'The sender account is determined by the AZETH_PRIVATE_KEY environment variable.',
        '',
        'Example: { "to": "Alice", "amount": "0.001" } or { "to": "0x1234...abcd", "amount": "10", "token": "0x036C...CF7e", "decimals": 6 }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        to: z.string().describe('Recipient: Ethereum address, participant name, "me", or "#N" (account index).'),
        amount: z.string().describe('Amount to send in human-readable units (e.g., "1.5" for 1.5 ETH, "100" for 100 USDC).'),
        token: z.string().optional().describe('ERC-20 token contract address. Omit for native ETH transfer.'),
        decimals: z.coerce.number().int().min(0).max(18).optional().describe('Token decimals for ERC-20 transfers. REQUIRED when token is specified. Use 6 for USDC, 18 for WETH.'),
        smartAccount: z.string().optional().describe('Smart account to transfer from: address, name, or "#N". If omitted, uses your first smart account.'),
      }),
    },
    async (args) => {
      if (args.token && !validateAddress(args.token)) {
        return error('INVALID_INPUT', `Invalid token address: "${args.token}".`, 'Must be 0x-prefixed followed by 40 hex characters.');
      }
      if (args.token && args.decimals === undefined) {
        return error('INVALID_INPUT', 'decimals is required when token address is provided.', 'Use 6 for USDC, 18 for WETH.');
      }

      let client;
      try {
        client = await createClient(args.chain);

        // Resolve "to": address, name, "me", "#N"
        let toResolved;
        try {
          toResolved = await resolveAddress(args.to, client, 'account');
        } catch (resolveErr) {
          return handleError(resolveErr);
        }

        // Resolve smartAccount: address, name, "#N"
        let fromAccount: `0x${string}` | undefined;
        if (args.smartAccount) {
          try {
            fromAccount = await resolveSmartAccount(args.smartAccount, client);
          } catch (resolveErr) {
            return handleError(resolveErr);
          }
        }

        const tokenAddress = args.token as `0x${string}` | undefined;
        const decimals = args.decimals ?? 18;
        let amount: bigint;
        try {
          amount = tokenAddress
            ? parseUnits(args.amount, decimals)
            : parseEther(args.amount);
        } catch {
          return error('INVALID_INPUT', 'Invalid amount format — must be a valid decimal number');
        }

        // Pre-flight: check balance before submitting UserOp
        try {
          const senderAccount = fromAccount ?? await client.resolveSmartAccount();
          if (tokenAddress) {
            // Direct ERC-20 balanceOf call — getBalance() keys by symbol, not address
            const available = await client.publicClient.readContract({
              address: tokenAddress,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [senderAccount],
            });
            if (available < amount) {
              const { formatUnits } = await import('viem');
              return error(
                'INSUFFICIENT_BALANCE',
                `Insufficient token balance: have ${formatUnits(available, decimals)}, need ${args.amount}.`,
                `Fund your smart account (${senderAccount}) before retrying.`,
              );
            }
          } else {
            const balance = await client.getBalance(senderAccount);
            if (balance.eth < amount) {
              return error(
                'INSUFFICIENT_BALANCE',
                `Insufficient ETH balance: have ${formatEther(balance.eth)} ETH, need ${args.amount} ETH.`,
                `Fund your smart account (${fromAccount ?? senderAccount}) before retrying.`,
              );
            }
          }
        } catch {
          // Balance check is best-effort; proceed and let the bundler return details on failure
        }

        const result = await client.transfer(
          { to: toResolved.address, amount, token: tokenAddress },
          fromAccount,
        );

        // Enrich response with transaction receipt data (gas, events)
        let receiptData: Record<string, unknown> = {};
        try {
          const receipt = await client.publicClient.getTransactionReceipt({ hash: result.txHash as `0x${string}` });
          const gasUsed = receipt.gasUsed;
          const effectiveGasPrice = receipt.effectiveGasPrice;
          const gasCostWei = gasUsed * effectiveGasPrice;
          const { formatTokenAmount } = await import('@azeth/common');

          // Decode known events from logs
          const events: Array<{ name: string; args: Record<string, string> }> = [];
          try {
            const { decodeEventLog } = await import('viem');
            const { GuardianModuleAbi, ReputationModuleAbi: RepAbi } = await import('@azeth/common/abis');
            const knownAbis = [GuardianModuleAbi, RepAbi];
            for (const log of receipt.logs) {
              for (const abi of knownAbis) {
                try {
                  const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
                  const stringArgs: Record<string, string> = {};
                  for (const [k, v] of Object.entries(decoded.args as Record<string, unknown>)) {
                    stringArgs[k] = typeof v === 'bigint' ? v.toString() : String(v);
                  }
                  events.push({ name: decoded.eventName, args: stringArgs });
                  break; // matched this log
                } catch {
                  // This ABI doesn't match this log — try next
                }
              }
            }
          } catch {
            // Event decoding failure is non-fatal
          }

          receiptData = {
            gasUsed: gasUsed.toString(),
            gasCostETH: formatTokenAmount(gasCostWei, 18, 8),
            ...(events.length > 0 ? { events } : {}),
          };
        } catch {
          // Receipt fetch failure is non-fatal
        }

        return success(
          {
            txHash: result.txHash,
            from: result.from,
            to: result.to,
            amount: args.amount,
            token: result.token,
            ...(toResolved.resolvedFrom ? {
              resolvedTo: `"${toResolved.resolvedFrom}" → ${toResolved.address}`,
              ...(toResolved.name ? { resolvedName: toResolved.name } : {}),
              ...(toResolved.tokenId ? { resolvedTokenId: toResolved.tokenId } : {}),
            } : {}),
            ...receiptData,
          },
          { txHash: result.txHash },
        );
      } catch (err) {
        if (err instanceof Error && /AA24/.test(err.message)) {
          return guardianRequiredError(
            'Transfer amount exceeds your standard spending limit.',
            {
              operation: 'transfer',
              amount: `${args.amount} ${args.token ? 'tokens' : 'ETH'}`,
              limit: 'Check with azeth_get_guardrails',
            },
          );
        }
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );
}
