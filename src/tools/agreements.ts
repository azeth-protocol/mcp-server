import { z } from 'zod';
import { formatUnits, decodeEventLog } from 'viem';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AzethKit } from '@azeth/sdk';
import { TOKENS, type SupportedChainName } from '@azeth/common';
import { PaymentAgreementModuleAbi } from '@azeth/common/abis';
import { createClient, resolveChain } from '../utils/client.js';
import { resolveAddress, resolveSmartAccount } from '../utils/resolve.js';
import { success, error, handleError, formatUSD, guardianRequiredError } from '../utils/response.js';

// ──────────────────────────────────────────────
// Shared formatting utilities
// ──────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Resolve a token address to a human-readable symbol */
function resolveTokenSymbol(tokenAddress: string, chain: SupportedChainName): string {
  if (tokenAddress === ZERO_ADDRESS) return 'ETH';
  const tokens = TOKENS[chain];
  const lower = tokenAddress.toLowerCase();
  if (lower === tokens.USDC.toLowerCase()) return 'USDC';
  if (lower === tokens.WETH.toLowerCase()) return 'WETH';
  return tokenAddress.slice(0, 6) + '...' + tokenAddress.slice(-4);
}

/** Get the number of decimals for a token */
function tokenDecimals(tokenAddress: string, chain: SupportedChainName): number {
  if (tokenAddress === ZERO_ADDRESS) return 18;
  const tokens = TOKENS[chain];
  const lower = tokenAddress.toLowerCase();
  if (lower === tokens.USDC.toLowerCase()) return 6;
  return 18; // default to 18 for WETH and unknown tokens
}

/** Format an interval in seconds to a human-readable string */
function formatInterval(secs: number): string {
  if (secs >= 86400 && secs % 86400 === 0) {
    const days = secs / 86400;
    return days === 1 ? 'daily' : `every ${days} days`;
  }
  if (secs >= 3600 && secs % 3600 === 0) {
    const hours = secs / 3600;
    return hours === 1 ? 'hourly' : `every ${hours} hours`;
  }
  if (secs >= 60 && secs % 60 === 0) {
    const mins = secs / 60;
    return mins === 1 ? 'every minute' : `every ${mins} minutes`;
  }
  return `every ${secs} seconds`;
}

/** Format a countdown in seconds to human-readable string */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'now (overdue)';
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins} minute${mins > 1 ? 's' : ''} ${secs} seconds` : `${mins} minute${mins > 1 ? 's' : ''}`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return mins > 0 ? `${hours} hour${hours > 1 ? 's' : ''} ${mins} minute${mins > 1 ? 's' : ''}` : `${hours} hour${hours > 1 ? 's' : ''}`;
}

/** Format overdue duration to human-readable string */
function formatOverdue(seconds: number): string {
  if (seconds < 1) return 'just now';
  return formatCountdown(seconds);
}

/** Derive agreement status from on-chain data */
function deriveStatus(
  agreement: { active: boolean; maxExecutions: bigint; executionCount: bigint; endTime: bigint },
  now: bigint,
): 'active' | 'completed' | 'cancelled' | 'expired' {
  if (!agreement.active) {
    if (agreement.maxExecutions !== 0n && agreement.executionCount >= agreement.maxExecutions) {
      return 'completed';
    }
    return 'cancelled';
  }
  if (agreement.endTime !== 0n && agreement.endTime <= now) {
    return 'expired';
  }
  return 'active';
}

/** Convert a token amount to a formatted USD string for known stablecoins.
 *  Returns null for non-stablecoin tokens (ETH/WETH would need an oracle). */
function tokenAmountToUSD(amount: bigint, tokenAddress: string, chain: SupportedChainName): string | null {
  const tokens = TOKENS[chain];
  if (tokenAddress.toLowerCase() === tokens.USDC.toLowerCase()) {
    // USDC is 6 decimals; format as human-readable dollar string
    const usdStr = formatUnits(amount, 6);
    return `$${usdStr}`;
  }
  return null; // ETH/WETH needs oracle — omit rather than show incorrect value
}

/** Attempt reverse-lookup of a payee address to a name via trust registry */
async function lookupPayeeName(
  client: AzethKit,
  payeeAddress: string,
): Promise<string | null> {
  // Best-effort name lookup; failures are silently ignored
  try {
    const chain = resolveChain(process.env['AZETH_CHAIN']);
    const { AZETH_CONTRACTS, ERC8004_REGISTRY } = await import('@azeth/common');
    const { TrustRegistryModuleAbi } = await import('@azeth/common/abis');

    const trustRegistryAddr = AZETH_CONTRACTS[chain].trustRegistryModule;
    const identityRegistryAddr = ERC8004_REGISTRY[chain];

    const tokenId = await client.publicClient.readContract({
      address: trustRegistryAddr,
      abi: TrustRegistryModuleAbi,
      functionName: 'getTokenId',
      args: [payeeAddress as `0x${string}`],
    }) as bigint;

    if (tokenId === 0n) return null;

    const uri = await client.publicClient.readContract({
      address: identityRegistryAddr,
      abi: [{
        type: 'function' as const,
        name: 'tokenURI',
        inputs: [{ name: 'tokenId', type: 'uint256', internalType: 'uint256' }],
        outputs: [{ name: '', type: 'string', internalType: 'string' }],
        stateMutability: 'view' as const,
      }] as const,
      functionName: 'tokenURI',
      args: [tokenId],
    }) as string;

    if (!uri.startsWith('data:application/json,')) return null;
    const jsonStr = decodeURIComponent(uri.slice('data:application/json,'.length));
    const metadata = JSON.parse(jsonStr) as { name?: string };
    return metadata.name ?? null;
  } catch {
    return null;
  }
}

/** Register payment agreement management MCP tools */
export function registerAgreementTools(server: McpServer): void {

  // ──────────────────────────────────────────────
  // azeth_execute_agreement
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_execute_agreement',
    {
      description: [
        'Execute a due payment from an on-chain agreement. Anyone can call this — the payer, payee, or a third-party keeper.',
        '',
        'Use this when: You are a service provider collecting a recurring payment owed to you,',
        'a payer triggering your own agreement manually, or a keeper bot executing due agreements.',
        '',
        'Keeper support: When the "account" is a foreign address (not owned by your private key),',
        'execution routes through your own account or EOA automatically. No special configuration needed.',
        '',
        'The contract validates all conditions on-chain: interval elapsed, active, within caps and limits.',
        'Pro-rata accrual means the payout scales with elapsed time (capped at 3x the interval).',
        '',
        'Returns: Transaction hash, amount paid, execution count, and next execution time.',
        'If the agreement soft-fails (insufficient balance, guardian limit), it returns the failure reason without reverting.',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        account: z.string().describe('The payer smart account whose agreement to execute: Ethereum address, participant name, "me", or "#N".'),
        agreementId: z.coerce.number().int().min(0).describe('The agreement ID to execute (from azeth_create_payment_agreement or azeth_list_agreements).'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);
        const chain = resolveChain(args.chain);

        // Resolve the payer account
        let accountResolved;
        try {
          accountResolved = await resolveAddress(args.account, client);
        } catch (resolveErr) {
          return handleError(resolveErr);
        }

        const account = accountResolved.address;
        const agreementId = BigInt(args.agreementId);

        // Pre-flight check: call canExecutePayment before submitting a transaction
        let canExec: { executable: boolean; reason: string };
        try {
          canExec = await client.canExecutePayment(agreementId, account);
        } catch {
          return error('INVALID_INPUT', `Agreement #${args.agreementId} not found for account ${account}.`, 'Check the agreement ID with azeth_list_agreements.');
        }

        if (!canExec.executable) {
          // Map reason strings to appropriate error codes and messages
          const reason = canExec.reason.toLowerCase();
          if (reason.includes('not initialized') || reason.includes('not found') || reason.includes('agreement not exists')) {
            return error('INVALID_INPUT', `Agreement #${args.agreementId} not found for account ${account}.`, 'Check the agreement ID with azeth_list_agreements.');
          }
          if (reason.includes('not active')) {
            // Get agreement to provide more context
            try {
              const agreement = await client.getAgreement(agreementId, account);
              const now = BigInt(Math.floor(Date.now() / 1000));
              const status = deriveStatus(agreement, now);
              const decimals = tokenDecimals(agreement.token, chain);
              const totalPaid = formatUnits(agreement.totalPaid, decimals);
              const tokenSymbol = resolveTokenSymbol(agreement.token, chain);
              return error('INVALID_INPUT', `Agreement #${args.agreementId} is ${status}. Total paid: ${totalPaid} ${tokenSymbol}.`);
            } catch {
              return error('INVALID_INPUT', `Agreement #${args.agreementId} is not active.`);
            }
          }
          if (reason.includes('interval not elapsed')) {
            try {
              const nextTime = await client.getNextExecutionTime(agreementId, account);
              const nextDate = new Date(Number(nextTime) * 1000).toISOString();
              const now = Math.floor(Date.now() / 1000);
              const countdown = formatCountdown(Number(nextTime) - now);
              return error('INVALID_INPUT', `Agreement #${args.agreementId} is not due yet. Next execution: ${nextDate} (${countdown}).`);
            } catch {
              return error('INVALID_INPUT', `Agreement #${args.agreementId} is not due yet.`);
            }
          }
          if (reason.includes('max executions')) {
            return error('INVALID_INPUT', `Agreement #${args.agreementId} has reached maximum executions.`);
          }
          if (reason.includes('total cap')) {
            return error('INVALID_INPUT', `Agreement #${args.agreementId} has reached its total payment cap.`);
          }
          if (reason.includes('token not whitelisted')) {
            return error('GUARDIAN_REJECTED', `Agreement #${args.agreementId} cannot execute: token not whitelisted by guardian.`, 'Add the token to the guardian whitelist.');
          }
          if (reason.includes('exceeds max tx') || reason.includes('max tx amount')) {
            return error('GUARDIAN_REJECTED', `Agreement #${args.agreementId} cannot execute: payment exceeds per-transaction limit.`, 'Increase the guardian per-tx limit or reduce the agreement amount.');
          }
          if (reason.includes('daily spend') || reason.includes('daily limit')) {
            return error('GUARDIAN_REJECTED', `Agreement #${args.agreementId} cannot execute: daily spend limit exceeded.`, 'Wait until tomorrow or increase the daily limit via guardian.');
          }
          if (reason.includes('insufficient balance') || reason.includes('balance')) {
            return error('INSUFFICIENT_BALANCE', `Agreement #${args.agreementId} cannot execute: insufficient balance.`, 'Fund the payer account before retrying.');
          }
          // Generic fallback
          return error('INVALID_INPUT', `Agreement #${args.agreementId} cannot execute: ${canExec.reason}.`);
        }

        // ── Balance pre-check (non-fatal: proceed if check fails) ──
        const accountAddr = account;
        const agreementIdNum = agreementId;
        try {
          const agreement = await client.getAgreement(agreementIdNum, accountAddr);
          if (agreement) {
            const token = agreement.token;
            const amount = agreement.amount;

            if (token && amount) {
              const ETH_ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;
              let balance: bigint;

              if (token === ETH_ZERO) {
                balance = await client.publicClient.getBalance({ address: accountAddr });
              } else {
                const erc20Abi = [{
                  type: 'function' as const,
                  name: 'balanceOf',
                  inputs: [{ name: 'account', type: 'address' }],
                  outputs: [{ name: '', type: 'uint256' }],
                  stateMutability: 'view' as const,
                }] as const;
                balance = await client.publicClient.readContract({
                  address: token,
                  abi: erc20Abi,
                  functionName: 'balanceOf',
                  args: [accountAddr],
                }) as bigint;
              }

              if (balance < amount) {
                const decimals = tokenDecimals(token, chain);
                return error(
                  'INSUFFICIENT_BALANCE',
                  `Account ${accountAddr} has insufficient balance to execute agreement #${args.agreementId}. ` +
                  `Balance: ${formatUnits(balance, decimals)}, minimum needed: ${formatUnits(amount, decimals)}`,
                  'Deposit more funds into the smart account with azeth_deposit.',
                );
              }
            }
          }
        } catch {
          // Non-fatal: if balance check fails, proceed and let the contract validate
        }

        // Capture pre-execution totalPaid as fallback for delta calculation
        let preExecutionTotal = 0n;
        try {
          const preExecAgreement = await client.getAgreement(agreementId, account);
          preExecutionTotal = preExecAgreement.totalPaid;
        } catch {
          // Non-fatal: delta fallback won't be available
        }

        // Execute the agreement
        const txHash = await client.executeAgreement(agreementId, account);

        // Primary: parse PaymentExecuted event from receipt for exact amount paid
        let executionAmount = 0n;
        try {
          const receipt = await client.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
          for (const log of receipt.logs) {
            try {
              const decoded = decodeEventLog({
                abi: PaymentAgreementModuleAbi,
                data: log.data,
                topics: log.topics,
              });
              if (decoded.eventName === 'PaymentExecuted') {
                const eventArgs = decoded.args as { agreementId: bigint; amount: bigint };
                if (eventArgs.agreementId === agreementId) {
                  executionAmount = eventArgs.amount;
                  break;
                }
              }
            } catch {
              // Not a PaymentExecuted event from this ABI — skip
            }
          }
        } catch {
          // Receipt fetch failed — fall back to delta approach below
        }

        // Enrich response with post-execution state
        const agreement = await client.getAgreement(agreementId, account);
        const decimals = tokenDecimals(agreement.token, chain);
        const tokenSymbol = resolveTokenSymbol(agreement.token, chain);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const status = deriveStatus(agreement, now);

        // Fallback: if event parsing didn't yield an amount, use delta approach
        if (executionAmount === 0n) {
          executionAmount = agreement.totalPaid - preExecutionTotal;
        }

        let nextExecutionTime: string;
        let nextExecutionIn: string;
        if (status !== 'active') {
          nextExecutionTime = 'completed';
          nextExecutionIn = 'N/A (completed)';
        } else {
          try {
            const nextTime = await client.getNextExecutionTime(agreementId, account);
            nextExecutionTime = new Date(Number(nextTime) * 1000).toISOString();
            const nowSecs = Math.floor(Date.now() / 1000);
            nextExecutionIn = formatCountdown(Number(nextTime) - nowSecs);
          } catch {
            nextExecutionTime = 'unknown';
            nextExecutionIn = 'unknown';
          }
        }

        // Attempt payee name resolution
        const payeeName = await lookupPayeeName(client, agreement.payee);

        // USD conversion for stablecoins
        const amountPaidUSD = tokenAmountToUSD(executionAmount, agreement.token, chain);
        const totalPaidUSD = tokenAmountToUSD(agreement.totalPaid, agreement.token, chain);

        return success(
          {
            account,
            agreementId: args.agreementId.toString(),
            payee: agreement.payee,
            ...(payeeName ? { payeeName } : {}),
            token: agreement.token,
            tokenSymbol,
            amountPaid: formatUnits(executionAmount, decimals),
            ...(amountPaidUSD ? { amountPaidUSD } : {}),
            executionCount: agreement.executionCount.toString(),
            maxExecutions: agreement.maxExecutions === 0n ? 'unlimited' : agreement.maxExecutions.toString(),
            totalPaid: formatUnits(agreement.totalPaid, decimals),
            ...(totalPaidUSD ? { totalPaidUSD } : {}),
            totalCap: agreement.totalCap === 0n ? 'unlimited' : formatUnits(agreement.totalCap, decimals),
            remainingBudget: agreement.totalCap === 0n
              ? 'unlimited'
              : formatUnits(agreement.totalCap - agreement.totalPaid, decimals),
            nextExecutionTime,
            nextExecutionIn,
            active: agreement.active,
          },
          { txHash },
        );
      } catch (err) {
        if (err instanceof Error && /AA24/.test(err.message)) {
          return guardianRequiredError(
            'Agreement execution exceeds your standard spending limit.',
            { operation: 'execute_agreement' },
          );
        }
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_cancel_agreement
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_cancel_agreement',
    {
      description: [
        'Cancel an active payment agreement. Only the payer (agreement creator) can cancel.',
        '',
        'Use this when: You want to stop a recurring payment subscription or data feed.',
        'Cancellation is immediate — no timelock, no penalty. Already-paid amounts are not refunded.',
        '',
        'Returns: Transaction hash and final agreement state (total paid, execution count).',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        agreementId: z.coerce.number().int().min(0).describe('The agreement ID to cancel.'),
        smartAccount: z.string().optional().describe('YOUR smart account that owns the agreement: address or "#N". Only your own accounts can be cancelled. Defaults to first smart account.'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);
        const chain = resolveChain(args.chain);

        // Resolve to the caller's OWN smart account (not arbitrary addresses).
        // Only the payer can cancel their own agreements — resolveSmartAccount
        // restricts resolution to accounts owned by the caller's private key.
        let account: `0x${string}`;
        if (args.smartAccount) {
          try {
            const resolved = await resolveSmartAccount(args.smartAccount, client);
            if (!resolved) {
              account = await client.resolveSmartAccount();
            } else {
              account = resolved;
            }
          } catch (resolveErr) {
            return handleError(resolveErr);
          }
        } else {
          account = await client.resolveSmartAccount();
        }

        const agreementId = BigInt(args.agreementId);

        // Pre-flight: check agreement exists and is active
        let agreement;
        try {
          agreement = await client.getAgreement(agreementId, account);
        } catch {
          return error('INVALID_INPUT', `Agreement #${args.agreementId} not found for account ${account}.`, 'Check the agreement ID with azeth_list_agreements.');
        }

        // Zero payee means no agreement exists at this ID for this account
        if (agreement.payee === '0x0000000000000000000000000000000000000000') {
          return error(
            'AGREEMENT_NOT_FOUND',
            `Agreement #${args.agreementId} not found for your account ${account}.`,
            'The agreement may belong to a different account. Use azeth_list_agreements to see your agreements.',
          );
        }

        const now = BigInt(Math.floor(Date.now() / 1000));
        const status = deriveStatus(agreement, now);
        if (status !== 'active') {
          const decimals = tokenDecimals(agreement.token, chain);
          const tokenSymbol = resolveTokenSymbol(agreement.token, chain);
          return error('INVALID_INPUT', `Agreement #${args.agreementId} is already ${status}. Total paid: ${formatUnits(agreement.totalPaid, decimals)} ${tokenSymbol}.`);
        }

        // Cancel
        const txHash = await client.cancelAgreement(agreementId, account);

        // Get final state
        const finalAgreement = await client.getAgreement(agreementId, account);
        const decimals = tokenDecimals(finalAgreement.token, chain);
        const tokenSymbol = resolveTokenSymbol(finalAgreement.token, chain);

        return success(
          {
            agreementId: args.agreementId.toString(),
            status: 'cancelled',
            payee: finalAgreement.payee,
            token: finalAgreement.token,
            tokenSymbol,
            totalPaid: formatUnits(finalAgreement.totalPaid, decimals),
            executionCount: finalAgreement.executionCount.toString(),
            maxExecutions: finalAgreement.maxExecutions === 0n ? 'unlimited' : finalAgreement.maxExecutions.toString(),
          },
          { txHash },
        );
      } catch (err) {
        if (err instanceof Error && /AA24/.test(err.message)) {
          return guardianRequiredError(
            'Agreement cancellation requires guardian co-signature.',
            { operation: 'cancel_agreement' },
          );
        }
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_get_agreement
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_get_agreement',
    {
      description: [
        'View full details of a payment agreement including status, payment history, and next execution time.',
        '',
        'Use this when: You want to inspect an agreement before executing or cancelling it,',
        'verify terms after creation, or check how much has been paid so far.',
        '',
        'Returns: Complete agreement details with human-readable amounts, status, and timing.',
        '',
        'Note: This is a read-only on-chain query. No gas or private key required for the query itself,',
        'but account resolution may need your key if using "me" or "#N".',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        account: z.string().describe('The payer smart account: Ethereum address, participant name, "me", or "#N".'),
        agreementId: z.coerce.number().int().min(0).describe('The agreement ID to query.'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);
        const chain = resolveChain(args.chain);

        let accountResolved;
        try {
          accountResolved = await resolveAddress(args.account, client);
        } catch (resolveErr) {
          return handleError(resolveErr);
        }

        const account = accountResolved.address;
        const agreementId = BigInt(args.agreementId);

        // Single RPC call: agreement + executability + isDue + nextExecutionTime + count
        let data;
        try {
          data = await client.getAgreementData(agreementId, account);
        } catch {
          return error('INVALID_INPUT', `Agreement #${args.agreementId} not found for account ${account}.`, 'Check the agreement ID with azeth_list_agreements.');
        }

        const { agreement, executable, reason, isDue: contractIsDue, nextExecutionTime: nextExecTime } = data;
        const decimals = tokenDecimals(agreement.token, chain);
        const tokenSymbol = resolveTokenSymbol(agreement.token, chain);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const status = deriveStatus(agreement, now);
        const intervalSecs = Number(agreement.interval);

        // Timing
        const lastExecutedAt = agreement.lastExecuted === 0n
          ? null
          : new Date(Number(agreement.lastExecuted) * 1000).toISOString();

        let nextExecutionTime: string;
        let nextExecutionIn: string;
        let isDue = contractIsDue;
        let canExecute = executable;
        let canExecuteReason: string | undefined;

        if (status !== 'active') {
          nextExecutionTime = 'N/A';
          nextExecutionIn = `N/A (${status})`;
          canExecute = false;
          isDue = false;
        } else {
          nextExecutionTime = new Date(Number(nextExecTime) * 1000).toISOString();
          const nowSecs = Math.floor(Date.now() / 1000);
          const diff = Number(nextExecTime) - nowSecs;
          if (diff <= 0) {
            nextExecutionIn = `now (overdue by ${formatOverdue(-diff)})`;
            isDue = true;
          } else {
            nextExecutionIn = formatCountdown(diff);
          }

          if (!executable && reason) {
            canExecuteReason = reason;
          }
        }

        // Payee name resolution
        const payeeName = await lookupPayeeName(client, agreement.payee);

        return success({
          agreementId: args.agreementId.toString(),
          account,
          payee: agreement.payee,
          ...(payeeName ? { payeeName } : {}),
          token: agreement.token,
          tokenSymbol,
          status,
          // Payment terms
          amountPerInterval: formatUnits(agreement.amount, decimals),
          intervalSeconds: intervalSecs,
          intervalHuman: formatInterval(intervalSecs),
          // Execution state
          executionCount: agreement.executionCount.toString(),
          maxExecutions: agreement.maxExecutions === 0n ? 'unlimited' : agreement.maxExecutions.toString(),
          totalPaid: formatUnits(agreement.totalPaid, decimals),
          totalCap: agreement.totalCap === 0n ? 'unlimited' : formatUnits(agreement.totalCap, decimals),
          remainingBudget: agreement.totalCap === 0n
            ? 'unlimited'
            : formatUnits(agreement.totalCap - agreement.totalPaid, decimals),
          // Timing
          lastExecutedAt,
          nextExecutionTime,
          nextExecutionIn,
          expiresAt: agreement.endTime === 0n ? 'never' : new Date(Number(agreement.endTime) * 1000).toISOString(),
          // Checks
          isDue,
          canExecute,
          ...(canExecuteReason ? { canExecuteReason } : {}),
        });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_list_agreements
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_list_agreements',
    {
      description: [
        'List all payment agreements for a smart account with summary status.',
        '',
        'Use this when: You need to find an agreement ID, see all active subscriptions,',
        'check which agreements are due for execution, or get an overview of payment commitments.',
        '',
        'Returns: Array of agreement summaries sorted by ID (newest first), with status and timing.',
        '',
        'Note: This is a read-only on-chain query. Iterates through all agreements for the account.',
        'For accounts with many agreements, this may take a few seconds.',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        account: z.string().optional().describe('Smart account to query: address, name, "me", or "#N". Defaults to "me".'),
        status: z.enum(['all', 'active', 'completed', 'cancelled', 'due']).optional().default('all')
          .describe('Filter by status. "due" shows only agreements ready for execution right now.'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);
        const chain = resolveChain(args.chain);

        // Resolve account (default to "me")
        let account: `0x${string}`;
        try {
          const accountInput = args.account ?? 'me';
          const resolved = await resolveAddress(accountInput, client);
          account = resolved.address;
        } catch (resolveErr) {
          return handleError(resolveErr);
        }

        // Get count from first getAgreementData call (avoids separate getAgreementCount RPC)
        let count: bigint;
        try {
          const firstData = await client.getAgreementData(0n, account);
          count = firstData.count;
        } catch {
          return success({
            account,
            totalAgreements: 0,
            showing: 0,
            filter: args.status ?? 'all',
            agreements: [],
          });
        }

        if (count === 0n) {
          return success({
            account,
            totalAgreements: 0,
            showing: 0,
            filter: args.status ?? 'all',
            agreements: [],
          });
        }

        const now = BigInt(Math.floor(Date.now() / 1000));
        const statusFilter = args.status ?? 'all';
        const agreements: Array<Record<string, unknown>> = [];

        // Iterate from newest to oldest — 1 RPC per agreement via getAgreementData
        for (let i = Number(count) - 1; i >= 0; i--) {
          let data;
          try {
            data = await client.getAgreementData(BigInt(i), account);
          } catch {
            continue;
          }

          const { agreement, executable, isDue: contractIsDue, nextExecutionTime: nextExecTime } = data;
          const decimals = tokenDecimals(agreement.token, chain);
          const tokenSymbol = resolveTokenSymbol(agreement.token, chain);
          const status = deriveStatus(agreement, now);

          // Status filter
          if (statusFilter === 'due') {
            if (status !== 'active' || !contractIsDue) continue;
          } else if (statusFilter !== 'all' && status !== statusFilter) {
            continue;
          }

          // Compute timing for active agreements
          let isDue = contractIsDue;
          let nextExecutionIn: string | undefined;

          if (status === 'active') {
            const nowSecs = Math.floor(Date.now() / 1000);
            const diff = Number(nextExecTime) - nowSecs;
            if (diff <= 0) {
              isDue = true;
              nextExecutionIn = `now (overdue by ${formatOverdue(-diff)})`;
            } else {
              nextExecutionIn = formatCountdown(diff);
            }
          }

          // Payee name (best-effort)
          const payeeName = await lookupPayeeName(client, agreement.payee);

          agreements.push({
            agreementId: i.toString(),
            payee: agreement.payee,
            ...(payeeName ? { payeeName } : {}),
            tokenSymbol,
            amountPerInterval: formatUnits(agreement.amount, decimals),
            intervalHuman: formatInterval(Number(agreement.interval)),
            status,
            executionCount: agreement.executionCount.toString(),
            maxExecutions: agreement.maxExecutions === 0n ? 'unlimited' : agreement.maxExecutions.toString(),
            totalPaid: formatUnits(agreement.totalPaid, decimals),
            ...(isDue !== undefined ? { isDue } : {}),
            ...(nextExecutionIn ? { nextExecutionIn } : {}),
          });
        }

        return success({
          account,
          totalAgreements: Number(count),
          showing: agreements.length,
          filter: statusFilter,
          agreements,
        });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_get_due_agreements
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_get_due_agreements',
    {
      description: [
        'Find all payment agreements that are due for execution across one or more accounts.',
        '',
        'Use this when: You are a keeper bot looking for agreements to execute,',
        'or a service provider checking which of your customers\' payments are collectible.',
        '',
        'Returns: Array of due agreements with payer account, agreement ID, and expected payout.',
        'Each entry can be passed directly to azeth_execute_agreement.',
        '',
        'Note: This scans all agreements for the specified accounts. For large-scale keeper operations,',
        'consider filtering by specific accounts rather than scanning all.',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        accounts: z.array(z.string()).min(1).max(20).optional()
          .describe('Accounts to scan: addresses, names, "me", or "#N". Defaults to ["me"].'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);
        const chain = resolveChain(args.chain);

        // Resolve all accounts
        const accountInputs = args.accounts ?? ['me'];
        const resolvedAccounts: Array<{ address: `0x${string}`; name?: string }> = [];

        for (const input of accountInputs) {
          try {
            const resolved = await resolveAddress(input, client);
            resolvedAccounts.push({
              address: resolved.address,
              name: resolved.name ?? resolved.resolvedFrom,
            });
          } catch (resolveErr) {
            return handleError(resolveErr);
          }
        }

        let scannedAgreements = 0;
        const dueAgreements: Array<Record<string, unknown>> = [];

        for (const acct of resolvedAccounts) {
          // Get count from first getAgreementData call (avoids separate getAgreementCount RPC)
          let count: bigint;
          try {
            const firstData = await client.getAgreementData(0n, acct.address);
            count = firstData.count;
          } catch {
            continue;
          }

          for (let i = 0; i < Number(count); i++) {
            scannedAgreements++;
            // Single RPC: agreement + executability + isDue + nextExecutionTime
            let data;
            try {
              data = await client.getAgreementData(BigInt(i), acct.address);
            } catch {
              continue;
            }

            const { agreement, executable, isDue, nextExecutionTime: nextExecTime } = data;
            if (!agreement.active) continue;
            if (!executable || !isDue) continue;

            const decimals = tokenDecimals(agreement.token, chain);
            const tokenSymbol = resolveTokenSymbol(agreement.token, chain);

            // Estimate payout (pro-rata based on elapsed time)
            const nowSecs = BigInt(Math.floor(Date.now() / 1000));
            const elapsed = agreement.lastExecuted === 0n
              ? agreement.interval // first execution: assume full interval
              : nowSecs - agreement.lastExecuted;
            const estimatedPayout = elapsed > 0n
              ? (agreement.amount * elapsed) / agreement.interval
              : agreement.amount;
            // Cap at 3x interval (max accrual multiplier)
            const cappedPayout = estimatedPayout > agreement.amount * 3n
              ? agreement.amount * 3n
              : estimatedPayout;

            // Calculate overdue from nextExecutionTime (already available, no extra RPC)
            let overdueBy: string | undefined;
            const diff = Math.floor(Date.now() / 1000) - Number(nextExecTime);
            if (diff > 0) {
              overdueBy = formatOverdue(diff);
            }

            // Payee name
            const payeeName = await lookupPayeeName(client, agreement.payee);

            dueAgreements.push({
              account: acct.address,
              ...(acct.name ? { accountName: acct.name } : {}),
              agreementId: i.toString(),
              payee: agreement.payee,
              ...(payeeName ? { payeeName } : {}),
              tokenSymbol,
              estimatedPayout: formatUnits(cappedPayout, decimals),
              ...(overdueBy ? { overdueBy } : {}),
            });
          }
        }

        // Sort by estimated payout descending (highest value first for keeper prioritization)
        dueAgreements.sort((a, b) => {
          const payoutA = parseFloat(a.estimatedPayout as string);
          const payoutB = parseFloat(b.estimatedPayout as string);
          return payoutB - payoutA;
        });

        return success({
          scannedAccounts: resolvedAccounts.length,
          scannedAgreements,
          dueAgreements,
        });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );
}
