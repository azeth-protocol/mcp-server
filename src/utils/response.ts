import { AzethError, formatTokenAmount } from '@azeth/common';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { decodeErrorSelector } from './error-selectors.js';

/** Structured success response returned by all MCP tools */
export interface ToolSuccess<T> {
  success: true;
  data: T;
  meta: {
    txHash?: string;
    blockNumber?: number;
    timestamp: string;
  };
}

/** Structured error response returned by all MCP tools */
export interface ToolError {
  success: false;
  error: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

/** Format a successful tool result for MCP */
export function success<T>(data: T, meta?: { txHash?: string; blockNumber?: number }): CallToolResult {
  const result: ToolSuccess<T> = {
    success: true,
    data,
    meta: {
      ...meta,
      timestamp: new Date().toISOString(),
    },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(result, bigintReplacer, 2) }],
  };
}

/** Format an error tool result for MCP */
export function error(code: string, message: string, suggestion?: string): CallToolResult {
  const result: ToolError = {
    success: false,
    error: { code, message, suggestion },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: true,
  };
}

/** Strip URLs, hex data, IP addresses, credentials, file paths, bearer tokens, and internal IDs from error messages */
function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s)]+/g, '[redacted-url]')
    .replace(/0x[0-9a-fA-F]{64,}/g, '[redacted-hex]')
    // Standalone hex strings 32+ chars (e.g., XMTP InboxIDs without 0x prefix)
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted-id]')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '[redacted-ip]')
    // Catch bare hostnames from DNS errors (e.g., "ENOTFOUND api.example.invalid")
    .replace(/\b(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH)\s+\S+/g, '[network-error]')
    .replace(/(?:api[_-]?key|token|secret|password|auth)\s*[:=]\s*\S+/gi, '[redacted-credential]')
    // M-8: Additional sanitization patterns
    .replace(/\/(?:Users|home|root|var|tmp|etc)\/[^\s"')]+/g, '[redacted-path]')
    .replace(/[Bb]earer\s+[A-Za-z0-9\-._~+/]+=*/g, '[redacted-bearer]')
    .replace(/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]');
}

/** Convert an unknown error into a structured MCP error response */
export function handleError(err: unknown): CallToolResult {
  if (err instanceof AzethError) {
    // Defensive: if the AzethError message contains a known contract error selector
    // (e.g., from a bundler wrapping the revert data as text), upgrade the response
    // with the decoded human-readable message.
    const decoded = decodeErrorSelector(err.message);
    if (decoded) {
      return error(
        err.code,
        decoded.message,
        decoded.suggestion ?? getSuggestion(err.code, err.details),
      );
    }
    return error(
      err.code,
      sanitizeErrorMessage(err.message),
      getSuggestion(err.code, err.details),
    );
  }

  if (err instanceof Error) {
    // Attempt to decode contract revert selectors from the error message
    const decoded = decodeErrorSelector(err.message);
    if (decoded) {
      return error('CONTRACT_ERROR', decoded.message, decoded.suggestion ?? getSuggestion('CONTRACT_ERROR'));
    }
    return error('UNKNOWN_ERROR', sanitizeErrorMessage(err.message));
  }

  // M-8: Sanitize the String(err) fallback to prevent leaking sensitive data from non-Error objects
  const stringified = String(err);
  const decoded = decodeErrorSelector(stringified);
  if (decoded) {
    return error('CONTRACT_ERROR', decoded.message, decoded.suggestion ?? getSuggestion('CONTRACT_ERROR'));
  }
  return error('UNKNOWN_ERROR', sanitizeErrorMessage(stringified));
}

/** Provide helpful suggestions for known error codes */
function getSuggestion(code: string, details?: Record<string, unknown>): string | undefined {
  switch (code) {
    case 'BUDGET_EXCEEDED':
      return 'Reduce the transaction amount or increase your daily spending limit via the guardian.';
    case 'GUARDIAN_REJECTED': {
      const reason = details?.reason as string | undefined;
      switch (reason) {
        case 'EXCEEDS_TX_LIMIT':
          return `Single transaction exceeds per-tx USD limit${details?.maxTxAmountUSD ? ` (${String(details.maxTxAmountUSD)})` : ''}. Split into smaller amounts.`;
        case 'EXCEEDS_DAILY_LIMIT':
          return `Would push daily spend past limit${details?.dailySpendLimitUSD ? ` (${String(details.dailySpendLimitUSD)})` : ''}${details?.dailySpentUSD ? `. Already spent: ${String(details.dailySpentUSD)}` : ''}. Wait until tomorrow or increase limit via guardian.`;
        case 'TARGET_NOT_WHITELISTED':
          return 'Target is not in the whitelist. Add via setTokenWhitelist or setProtocolWhitelist.';
        case 'ORACLE_STALE':
          return 'Chainlink price oracle is stale — this is common on testnet (Base Sepolia). Options: (1) use ETH transfers instead of USDC, (2) add a guardian co-signature, or (3) switch to Base mainnet where oracles update regularly.';
        default:
          return 'Blocked by guardian guardrails. Check error details for the specific reason.';
      }
    }
    case 'INSUFFICIENT_BALANCE':
      return details?.balance !== undefined
        ? `Current balance: ${String(details.balance)}. Fund your account before retrying.`
        : 'Fund your account before retrying.';
    case 'SESSION_EXPIRED':
      return 'Create a new session key or re-authenticate.';
    case 'PAYMENT_FAILED': {
      const operation = details?.operation as string | undefined;
      switch (operation) {
        case 'agreement_execution':
          return 'Agreement execution failed. Check payer balance and agreement status with azeth_get_agreement.';
        case 'agreement_creation':
          return 'Failed to create agreement. Verify payee address and ensure the PaymentAgreementModule is installed.';
        case 'agreement_cancel':
          return 'Only the payer (creator) can cancel an agreement.';
        case 'smart_account_x402':
          return 'Smart account x402 payment failed. Common causes: (1) Chainlink oracle stale on testnet — try Base mainnet or ETH transfers, (2) USDC not in token whitelist — use azeth_whitelist_token, (3) insufficient smart account USDC — use azeth_deposit, (4) daily spend limit reached — check with azeth_get_guardrails.';
        default:
          return 'Ensure you have sufficient USDC balance for x402 payments.';
      }
    }
    case 'AGREEMENT_NOT_FOUND':
      return 'Check the agreement ID with azeth_list_agreements. The agreement may have been created under a different account.';
    case 'SERVICE_NOT_FOUND':
      return 'Check the service name or try broader discovery parameters.';
    case 'REGISTRY_ERROR':
      return 'The trust registry may be temporarily unavailable. Retry shortly.';
    case 'CONTRACT_ERROR': {
      const aaCode = details?.aaErrorCode as string | undefined;
      if (aaCode) {
        const aaHints: Record<string, string> = {
          AA21: 'AA21 — account does not exist or is not deployed. Use azeth_create_account first.',
          AA23: 'AA23 — gas estimation failed (possible overflow or contract revert). Check transaction parameters.',
          AA24: 'AA24 — signature validation failed. Check that the signer matches the account owner.',
          AA25: 'AA25 — invalid nonce. The account nonce may be out of sync — retry the operation.',
          AA26: 'AA26 — verificationGasLimit too low. The operation requires more gas than estimated. Retry the operation.',
        };
        return aaHints[aaCode] ?? `ERC-4337 error ${aaCode}. Check bundler logs for details.`;
      }
      return 'On-chain contract execution failed. Check the error details for the specific revert reason.';
    }
    case 'ACCOUNT_NOT_FOUND':
      return 'No account with that name or address was found. Use azeth_accounts to list your accounts, or azeth_discover_services to find registered participants.';
    case 'NETWORK_ERROR': {
      const cause = details?.cause as string | undefined;
      if (cause === 'xmtp') {
        const origErr = details?.originalError as string | undefined;
        if (origErr && /installat/i.test(origErr)) {
          return 'XMTP installation limit reached. Revoke old installations or use a different identity.';
        }
        return 'XMTP messaging is unavailable. Verify XMTP_ENV and XMTP_ENCRYPTION_KEY are set correctly.';
      }
      if (cause === 'dns') return 'DNS resolution failed. Check your network connection and verify the hostname is correct.';
      if (cause === 'server') return 'Azeth server is unreachable. Check AZETH_SERVER_URL or retry later.';
      if (cause === 'bundler') return 'ERC-4337 bundler is unreachable. Check PIMLICO_API_KEY or AZETH_BUNDLER_URL settings.';
      return 'A network request failed. Check your connection and retry.';
    }
    case 'INVALID_INPUT': {
      const matches = details?.matches as Array<{ tokenId: string; owner: string; name: string }> | undefined;
      if (matches && matches.length > 1) {
        const examples = matches.slice(0, 3).map(m => `#token:${m.tokenId}`).join(', ');
        return `Multiple matches found. Use a unique identifier: ${examples}, or provide the full address.`;
      }
      return 'Verify all input parameters match the expected format.';
    }
    case 'UNAUTHORIZED':
      return 'Ensure your private key is correct and you have the required permissions.';
    case 'ACCOUNT_EXISTS':
      return 'An account already exists. Use azeth_accounts to list existing accounts.';
    case 'INSUFFICIENT_PAYMENT':
      return 'You must pay the target at least $1 USD before rating. Payments via azeth_pay, azeth_smart_pay, azeth_transfer, and payment agreements all count. Use azeth_get_net_paid to check your payment history.';
    case 'RECIPIENT_UNREACHABLE':
      return 'The recipient is not reachable on the XMTP network. Use azeth_check_reachability to verify before sending.';
    case 'SERVER_UNAVAILABLE':
      return 'The Azeth server is unreachable. On-chain operations still work. Check AZETH_SERVER_URL or retry later.';
    default:
      return undefined;
  }
}

/** Format a bigint 18-decimal USD amount with adaptive precision.
 *  Shows 2 decimals for normal amounts; falls back to 6 decimals for micro-amounts
 *  that would otherwise round to "$0". */
export function formatUSD(amount: bigint): string {
  if (amount === 0n) return '$0';
  const coarse = formatTokenAmount(amount, 18, 2);
  if (coarse !== '0') return '$' + coarse;
  // Micro-amount: show 6 decimals for transparency
  const fine = formatTokenAmount(amount, 18, 6);
  return fine === '0' ? '<$0.000001' : '$' + fine;
}

/** Generate a guardian-related error response with actionable remediation guidance.
 *  Used when a UserOp fails with AA24 or pre-flight detects GUARDIAN_REQUIRED. */
export function guardianRequiredError(
  reason: string,
  details: {
    operation?: string;
    amount?: string;
    limit?: string;
    guardianAddress?: string;
  },
): CallToolResult {
  const hasGuardianKey = !!process.env['AZETH_GUARDIAN_KEY'];
  const hasAutoSign = process.env['AZETH_GUARDIAN_AUTO_SIGN']?.toLowerCase() === 'true';

  const lines: string[] = [
    `Guardian co-signature required: ${reason}`,
    '',
  ];

  if (details.amount && details.limit) {
    lines.push(`Attempted: ${details.amount}`);
    lines.push(`Standard limit: ${details.limit}`);
    lines.push('');
  }

  if (hasGuardianKey && hasAutoSign) {
    // Auto-sign is ON but operation still failed — indicates key mismatch
    lines.push('AZETH_GUARDIAN_KEY is set with AZETH_GUARDIAN_AUTO_SIGN=true, but the operation still failed.');
    lines.push('The guardian address derived from AZETH_GUARDIAN_KEY may not match the guardian in your account guardrails.');
    lines.push('');
    lines.push('To fix:');
    lines.push('1. Run azeth_get_guardrails to see the guardian address for your account');
    lines.push('2. Verify AZETH_GUARDIAN_KEY derives to that same address');
    lines.push('3. If mismatched, update AZETH_GUARDIAN_KEY or change your account guardian via proposeGuardrailChange (24h timelock)');
  } else if (hasGuardianKey && !hasAutoSign) {
    // Key is available but auto-sign is off — explain how to enable or use XMTP
    lines.push('AZETH_GUARDIAN_KEY is set but AZETH_GUARDIAN_AUTO_SIGN is not enabled.');
    lines.push('The guardian must explicitly approve this operation.');
    lines.push('');
    lines.push('Options:');
    lines.push('1. Enable auto-signing: set AZETH_GUARDIAN_AUTO_SIGN=true in your environment');
    lines.push('   (All operations exceeding standard limits will be auto-approved)');
    lines.push('');
    lines.push('2. Use XMTP interactive approval: the guardian reviews and approves via azeth_guardian_approve');
    lines.push('   (Requires XMTP to be configured on both agent and guardian sides)');
    lines.push('');
    lines.push('3. Split into smaller transactions within your standard limits');
  } else {
    // No guardian key at all
    lines.push('How to resolve:');
    lines.push('');
    lines.push('Option 1 (recommended): Set AZETH_GUARDIAN_KEY + AZETH_GUARDIAN_AUTO_SIGN=true');
    lines.push('  - AZETH_GUARDIAN_KEY: the guardian\'s private key (for auto co-signing)');
    lines.push('  - AZETH_GUARDIAN_AUTO_SIGN=true: enables automatic approval');
    lines.push('  - The key must correspond to the guardian address in your account guardrails');
    lines.push('  - Check your guardian address with: azeth_get_guardrails');
    lines.push('');
    lines.push('Option 2: Set AZETH_GUARDIAN_KEY only (interactive mode)');
    lines.push('  - Guardian reviews each operation via XMTP (azeth_guardian_approve)');
    lines.push('  - Requires XMTP configuration on both sides');
    lines.push('');
    lines.push('Option 3: Lower your spending limits or split into smaller transactions');
    if (details.guardianAddress) {
      lines.push('');
      lines.push(`Guardian address: ${details.guardianAddress}`);
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: true,
  };
}

/** JSON replacer that converts bigint values to strings */
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}
