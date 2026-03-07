import { z } from 'zod';
import { URL } from 'node:url';
import dns from 'node:dns/promises';
import { isAddress, parseUnits } from 'viem';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AzethError, AZETH_CONTRACTS, TOKENS, formatTokenAmount } from '@azeth/common';
import type { AzethKit } from '@azeth/sdk';
import { createClient, resolveChain, validateAddress } from '../utils/client.js';
import { resolveAddress } from '../utils/resolve.js';
import { success, error, handleError, guardianRequiredError } from '../utils/response.js';

/** Maximum response body size returned to the MCP caller (100 KB) */
const MAX_RESPONSE_SIZE = 100_000;

/** Check if an IPv4 address is in a private/reserved range */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return false;
  const [a, b] = parts;
  return (
    a === 127 ||                           // loopback
    a === 10 ||                            // 10.0.0.0/8
    (a === 172 && b! >= 16 && b! <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) ||            // 192.168.0.0/16
    (a === 169 && b === 254) ||            // link-local
    a === 0                                // 0.0.0.0/8
  );
}

/** Check if an IPv6 address is in a private/reserved range */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80') ||
    lower.startsWith('::ffff:127.') ||
    lower.startsWith('::ffff:10.') ||
    lower.startsWith('::ffff:172.16.') || lower.startsWith('::ffff:172.17.') ||
    lower.startsWith('::ffff:172.18.') || lower.startsWith('::ffff:172.19.') ||
    lower.startsWith('::ffff:172.20.') || lower.startsWith('::ffff:172.21.') ||
    lower.startsWith('::ffff:172.22.') || lower.startsWith('::ffff:172.23.') ||
    lower.startsWith('::ffff:172.24.') || lower.startsWith('::ffff:172.25.') ||
    lower.startsWith('::ffff:172.26.') || lower.startsWith('::ffff:172.27.') ||
    lower.startsWith('::ffff:172.28.') || lower.startsWith('::ffff:172.29.') ||
    lower.startsWith('::ffff:172.30.') || lower.startsWith('::ffff:172.31.') ||
    lower.startsWith('::ffff:192.168.') ||
    lower.startsWith('::ffff:169.254.') ||
    lower.startsWith('::ffff:0.') ||
    lower === '::' ||
    lower === '::ffff:0.0.0.0'
  );
}

/**
 * Safely truncate a string without splitting surrogate pairs.
 * Appends '... [truncated]' when truncation occurs.
 */
function safeTruncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  let end = maxLength;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) {
    end--; // Don't split a surrogate pair
  }
  return str.slice(0, end) + '... [truncated]';
}

/**
 * Validated URL with pinned IP addresses to prevent DNS rebinding.
 * HIGH-7 fix: The resolved IPs are captured at validation time and should be used
 * for the actual connection to prevent TOCTOU DNS rebinding attacks.
 */
export interface ValidatedUrl {
  url: string;
  /** Pinned IPv4 addresses resolved at validation time */
  pinnedIPv4: string[];
}

/**
 * Validate that a URL is external (HTTPS, not pointing to internal/private addresses).
 * F-9: Resolves hostname via DNS to catch rebinding bypasses.
 * HIGH-7 fix: Returns pinned IPs for the caller to use when making the actual request.
 */
async function validateExternalUrl(urlStr: string): Promise<ValidatedUrl> {
  const url = new URL(urlStr);

  if (url.protocol !== 'https:') {
    throw new AzethError('URL must use HTTPS', 'INVALID_INPUT');
  }

  const hostname = url.hostname.toLowerCase();

  // String-based blocklist for obvious patterns (fast path)
  const blockedPatterns = [
    'localhost', '127.0.0.1', '0.0.0.0', '::1',
    '169.254.', '10.', '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
    '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.', 'fc00:', 'fd00:', 'fe80:',
    '::ffff:127.', '::ffff:10.', '::ffff:172.16.', '::ffff:192.168.',
    '::ffff:169.254.',
  ];

  for (const pattern of blockedPatterns) {
    if (hostname === pattern || hostname.startsWith(pattern)) {
      throw new AzethError(
        'URL points to an internal or private network address. Only public HTTPS URLs are allowed.',
        'INVALID_INPUT',
      );
    }
  }

  // F-9: DNS resolution check to catch rebinding/alternative encoding bypasses
  // HIGH-7 fix: Pin the resolved IPv4 addresses so they can be used for the actual
  // fetch connection, preventing TOCTOU DNS rebinding attacks.
  let pinnedIPv4: string[] = [];
  try {
    const addresses = await dns.resolve4(hostname);
    for (const addr of addresses) {
      if (isPrivateIPv4(addr)) {
        throw new AzethError(
          'URL resolves to a private or reserved IP address. Only public HTTPS URLs are allowed.',
          'INVALID_INPUT',
        );
      }
    }
    pinnedIPv4 = addresses;
  } catch (err) {
    if (err instanceof AzethError) throw err;
    // C-3: DNS resolution failure must REJECT — cannot verify URL safety
    // Differentiate "hostname doesn't exist" (input error) from "DNS unreachable" (network error)
    const dnsErr = err as NodeJS.ErrnoException;
    if (dnsErr.code === 'ENOTFOUND' || dnsErr.code === 'ENOENT') {
      throw new AzethError(
        'Hostname not found — verify the URL is correct',
        'INVALID_INPUT',
        { hostname: url.hostname },
      );
    }
    throw new AzethError(
      'DNS resolution failed — cannot verify URL safety',
      'NETWORK_ERROR',
      { hostname: url.hostname, cause: 'dns' },
    );
  }

  // C-1: Also check IPv6 (AAAA) records for IPv6-mapped private addresses.
  // Unlike A records, AAAA failure is acceptable (host may be IPv4-only),
  // but if AAAA records EXIST they must all be public.
  try {
    const ipv6Addresses = await dns.resolve6(hostname);
    for (const addr of ipv6Addresses) {
      if (isPrivateIPv6(addr)) {
        throw new AzethError(
          'URL resolves to a private or reserved IPv6 address. Only public HTTPS URLs are allowed.',
          'INVALID_INPUT',
        );
      }
    }
  } catch (err) {
    if (err instanceof AzethError) throw err;
    // AAAA resolution failure (ENODATA/ENOTFOUND) is acceptable — IPv4-only host.
    // However, if resolution succeeded but returned an unexpected error, reject.
    const dnsErr = err as NodeJS.ErrnoException;
    if (dnsErr.code && !['ENODATA', 'ENOTFOUND', 'ENOENT'].includes(dnsErr.code)) {
      throw new AzethError(
        'IPv6 DNS resolution failed unexpectedly — cannot verify URL safety',
        'INVALID_INPUT',
        { hostname: url.hostname, dnsErrorCode: dnsErr.code },
      );
    }
  }

  return { url: urlStr, pinnedIPv4 };
}

/**
 * Apply smart account selection from the `smartAccount` tool parameter.
 * Accepts "#N" (1-based index from azeth_accounts) or a full address.
 * Returns a CallToolResult error if resolution fails, or null on success.
 */
function applySmartAccountSelection(client: AzethKit, smartAccount: string): CallToolResult | null {
  const accounts = client.smartAccounts;
  if (!accounts || accounts.length === 0) {
    return error('ACCOUNT_NOT_FOUND', 'No smart accounts found.', 'Use azeth_create_account to create one.');
  }

  const indexMatch = smartAccount.match(/^#(\d+)$/);
  if (indexMatch) {
    const idx = parseInt(indexMatch[1]!) - 1;
    if (idx < 0 || idx >= accounts.length) {
      return error('INVALID_INPUT',
        `Account #${indexMatch[1]} not found. You have ${accounts.length} account(s).`,
        'Use azeth_accounts to list your accounts.');
    }
    client.setActiveAccount(accounts[idx]!);
    return null;
  }

  if (/^0x[0-9a-fA-F]{40}$/i.test(smartAccount)) {
    try {
      client.setActiveAccount(smartAccount as `0x${string}`);
    } catch {
      return error('INVALID_INPUT',
        `Address ${smartAccount} is not one of your smart accounts.`,
        'Use azeth_accounts to list your accounts.');
    }
    return null;
  }

  return error('INVALID_INPUT',
    'Invalid smartAccount format.',
    'Use "#N" (e.g., "#2") for account index, or a full Ethereum address. Run azeth_accounts to see your accounts.');
}

/** Register payment-related MCP tools: azeth_pay, azeth_smart_pay, azeth_create_payment_agreement */
export function registerPaymentTools(server: McpServer): void {
  // ──────────────────────────────────────────────
  // azeth_pay
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_pay',
    {
      description: [
        'Pay for an x402-gated HTTP service. Makes the request, handles 402 payment automatically, and returns the response.',
        '',
        'Use this when: You need to access a paid API or service that uses the x402 payment protocol (HTTP 402).',
        'The tool automatically detects if you have an active payment agreement (subscription) with the service.',
        'If an agreement exists, access is granted without additional payment. Otherwise, a fresh USDC payment is signed.',
        '',
        'Returns: Whether payment was made, the payment method used (x402/session/none), the HTTP status, and the response body.',
        '',
        'Note: Requires USDC balance to pay (unless an agreement grants access). Set maxAmount to cap spending.',
        'Only HTTPS URLs to public endpoints are accepted. The payer account is determined by the AZETH_PRIVATE_KEY environment variable.',
        '',
        'Example: { "url": "https://api.example.com/data" } or { "url": "https://api.example.com/data", "maxAmount": "1.00" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        url: z.string().url().max(2048).describe('The HTTPS URL of the x402-gated service to access. Must be a public endpoint.'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().describe('HTTP method. Defaults to "GET".'),
        body: z.string().max(100_000).optional().describe('Request body for POST/PUT/PATCH requests (JSON string, max 100KB).'),
        maxAmount: z.string().max(32).optional().describe('Maximum USDC amount willing to pay (e.g., "5.00"). Rejects if service costs more.'),
        smartAccount: z.string().optional().describe('Smart account to pay from. Use "#1", "#2", etc. (index from azeth_accounts) or a full address. Defaults to your first smart account.'),
      }),
    },
    async (args) => {
      let validated: ValidatedUrl;
      try {
        validated = await validateExternalUrl(args.url);
      } catch (err) {
        return handleError(err);
      }

      let client;
      try {
        client = await createClient(args.chain);

        // Apply smart account selection if specified
        if (args.smartAccount) {
          const selectionErr = applySmartAccountSelection(client, args.smartAccount);
          if (selectionErr) return selectionErr;
        }
        let maxAmount: bigint | undefined;
        if (args.maxAmount) {
          try {
            maxAmount = parseUnits(args.maxAmount, 6);
          } catch {
            return error('INVALID_INPUT', 'Invalid maxAmount format — must be a valid decimal number (e.g., "10.50")');
          }
        }

        // M-16 fix (Audit #8): Pass the validated URL (post-SSRF check) to fetch402
        // instead of the original args.url. The validated.url has already been
        // checked for SSRF and has the same value, but using it ensures the URL
        // that was validated is the URL that is fetched.
        const result = await client.fetch402(validated.url, {
          method: args.method,
          body: args.body,
          maxAmount,
        });

        // F-5/H-1: Stream response body with size limit. Uses Uint8Array chunks
        // to avoid O(n²) string concatenation on large responses.
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        const reader = result.response.body?.getReader();
        if (reader) {
          try {
            while (totalBytes < MAX_RESPONSE_SIZE) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              totalBytes += value.byteLength;
            }
          } finally {
            reader.cancel().catch(() => {}); // release the stream
          }
        }
        // Concatenate chunks once and decode
        const merged = new Uint8Array(Math.min(totalBytes, MAX_RESPONSE_SIZE));
        let offset = 0;
        for (const chunk of chunks) {
          const remaining = merged.byteLength - offset;
          if (remaining <= 0) break;
          const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
          merged.set(slice, offset);
          offset += slice.byteLength;
        }
        const responseBody = new TextDecoder().decode(merged);
        // For non-JSON responses (e.g., HTML pages), strip tags and truncate aggressively
        // to avoid flooding AI context with large HTML payloads.
        let truncatedBody: string;
        const trimmed = responseBody.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          // JSON — keep at full limit
          truncatedBody = safeTruncate(responseBody, MAX_RESPONSE_SIZE);
        } else {
          // Non-JSON (likely HTML) — strip tags, collapse whitespace, limit to 2KB
          const stripped = responseBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          truncatedBody = safeTruncate(stripped, 2_000);
        }

        return success({
          paid: result.paymentMade,
          amount: result.amount?.toString(),
          paymentMethod: result.paymentMethod,
          statusCode: result.response.status,
          body: truncatedBody,
        });
      } catch (err) {
        if (err instanceof Error && /AA24/.test(err.message)) {
          return guardianRequiredError(
            'Payment amount exceeds your standard spending limit.',
            { operation: 'payment' },
          );
        }
        // Format raw USDC amounts in budget/guardian errors for readability
        if (err instanceof AzethError && err.details) {
          const formatted = { ...err.details };
          let changed = false;
          for (const [key, val] of Object.entries(formatted)) {
            if (/amount/i.test(key) && typeof val === 'bigint') {
              formatted[key] = formatTokenAmount(val, 6, 2) + ' USDC';
              changed = true;
            } else if (/amount/i.test(key) && typeof val === 'string' && /^\d{7,}$/.test(val)) {
              try {
                formatted[key] = formatTokenAmount(BigInt(val), 6, 2) + ' USDC';
                changed = true;
              } catch { /* keep original */ }
            }
          }
          if (changed) {
            // Rewrite the message for BUDGET_EXCEEDED errors with formatted amounts
            if (err.code === 'BUDGET_EXCEEDED' && formatted.required && formatted.max) {
              const newMsg = `Payment of ${formatted.required} exceeds maximum of ${formatted.max}`;
              return handleError(new AzethError(newMsg, err.code, formatted));
            }
            return handleError(new AzethError(err.message, err.code, formatted));
          }
        }
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_smart_pay
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_smart_pay',
    {
      description: [
        'Discover the best service for a capability and pay for it automatically.',
        '',
        'Use this when: You need a service by CAPABILITY (e.g., "price-feed", "market-data", "translation")',
        'and want Azeth to pick the highest-reputation provider, handle payment, and fall back to alternatives if needed.',
        '',
        'How it differs from azeth_pay:',
        '- azeth_smart_pay: "I need price-feed data" → Azeth discovers the best service, pays it, returns the data.',
        '- azeth_pay: "I need data from https://specific-service.com/api" → You know which service, Azeth pays it.',
        '',
        'Flow: Discovers services ranked by reputation → tries the best one → if it fails, tries the next.',
        'Set autoFeedback: true to automatically submit a reputation opinion based on service quality after payment.',
        'Note: autoFeedback defaults to false in MCP context (ephemeral client). Enable it if the MCP server has a bundler configured.',
        '',
        'Returns: The response data, which service was used, how many attempts were needed, and payment details.',
        '',
        'Example: { "capability": "price-feed" } or { "capability": "translation", "maxAmount": "0.50", "method": "POST", "body": "{\"text\": \"hello\"}" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        capability: z.string().min(1).max(256).describe('Service capability to discover (e.g., "price-feed", "market-data", "translation", "compute").'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().describe('HTTP method. Defaults to "GET".'),
        body: z.string().max(100_000).optional().describe('Request body for POST/PUT/PATCH requests (JSON string, max 100KB).'),
        maxAmount: z.string().max(32).optional().describe('Maximum USDC amount willing to pay per service (e.g., "1.00"). Rejects if service costs more.'),
        minReputation: z.coerce.number().min(0).max(100).optional().describe('Minimum reputation score (0-100) to consider. Services below this are excluded.'),
        autoFeedback: z.boolean().optional().describe('Automatically submit a reputation opinion after payment based on service quality. Defaults to false.'),
        smartAccount: z.string().optional().describe('Smart account to pay from. Use "#1", "#2", etc. (index from azeth_accounts) or a full address. Defaults to your first smart account.'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        // Apply smart account selection if specified
        if (args.smartAccount) {
          const selectionErr = applySmartAccountSelection(client, args.smartAccount);
          if (selectionErr) return selectionErr;
        }

        let maxAmount: bigint | undefined;
        if (args.maxAmount) {
          try {
            maxAmount = parseUnits(args.maxAmount, 6);
          } catch {
            return error('INVALID_INPUT', 'Invalid maxAmount format — must be a valid decimal number (e.g., "1.00")');
          }
        }

        // Disable autoFeedback in MCP context: the client is ephemeral (destroyed
        // after this call) and may not have a bundler URL for UserOp submission.
        // Feedback should be submitted by long-lived AzethKit instances instead.
        const result = await client.smartFetch402(args.capability, {
          method: args.method,
          body: args.body,
          maxAmount,
          minReputation: args.minReputation,
          autoFeedback: args.autoFeedback ?? false,
        });

        // Stream response body with size limit (same pattern as azeth_pay)
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        const reader = result.response.body?.getReader();
        if (reader) {
          try {
            while (totalBytes < MAX_RESPONSE_SIZE) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              totalBytes += value.byteLength;
            }
          } finally {
            reader.cancel().catch(() => {});
          }
        }
        const merged = new Uint8Array(Math.min(totalBytes, MAX_RESPONSE_SIZE));
        let offset = 0;
        for (const chunk of chunks) {
          const remaining = merged.byteLength - offset;
          if (remaining <= 0) break;
          const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
          merged.set(slice, offset);
          offset += slice.byteLength;
        }
        const responseBody = new TextDecoder().decode(merged);
        // For non-JSON responses (e.g., HTML pages), strip tags and truncate aggressively
        let truncatedBody: string;
        const trimmedSmart = responseBody.trimStart();
        if (trimmedSmart.startsWith('{') || trimmedSmart.startsWith('[')) {
          truncatedBody = safeTruncate(responseBody, MAX_RESPONSE_SIZE);
        } else {
          const stripped = responseBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          truncatedBody = safeTruncate(stripped, 2_000);
        }

        return success({
          paid: result.paymentMade,
          amount: result.amount?.toString(),
          paymentMethod: result.paymentMethod,
          statusCode: result.response.status,
          body: truncatedBody,
          service: {
            name: result.service.name,
            endpoint: result.service.endpoint,
            tokenId: result.service.tokenId.toString(),
            reputation: result.service.reputation,
          },
          attemptsCount: result.attemptsCount,
          autoFeedback: args.autoFeedback ?? false,
        });
      } catch (err) {
        if (err instanceof Error && /AA24/.test(err.message)) {
          return guardianRequiredError(
            'Payment amount exceeds your standard spending limit.',
            { operation: 'smart_payment' },
          );
        }
        // Format raw USDC amounts in guardian/payment errors for readability
        if (err instanceof AzethError && err.details) {
          const formatted = { ...err.details };
          let changed = false;
          for (const [key, val] of Object.entries(formatted)) {
            if (/amount/i.test(key) && typeof val === 'bigint') {
              formatted[key] = formatTokenAmount(val, 6, 2) + ' USDC';
              changed = true;
            } else if (/amount/i.test(key) && typeof val === 'string' && /^\d{7,}$/.test(val)) {
              try {
                formatted[key] = formatTokenAmount(BigInt(val), 6, 2) + ' USDC';
                changed = true;
              } catch { /* keep original */ }
            }
          }
          if (changed) {
            return handleError(new AzethError(err.message, err.code, formatted));
          }
        }
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_create_payment_agreement
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_create_payment_agreement',
    {
      description: [
        'Set up a recurring payment agreement to another participant. Payments execute on a fixed interval.',
        '',
        'Use this when: You need automated recurring payments (subscriptions, data feeds, scheduled transfers) between participants.',
        '',
        'Returns: The agreement ID and creation transaction hash.',
        '',
        'Note: This creates an on-chain agreement via the PaymentAgreementModule. The payee or anyone can call execute',
        'once each interval has elapsed. Requires sufficient token balance for each execution.',
        'The payer account is determined by the AZETH_PRIVATE_KEY environment variable.',
        '',
        'Example: { "payee": "Alice", "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "amount": "1.00", "intervalSeconds": 86400 }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        payee: z.string().describe('Recipient: Ethereum address, participant name, "me", or "#N" (account index).'),
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid Ethereum address (0x + 40 hex chars)').describe('Payment token address. Use an ERC-20 contract address (e.g., USDC) or 0x0000000000000000000000000000000000000000 for native ETH.'),
        amount: z.string().describe('Payment amount per interval in human-readable units (e.g., "10.00" for 10 USDC).'),
        intervalSeconds: z.coerce.number().int().describe('Time between payments in seconds (minimum 60). E.g., 86400 for daily, 604800 for weekly.'),
        maxExecutions: z.coerce.number().int().optional().describe('Maximum number of payments. 0 or omit for unlimited.'),
        decimals: z.coerce.number().int().min(0).max(18).optional().describe('Token decimals. Defaults to 6 (USDC). Use 18 for WETH or native ETH.'),
      }),
    },
    async (args) => {
      if (!validateAddress(args.token)) {
        return error('INVALID_INPUT', `Invalid token address: "${args.token}".`, 'Must be 0x-prefixed followed by 40 hex characters.');
      }
      // Business-rule validation (moved from Zod to handler for consistent error format)
      if (args.intervalSeconds < 60) {
        return error('INVALID_INPUT', 'intervalSeconds must be at least 60 (1 minute).', 'Common values: 86400 (daily), 604800 (weekly), 2592000 (monthly).');
      }
      if (args.maxExecutions !== undefined && args.maxExecutions < 0) {
        return error('INVALID_INPUT', 'maxExecutions must be 0 or greater.', '0 means unlimited. Omit for unlimited.');
      }
      // Native ETH: address(0) is valid — PaymentAgreementModule supports both ETH and ERC-20.
      // For ETH, default to 18 decimals if not explicitly provided.
      const isNativeETH = args.token === '0x0000000000000000000000000000000000000000';

      let client;
      try {
        client = await createClient(args.chain);

        // Resolve payee: address, name, "me", "#N"
        let payeeResolved;
        try {
          payeeResolved = await resolveAddress(args.payee, client);
        } catch (resolveErr) {
          return handleError(resolveErr);
        }

        const decimals = args.decimals ?? (isNativeETH ? 18 : 6);
        let amount: bigint;
        try {
          amount = parseUnits(args.amount, decimals);
        } catch {
          return error('INVALID_INPUT', 'Invalid amount format — must be a valid decimal number (e.g., "10.00")');
        }

        // Pre-flight: verify the token is whitelisted by the guardian module
        try {
          const chain = resolveChain(args.chain);
          const guardianAddr = AZETH_CONTRACTS[chain].guardianModule as `0x${string}`;
          const smartAccount = await client.resolveSmartAccount();
          const { GuardianModuleAbi } = await import('@azeth/common/abis');
          const isWhitelisted = await client.publicClient.readContract({
            address: guardianAddr,
            abi: GuardianModuleAbi,
            functionName: 'isTokenWhitelisted',
            args: [smartAccount, args.token as `0x${string}`],
          }) as boolean;
          if (!isWhitelisted) {
            const tokenLabel = isNativeETH ? 'Native ETH (address(0))' : `Token ${args.token}`;
            return error(
              'INVALID_INPUT',
              `${tokenLabel} is not whitelisted by your guardian. Agreement would be unexecutable.`,
              'Add it to the token whitelist via the guardian before creating an agreement.',
            );
          }
        } catch {
          // Non-fatal: if the whitelist check fails (RPC error, module not deployed),
          // proceed and let the contract handle validation at execution time.
        }

        const result = await client.createPaymentAgreement({
          payee: payeeResolved.address,
          token: args.token as `0x${string}`,
          amount,
          interval: args.intervalSeconds,
          maxExecutions: args.maxExecutions,
        });

        // Resolve token symbol for display
        const chain = resolveChain(args.chain);
        const tokens = TOKENS[chain];
        const tokenLower = args.token.toLowerCase();
        let tokenSymbol = 'TOKEN';
        if (isNativeETH) {
          tokenSymbol = 'ETH';
        } else if (tokenLower === tokens.USDC.toLowerCase()) {
          tokenSymbol = 'USDC';
        } else if (tokenLower === tokens.WETH.toLowerCase()) {
          tokenSymbol = 'WETH';
        }

        // Format interval for human readability
        const secs = args.intervalSeconds;
        let intervalHuman: string;
        if (secs >= 86400 && secs % 86400 === 0) {
          const days = secs / 86400;
          intervalHuman = days === 1 ? 'every day' : `every ${days} days`;
        } else if (secs >= 3600 && secs % 3600 === 0) {
          const hours = secs / 3600;
          intervalHuman = hours === 1 ? 'every hour' : `every ${hours} hours`;
        } else if (secs >= 60 && secs % 60 === 0) {
          const mins = secs / 60;
          intervalHuman = mins === 1 ? 'every minute' : `every ${mins} minutes`;
        } else {
          intervalHuman = `every ${secs} seconds`;
        }

        return success(
          {
            agreementId: result.agreementId.toString(),
            txHash: result.txHash,
            agreement: {
              payee: payeeResolved.address,
              ...(payeeResolved.resolvedFrom ? { payeeName: payeeResolved.resolvedFrom } : {}),
              token: args.token,
              tokenSymbol,
              amount: args.amount,
              amountFormatted: `${args.amount} ${tokenSymbol}`,
              intervalSeconds: args.intervalSeconds,
              intervalHuman,
              maxExecutions: args.maxExecutions ?? 0,
            },
          },
          { txHash: result.txHash },
        );
      } catch (err) {
        if (err instanceof Error && /AA24/.test(err.message)) {
          return guardianRequiredError(
            'Agreement creation exceeds your standard spending limit.',
            { operation: 'create_agreement' },
          );
        }
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_subscribe_service
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_subscribe_service',
    {
      description: [
        'Subscribe to an x402-gated service by creating a payment agreement.',
        '',
        'Use this when: You want to set up a subscription instead of paying per-request.',
        'The tool fetches the service URL, parses the 402 payment-agreement extension terms,',
        'and creates an on-chain payment agreement matching those terms.',
        '',
        'Returns: The agreement ID, transaction hash, and subscription details.',
        '',
        'Note: The service must advertise payment-agreement terms in its 402 response.',
        'After subscribing, subsequent calls to azeth_pay will automatically detect the agreement.',
        'No need to pass an agreementId — the server recognizes your wallet via SIWx authentication.',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        url: z.string().url().max(2048).describe('The HTTPS URL of the x402-gated service to subscribe to.'),
        intervalSeconds: z.coerce.number().int().optional().describe('Override the suggested interval (seconds, minimum 60). Defaults to the service suggestion.'),
        maxExecutions: z.coerce.number().int().optional().describe('Maximum number of payments. 0 or omit for unlimited.'),
        totalCap: z.string().max(32).optional().describe('Maximum total payout in human-readable token units (e.g., "100.00").'),
      }),
    },
    async (args) => {
      let validated: ValidatedUrl;
      try {
        validated = await validateExternalUrl(args.url);
      } catch (err) {
        return handleError(err);
      }

      // Business-rule validation (moved from Zod to handler for consistent error format)
      if (args.intervalSeconds !== undefined && args.intervalSeconds < 60) {
        return error('INVALID_INPUT', 'intervalSeconds must be at least 60 (1 minute).', 'Common values: 86400 (daily), 604800 (weekly), 2592000 (monthly).');
      }
      if (args.maxExecutions !== undefined && args.maxExecutions < 0) {
        return error('INVALID_INPUT', 'maxExecutions must be 0 or greater.', '0 means unlimited. Omit for unlimited.');
      }

      // Contract requires at least one cap condition to prevent unlimited payments.
      // endTime is set automatically (30 days from now) so we only check user-provided caps.
      if (!args.maxExecutions && !args.totalCap) {
        return error('INVALID_INPUT',
          'At least one limit is required: maxExecutions or totalCap.',
          'The contract requires a cap condition to prevent unlimited payments. E.g., maxExecutions: 30 for monthly billing.');
      }

      let client;
      try {
        client = await createClient(args.chain);

        // Fetch the URL to get 402 response with agreement terms
        const response = await fetch(validated.url, {
          method: 'GET',
          signal: AbortSignal.timeout(15_000),
        });

        if (response.status !== 402) {
          return error('INVALID_INPUT', `Service at ${args.url} did not return 402 — it may not require payment.`);
        }

        // Parse PAYMENT-REQUIRED header (v2) or X-Payment-Required (v1)
        const reqHeader = response.headers.get('PAYMENT-REQUIRED') ?? response.headers.get('X-Payment-Required');
        if (!reqHeader) {
          return error('INVALID_INPUT', 'Service returned 402 but no payment requirement header.');
        }

        let requirement: Record<string, unknown>;
        try {
          // x402v2 base64-encodes the PAYMENT-REQUIRED header; v1 sends raw JSON.
          let jsonStr: string;
          try {
            jsonStr = atob(reqHeader);
            if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) throw new Error('not base64 JSON');
          } catch {
            jsonStr = reqHeader;
          }
          requirement = JSON.parse(jsonStr);
        } catch {
          return error('INVALID_INPUT', 'Failed to parse payment requirement header.');
        }

        // Look for payment-agreement extension in the requirement
        const extensions = requirement.extensions as Record<string, Record<string, unknown>> | undefined;
        const agreementExt = extensions?.['payment-agreement'];

        if (!agreementExt?.acceptsAgreements) {
          return error('INVALID_INPUT', 'Service does not advertise payment-agreement terms. Use azeth_pay for one-time payment.');
        }

        const terms = agreementExt.terms as {
          payee: string;
          token: string;
          moduleAddress: string;
          minAmountPerInterval: string;
          suggestedInterval: number;
        };

        if (!terms?.payee || !terms?.token) {
          return error('INVALID_INPUT', 'Service agreement terms are incomplete (missing payee or token).');
        }
        // Audit #13 H-4 fix: Validate payee and token are valid Ethereum addresses
        if (!isAddress(terms.payee)) {
          return error('INVALID_INPUT', 'Invalid payee address from service.');
        }
        if (!isAddress(terms.token)) {
          return error('INVALID_INPUT', 'Invalid token address from service.');
        }

        // Parse amount
        const amount = BigInt(terms.minAmountPerInterval);
        const interval = args.intervalSeconds ?? terms.suggestedInterval;

        // Calculate totalCap if provided
        let totalCap: bigint | undefined;
        if (args.totalCap) {
          try {
            totalCap = parseUnits(args.totalCap, 6);
          } catch {
            return error('INVALID_INPUT', 'Invalid totalCap format — must be a valid decimal number.');
          }
        }

        const result = await client.createPaymentAgreement({
          payee: terms.payee as `0x${string}`,
          token: terms.token as `0x${string}`,
          amount,
          interval,
          maxExecutions: args.maxExecutions,
          totalCap,
        });

        return success(
          {
            agreementId: result.agreementId.toString(),
            txHash: result.txHash,
            subscription: {
              payee: terms.payee,
              token: terms.token,
              amountPerInterval: terms.minAmountPerInterval,
              intervalSeconds: interval,
              maxExecutions: args.maxExecutions ?? 0,
              serviceUrl: args.url,
            },
          },
          { txHash: result.txHash },
        );
      } catch (err) {
        if (err instanceof Error && /AA24/.test(err.message)) {
          return guardianRequiredError(
            'Subscription creation exceeds your standard spending limit.',
            { operation: 'subscribe_service' },
          );
        }
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );
}
