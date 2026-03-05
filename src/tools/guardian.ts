import { z } from 'zod';
import { formatUnits } from 'viem';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AZETH_CONTRACTS, TOKENS } from '@azeth/common';
import { GuardianModuleAbi } from '@azeth/common/abis';
import { createClient, resolveChain, validateAddress } from '../utils/client.js';
import { resolveSmartAccount } from '../utils/resolve.js';
import { success, error, handleError, guardianRequiredError } from '../utils/response.js';

/** Register guardian MCP tools: azeth_get_guardrails, azeth_whitelist_protocol */
export function registerGuardianTools(server: McpServer): void {
  // ──────────────────────────────────────────────
  // azeth_get_guardrails
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_get_guardrails',
    {
      description: [
        'View the guardian security configuration for a smart account.',
        '',
        'Use this when: You want to check spending limits, token/protocol whitelists,',
        'daily spend tracking, emergency withdrawal status, or pending guardrail changes.',
        '',
        'Returns: Full guardian state including spending limits (USD), whitelisted tokens',
        'and protocols, daily spend progress, and any pending timelock changes.',
        '',
        'This is read-only and safe to call at any time.',
        '',
        'Example: { "smartAccount": "me" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        smartAccount: z.string().optional().describe('Smart account to inspect. Accepts address, "me", "#N", or account name. Defaults to first account.'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        // Resolve smart account (defaults to first)
        let account: `0x${string}`;
        if (args.smartAccount) {
          try {
            account = (await resolveSmartAccount(args.smartAccount, client))!;
          } catch (resolveErr) {
            return handleError(resolveErr);
          }
        } else {
          account = await client.resolveSmartAccount();
        }

        const chain = resolveChain(args.chain);
        const guardianAddr = AZETH_CONTRACTS[chain].guardianModule;

        // Parallel reads for efficiency: guardrails, daily spend, pending changes
        const [guardrails, dailySpentUSD, pendingChange, pendingEmergency] = await Promise.all([
          client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'getGuardrails',
            args: [account],
          }),
          client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'getDailySpentUSD',
            args: [account],
          }),
          client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'getPendingChange',
            args: [account],
          }),
          client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'getPendingEmergency',
            args: [account],
          }),
        ]);

        // Check common token whitelists (ETH, USDC, WETH)
        const ETH = '0x0000000000000000000000000000000000000000' as `0x${string}`;
        const usdc = TOKENS[chain].USDC;
        const weth = TOKENS[chain].WETH;

        // Check common protocol whitelists (Azeth modules)
        const paymentAgreementModule = AZETH_CONTRACTS[chain].paymentAgreementModule;
        const reputationModule = AZETH_CONTRACTS[chain].reputationModule;

        const [
          ethWhitelisted,
          usdcWhitelisted,
          wethWhitelisted,
          paymentAgreementWhitelisted,
          reputationWhitelisted,
        ] = await Promise.all([
          client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'isTokenWhitelisted',
            args: [account, ETH],
          }),
          client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'isTokenWhitelisted',
            args: [account, usdc],
          }),
          client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'isTokenWhitelisted',
            args: [account, weth],
          }),
          client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'isProtocolWhitelisted',
            args: [account, paymentAgreementModule],
          }),
          client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'isProtocolWhitelisted',
            args: [account, reputationModule],
          }),
        ]);

        // Format the Guardrails struct (6 fields from ABI)
        const g = guardrails as {
          maxTxAmountUSD: bigint;
          dailySpendLimitUSD: bigint;
          guardianMaxTxAmountUSD: bigint;
          guardianDailySpendLimitUSD: bigint;
          guardian: `0x${string}`;
          emergencyWithdrawTo: `0x${string}`;
        };

        const dailySpent = dailySpentUSD as bigint;
        const dailyLimit = g.dailySpendLimitUSD;
        const dailyRemaining = dailyLimit > dailySpent ? dailyLimit - dailySpent : 0n;
        const dailyPercentUsed = dailyLimit > 0n
          ? Number((dailySpent * 10000n) / dailyLimit) / 100
          : 0;

        // Format pending change
        const pc = pendingChange as { changeHash: `0x${string}`; executeAfter: bigint; exists: boolean };
        const pe = pendingEmergency as { token: `0x${string}`; executeAfter: bigint; exists: boolean };

        const now = BigInt(Math.floor(Date.now() / 1000));

        return success({
          account,
          spendingLimits: {
            maxTransactionUSD: `$${formatUnits(g.maxTxAmountUSD, 18)}`,
            dailySpendLimitUSD: `$${formatUnits(dailyLimit, 18)}`,
            dailySpentUSD: `$${formatUnits(dailySpent, 18)}`,
            dailyRemainingUSD: `$${formatUnits(dailyRemaining, 18)}`,
            dailyPercentUsed: `${dailyPercentUsed.toFixed(1)}%`,
          },
          guardianLimits: {
            guardianMaxTransactionUSD: `$${formatUnits(g.guardianMaxTxAmountUSD, 18)}`,
            guardianDailySpendLimitUSD: `$${formatUnits(g.guardianDailySpendLimitUSD, 18)}`,
          },
          guardian: g.guardian,
          emergencyWithdrawTo: g.emergencyWithdrawTo,
          tokenWhitelist: {
            ETH: ethWhitelisted as boolean,
            USDC: usdcWhitelisted as boolean,
            WETH: wethWhitelisted as boolean,
          },
          protocolWhitelist: {
            PaymentAgreementModule: paymentAgreementWhitelisted as boolean,
            ReputationModule: reputationWhitelisted as boolean,
          },
          pendingGuardrailChange: pc.exists ? {
            changeHash: pc.changeHash,
            executeAfter: new Date(Number(pc.executeAfter) * 1000).toISOString(),
            readyIn: pc.executeAfter > now
              ? `${Math.ceil(Number(pc.executeAfter - now) / 60)} minutes`
              : 'READY to execute',
          } : null,
          pendingEmergencyWithdrawal: pe.exists ? {
            token: pe.token,
            executeAfter: new Date(Number(pe.executeAfter) * 1000).toISOString(),
            readyIn: pe.executeAfter > now
              ? `${Math.ceil(Number(pe.executeAfter - now) / 60)} minutes`
              : 'READY to execute',
          } : null,
        });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_whitelist_protocol
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_whitelist_protocol',
    {
      description: [
        'Add or remove a protocol (contract address) from your smart account\'s guardian whitelist.',
        '',
        'Use this when: You need to interact with a new DeFi protocol or contract through',
        'executor modules (like PaymentAgreementModule). Protocols must be whitelisted for',
        'automated operations to succeed.',
        '',
        'The "protocol" field must be a valid Ethereum address of the contract to whitelist.',
        '',
        'Returns: Confirmation of the whitelist update with transaction hash.',
        '',
        'Note: This requires a UserOperation (gas). Only the account owner can modify whitelists.',
        'Whitelisting a protocol allows executor modules to interact with it on your behalf.',
        'Whitelist additions require guardian co-signature for security.',
        '',
        'Example: { "protocol": "0x71D52798e3D0f5766f6f0AFEd6710EB5D1FF4DF9", "allowed": true }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        protocol: z.string().describe('Protocol/contract address to whitelist or delist (0x...).'),
        allowed: z.boolean().describe('true to whitelist, false to remove from whitelist.'),
        smartAccount: z.string().optional().describe('Smart account address, name, or "#N". Defaults to first smart account.'),
      }),
    },
    async (args) => {
      if (!validateAddress(args.protocol)) {
        return error('INVALID_INPUT', `Invalid protocol address: "${args.protocol}".`, 'Must be 0x-prefixed followed by 40 hex characters.');
      }

      let client;
      try {
        client = await createClient(args.chain);

        let account: `0x${string}`;
        if (args.smartAccount) {
          try {
            account = (await resolveSmartAccount(args.smartAccount, client))!;
          } catch (resolveErr) {
            return handleError(resolveErr);
          }
        } else {
          account = await client.resolveSmartAccount();
        }

        const txHash = await client.setProtocolWhitelist(
          args.protocol as `0x${string}`,
          args.allowed,
          account,
        );

        const action = args.allowed ? 'whitelisted' : 'removed from whitelist';
        // Resolve protocol name for known Azeth contracts
        const chain = resolveChain(args.chain);
        const contracts = AZETH_CONTRACTS[chain];
        const protocolLower = args.protocol.toLowerCase();
        let protocolName = args.protocol.slice(0, 6) + '...' + args.protocol.slice(-4);
        if (protocolLower === contracts.paymentAgreementModule.toLowerCase()) protocolName = 'PaymentAgreementModule';
        else if (protocolLower === contracts.reputationModule.toLowerCase()) protocolName = 'ReputationModule';
        else if (protocolLower === contracts.trustRegistryModule.toLowerCase()) protocolName = 'TrustRegistryModule';
        else if (protocolLower === contracts.guardianModule.toLowerCase()) protocolName = 'GuardianModule';
        else if (protocolLower === contracts.factory.toLowerCase()) protocolName = 'AzethFactory';

        return success(
          {
            protocol: args.protocol,
            protocolName,
            allowed: args.allowed,
            message: `${protocolName} (${args.protocol}) ${action} on account ${account}.`,
          },
          { txHash },
        );
      } catch (err) {
        // Detect AA24 signature validation failure — common for guardian-gated operations
        if (err instanceof Error && /AA24/.test(err.message)) {
          return guardianRequiredError(
            'Protocol whitelisting requires guardian co-signature (guardrail-loosening change).',
            { operation: 'whitelist_protocol' },
          );
        }
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );
}
