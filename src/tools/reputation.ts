import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient, resolveChain, resolveViemChain, validateAddress } from '../utils/client.js';
import { success, error, handleError, formatUSD } from '../utils/response.js';
import { ReputationModuleAbi, TrustRegistryModuleAbi } from '@azeth/common/abis';
import { AzethError, AZETH_CONTRACTS, formatTokenAmount } from '@azeth/common';

/** Maximum uint256 value for on-chain IDs */
const MAX_UINT256 = (1n << 256n) - 1n;
/** Validate that a numeric string fits within uint256 range.
 *  L-19 fix (Audit #8): Wrap BigInt() in try/catch for defense-in-depth. */
function validateUint256(value: string, fieldName: string): { valid: true; bigint: bigint } | { valid: false; fieldName: string } {
  try {
    const n = BigInt(value);
    if (n < 0n || n > MAX_UINT256) {
      return { valid: false, fieldName };
    }
    return { valid: true, bigint: n };
  } catch {
    return { valid: false, fieldName };
  }
}

/** Register reputation MCP tools: azeth_submit_opinion, azeth_get_weighted_reputation, azeth_get_net_paid */
export function registerReputationTools(server: McpServer): void {
  // ──────────────────────────────────────────────
  // azeth_submit_opinion
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_submit_opinion',
    {
      description: [
        'Submit payment-gated reputation opinion for an agent or service on the ERC-8004 Reputation Registry.',
        '',
        'Use this when: You have interacted with an agent/service and want to rate their performance.',
        'Opinion weight is determined by how much you have paid the target in USD (payment-gated).',
        'If you update your opinion for the same agent, the previous entry is automatically revoked.',
        '',
        'Returns: The transaction hash of the opinion submission.',
        '',
        'Note: This is a state-changing on-chain operation via the Azeth ReputationModule.',
        'The rating field is a number from -100 to 100 (supports decimals like 85.5).',
        'Stored on-chain in WAD format (18-decimal) for consistent aggregation.',
        'You must have a minimum USD payment to the target (payment-gated).',
        'Tags allow categorization (e.g., tag1="quality", tag2="x402").',
        'The submitter account is determined by the AZETH_PRIVATE_KEY environment variable.',
        '',
        'Example: { "agentId": "1024", "rating": 85, "tag1": "quality", "tag2": "x402" }',
        'Example (negative): { "agentId": "1024", "rating": -50, "tag1": "reliability", "tag2": "downtime" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        agentId: z.string().regex(/^\d+$/, 'Must be a non-negative integer string').describe('Target agent\'s ERC-8004 token ID (numeric string).'),
        rating: z.number().min(-100).max(100).describe('Rating from -100 to 100 (supports decimals like 85.5). Stored on-chain in WAD (18-decimal) format.'),
        tag1: z.string().max(64).regex(/^[\x20-\x7E]*$/, 'ASCII printable characters only').default('quality').describe('Primary categorization tag (e.g., "quality", "uptime", "speed"). Default: "quality".'),
        tag2: z.string().max(64).regex(/^[\x20-\x7E]*$/, 'ASCII printable characters only').default('').describe('Secondary categorization tag (e.g., "x402", "rpc", "swap").'),
        endpoint: z.string().max(2048).default('').describe('Service endpoint being rated (optional).'),
        opinionURI: z.string().max(2048).default('').describe('URI containing detailed opinion data (optional).'),
        opinionHash: z.string()
          .regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a valid bytes32 hex string (0x + 64 hex chars)')
          .default('0x0000000000000000000000000000000000000000000000000000000000000000')
          .describe('Hash of the opinion data for integrity verification (optional, 0x-prefixed bytes32).'),
      }),
    },
    async (args) => {
      const agentIdCheck = validateUint256(args.agentId, 'agentId');
      if (!agentIdCheck.valid) {
        return error('INVALID_INPUT', `${agentIdCheck.fieldName} exceeds maximum uint256 value`);
      }

      // Convert rating (-100 to 100, supports decimals) to WAD (18-decimal) on-chain value
      // e.g., rating=85 → value=85e18, rating=85.5 → value=85.5e18
      const wadValue = BigInt(Math.round(args.rating * 1e18));

      let client;
      try {
        client = await createClient(args.chain);
        const txHash = await client.submitOpinion({
          agentId: agentIdCheck.bigint,
          value: wadValue,
          valueDecimals: 18,  // Always WAD
          tag1: args.tag1,
          tag2: args.tag2,
          endpoint: args.endpoint,
          opinionURI: args.opinionURI,
          opinionHash: args.opinionHash as `0x${string}`,
        });

        return success(
          {
            txHash,
            agentId: args.agentId,
            rating: args.rating,
            ratingScale: '[-100, 100]',
            tag1: args.tag1,
            tag2: args.tag2,
            onChainEncoding: {
              value: wadValue.toString(),
              valueDecimals: 18,
              format: 'WAD (18-decimal)',
            },
          },
          { txHash },
        );
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_get_weighted_reputation
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_get_weighted_reputation',
    {
      description: [
        'Get USD-weighted reputation for an agent from the on-chain ReputationModule.',
        '',
        'Use this when: You want to check the reputation of an agent or service before interacting.',
        'Returns a weighted average where each rater\'s influence is proportional to their USD payment to the agent.',
        '',
        'Returns: Weighted reputation with weightedValue (int256), totalWeight, and opinionCount.',
        '',
        'Note: This is a read-only on-chain query. No private key or gas is required.',
        'Leave raters empty to aggregate across all raters who have submitted opinions.',
        '',
        'Example: { "agentId": "1024" } or { "agentId": "1024", "raters": ["0x1234...abcd"] }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        agentId: z.string().regex(/^\d+$/, 'Must be a non-negative integer string').describe('Target agent\'s ERC-8004 token ID (numeric string).'),
        raters: z.preprocess(
          (val) => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(
            z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Each rater must be a valid Ethereum address'),
          ).default([]),
        ).describe('Specific rater addresses to include (optional). Empty = all raters.'),
      }),
    },
    async (args) => {
      const agentIdCheck = validateUint256(args.agentId, 'agentId');
      if (!agentIdCheck.valid) {
        return error('INVALID_INPUT', `${agentIdCheck.fieldName} exceeds maximum uint256 value`);
      }

      try {
        const { createPublicClient, http } = await import('viem');

        const resolved = resolveChain(args.chain);
        const chain = resolveViemChain(resolved);
        const rpcUrl = process.env['AZETH_RPC_URL'];

        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl),
        });

        const moduleAddress = AZETH_CONTRACTS[resolved].reputationModule;
        if (!moduleAddress || moduleAddress === ('' as `0x${string}`)) {
          return error('NETWORK_ERROR', `ReputationModule not deployed on ${resolved}.`, 'Deploy the ReputationModule first or switch to baseSepolia.');
        }

        // Check if the token ID exists on the trust registry before querying reputation
        const trustRegistryAddr = AZETH_CONTRACTS[resolved].trustRegistryModule;
        if (trustRegistryAddr && trustRegistryAddr !== ('' as `0x${string}`)) {
          try {
            const accountAddr = await publicClient.readContract({
              address: trustRegistryAddr,
              abi: TrustRegistryModuleAbi,
              functionName: 'getAccountByTokenId',
              args: [agentIdCheck.bigint],
            });
            if (accountAddr === '0x0000000000000000000000000000000000000000') {
              return success({
                agentId: args.agentId,
                weightedValue: '0',
                totalWeight: '0',
                opinionCount: '0',
                warning: `No agent registered with token ID ${args.agentId}. The returned zeros indicate no registration, not a zero reputation.`,
              });
            }
          } catch {
            // getAccountByTokenId may not exist on older deployments — proceed with query
          }
        }

        const raterAddrs = args.raters
          .filter((a): a is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(a));

        let result: readonly [bigint, bigint, bigint];

        if (raterAddrs.length > 0) {
          result = await publicClient.readContract({
            address: moduleAddress,
            abi: ReputationModuleAbi,
            functionName: 'getWeightedReputation',
            args: [agentIdCheck.bigint, raterAddrs],
          }) as readonly [bigint, bigint, bigint];
        } else {
          result = await publicClient.readContract({
            address: moduleAddress,
            abi: ReputationModuleAbi,
            functionName: 'getWeightedReputationAll',
            args: [agentIdCheck.bigint],
          }) as readonly [bigint, bigint, bigint];
        }

        const [weightedValue, totalWeight, opinionCount] = result;

        // Format weighted value: the contract returns values in the same decimal precision
        // as the submitted opinions. For the default MCP submission (valueDecimals=0), this
        // is an integer. For SDK submissions with 18 decimals, format accordingly.
        // Heuristic: if |value| > 10^15, it's likely 18-decimal; otherwise treat as integer.
        const absValue = weightedValue < 0n ? -weightedValue : weightedValue;
        const isHighPrecision = absValue > 10n ** 15n;
        const weightedValueFormatted = isHighPrecision
          ? formatTokenAmount(weightedValue, 18, 4)
          : weightedValue.toString();

        // totalWeight is a dampened dimensionless value: sum of pow2over3(netPaidUSD) across raters.
        // It is NOT USD — do not format as currency. Display as a plain number.
        const totalWeightFormatted = formatTokenAmount(totalWeight, 12, 2);

        return success({
          agentId: args.agentId,
          weightedValue: weightedValue.toString(),
          weightedValueFormatted,
          totalWeight: totalWeight.toString(),
          totalWeightFormatted,
          totalWeightDescription: 'Aggregate economic skin-in-the-game (higher = more payments behind opinions)',
          opinionCount: opinionCount.toString(),
          ratersFilter: raterAddrs.length > 0 ? raterAddrs : '(all raters)',
        });
      } catch (err) {
        return handleError(err);
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_get_net_paid
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_get_net_paid',
    {
      description: [
        'Check how much one account has paid another — either total USD or per-token.',
        '',
        'Use this when: You want to verify payment history between two accounts,',
        'which determines feedback weight in the payment-gated reputation system.',
        '',
        'Two modes:',
        '  • No token (default): Returns total net paid in 18-decimal USD, aggregated',
        '    across all tokens via the on-chain oracle. Always >= 0.',
        '  • With token: Returns the signed per-token delta. Positive = "from" paid more,',
        '    negative = "to" paid more. Use 0x0...0 for native ETH.',
        '',
        '"from" defaults to your own address ("me") if omitted. "to" accepts a name, address, or "me".',
        '',
        'Note: This is a read-only on-chain query. No private key or gas is required',
        '(unless "me" or a name is used for resolution).',
        '',
        'Example: { "to": "Alice" } or { "from": "#1", "to": "Bob", "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        from: z.string().optional().describe('Payer address, name, "me", or "#N" (account index). Defaults to "me" (your first smart account).'),
        to: z.string().describe('Payee address, name, "me", or "#N" (account index).'),
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid Ethereum address (0x + 40 hex chars)').optional().describe('Token address for per-token delta. Omit for total USD across all tokens. Use "0x0000000000000000000000000000000000000000" for native ETH.'),
      }),
    },
    async (args) => {
      try {
        const { createPublicClient, http } = await import('viem');

        const resolved = resolveChain(args.chain);
        const chain = resolveViemChain(resolved);
        const rpcUrl = process.env['AZETH_RPC_URL'];

        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl),
        });

        const moduleAddress = AZETH_CONTRACTS[resolved].reputationModule;
        if (!moduleAddress || moduleAddress === ('' as `0x${string}`)) {
          return error('NETWORK_ERROR', `ReputationModule not deployed on ${resolved}.`, 'Deploy the ReputationModule first or switch to baseSepolia.');
        }

        // Resolve "from" and "to" — support names, "me", "#N"
        const { resolveAddress } = await import('../utils/resolve.js');
        const needsClient = !args.from || !validateAddress(args.from) || !validateAddress(args.to);
        let client;
        if (needsClient) {
          try {
            client = await createClient(resolved);
          } catch {
            // Client creation may fail if no private key; only needed for "me"/name resolution
            if (!args.from || args.from === 'me' || !validateAddress(args.from)) {
              return error('UNAUTHORIZED', '"from" defaults to "me" which requires AZETH_PRIVATE_KEY. Provide an explicit address instead.');
            }
          }
        }

        let fromAddr: `0x${string}`;
        let toAddr: `0x${string}`;
        let resolvedFromInfo: string | undefined;
        let resolvedToInfo: string | undefined;

        try {
          const fromInput = args.from ?? 'me';
          const fromResult = await resolveAddress(fromInput, client, 'account');
          fromAddr = fromResult.address;
          if (fromResult.resolvedFrom) resolvedFromInfo = `"${fromResult.resolvedFrom}" → ${fromResult.address}`;

          const toResult = await resolveAddress(args.to, client, 'account');
          toAddr = toResult.address;
          if (toResult.resolvedFrom) resolvedToInfo = `"${toResult.resolvedFrom}" → ${toResult.address}`;
        } catch (resolveErr) {
          // Fallback: if name resolution fails due to server being down,
          // provide a clear message suggesting explicit addresses.
          if (resolveErr instanceof AzethError && resolveErr.code === 'NETWORK_ERROR') {
            return error(
              'SERVER_UNAVAILABLE',
              `Name resolution failed (server unreachable). Provide explicit addresses instead of names.`,
              'Use azeth_discover_services or azeth_accounts to find addresses, then pass them directly.',
            );
          }
          return handleError(resolveErr);
        } finally {
          try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
        }

        if (args.token) {
          // Per-token mode: signed delta
          const netPaid = await publicClient.readContract({
            address: moduleAddress,
            abi: ReputationModuleAbi,
            functionName: 'getNetPaid',
            args: [fromAddr, toAddr, args.token as `0x${string}`],
          }) as bigint;

          // Format per-token amount
          const { formatTokenAmount } = await import('@azeth/common');
          const { TOKENS } = await import('@azeth/common');
          const tokens = TOKENS[resolved];
          const tokenLower = args.token.toLowerCase();
          let netPaidFormatted: string;
          let symbol: string;
          if (tokenLower === tokens.USDC.toLowerCase()) {
            netPaidFormatted = formatTokenAmount(netPaid, 6, 2);
            symbol = 'USDC';
          } else if (tokenLower === tokens.WETH.toLowerCase() || args.token === '0x0000000000000000000000000000000000000000') {
            netPaidFormatted = formatTokenAmount(netPaid, 18, 6);
            symbol = args.token === '0x0000000000000000000000000000000000000000' ? 'ETH' : 'WETH';
          } else {
            netPaidFormatted = netPaid.toString();
            symbol = 'unknown';
          }

          return success({
            mode: 'perToken',
            from: fromAddr,
            to: toAddr,
            ...(resolvedFromInfo ? { resolvedFrom: resolvedFromInfo } : {}),
            ...(resolvedToInfo ? { resolvedTo: resolvedToInfo } : {}),
            token: args.token,
            netPaid: netPaid.toString(),
            netPaidFormatted: `${netPaidFormatted} ${symbol}`,
            description: `Signed per-token delta. Positive = "${fromAddr}" paid more.`,
          });
        } else {
          // Total USD mode: aggregated across all tokens
          const totalUSD = await publicClient.readContract({
            address: moduleAddress,
            abi: ReputationModuleAbi,
            functionName: 'getTotalNetPaidUSD',
            args: [fromAddr, toAddr],
          }) as bigint;

          const { formatTokenAmount } = await import('@azeth/common');
          const totalNetPaidUSDFormatted = '$' + formatTokenAmount(totalUSD, 18, 2);

          return success({
            mode: 'totalUSD',
            from: fromAddr,
            to: toAddr,
            ...(resolvedFromInfo ? { resolvedFrom: resolvedFromInfo } : {}),
            ...(resolvedToInfo ? { resolvedTo: resolvedToInfo } : {}),
            totalNetPaidUSD: totalUSD.toString(),
            totalNetPaidUSDFormatted,
            description: 'Total net paid in 18-decimal USD, aggregated across all tokens.',
          });
        }
      } catch (err) {
        return handleError(err);
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_get_active_opinion
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_get_active_opinion',
    {
      description: [
        'Check if you have an active reputation opinion for a specific agent.',
        '',
        'Use this when: You want to verify whether you have already submitted a reputation',
        'opinion for an agent before submitting a new one (which would overwrite the existing one).',
        '',
        'The agentId is the ERC-8004 token ID of the agent you want to check.',
        'Use azeth_discover_services or azeth_get_registry_entry to find token IDs.',
        '',
        'Returns: Whether an active opinion exists and its opinion index on the reputation registry.',
        '',
        'This is read-only and safe to call at any time.',
        '',
        'Example: { "agentId": "3" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        agentId: z.string().regex(/^\d+$/).describe('The ERC-8004 token ID of the agent to check your opinion for.'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        // Validate agentId as uint256
        let agentIdBigInt: bigint;
        try {
          agentIdBigInt = BigInt(args.agentId);
          if (agentIdBigInt < 0n) throw new Error('negative');
        } catch {
          return error('INVALID_INPUT', `Invalid agentId "${args.agentId}". Must be a non-negative integer.`);
        }

        // Resolve smart account address — the on-chain mapping is keyed by
        // smart account (msg.sender in the UserOp), not the EOA.
        const account = await client.resolveSmartAccount();
        const result = await client.getActiveOpinion(agentIdBigInt, account);

        return success({
          agentId: args.agentId,
          hasActiveOpinion: result.exists,
          opinionIndex: result.exists ? result.opinionIndex.toString() : null,
          message: result.exists
            ? `You have an active opinion (index ${result.opinionIndex}) for agent #${args.agentId}. Submitting a new opinion will overwrite it.`
            : `No active opinion found for agent #${args.agentId}. You can submit one with azeth_submit_opinion.`,
        });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* M-10 */ }
      }
    },
  );
}
