import { AzethKit, type AzethKitConfig } from '@azeth/sdk';
import { AzethError, resolveChainAlias, resolveViemChain, type XMTPConfig, type SupportedChainName } from '@azeth/common';

/** Resolve a chain argument to a canonical SupportedChainName.
 *  Resolution order: explicit arg > AZETH_CHAIN env > 'baseSepolia' default.
 *  Accepts aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet".
 */
export function resolveChain(argChain?: string): SupportedChainName {
  const raw = argChain ?? process.env['AZETH_CHAIN'];
  if (!raw) return 'baseSepolia';

  const canonical = resolveChainAlias(raw);
  if (!canonical) {
    throw new AzethError(
      `Unknown chain "${raw}". Supported: "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").`,
      'INVALID_INPUT',
    );
  }
  return canonical;
}

// Re-export for consumers within mcp-server that may still import from here
export { resolveViemChain };

/** Create an AzethKit instance using the private key from the AZETH_PRIVATE_KEY
 *  environment variable. The private key is NEVER accepted as a tool parameter.
 *
 *  After creation, attempts to resolve existing smart account(s) from the factory.
 *  If no accounts exist yet, the smart account will be null (createAccount() sets it).
 *
 *  LOW-6 (Audit): A new AzethKit instance is created per MCP tool call. This is intentionally
 *  stateless — each call gets a fresh client with no shared mutable state, which prevents
 *  cross-request contamination and simplifies error recovery. For production optimization,
 *  a singleton pattern with health-check reconnection could reduce RPC setup overhead per call.
 */
export async function createClient(
  chain?: SupportedChainName | string,
): Promise<AzethKit> {
  const privateKey = process.env['AZETH_PRIVATE_KEY'];
  if (!privateKey) {
    throw new AzethError(
      'AZETH_PRIVATE_KEY environment variable is required. Set it before using Azeth tools.',
      'UNAUTHORIZED',
    );
  }
  if (!validatePrivateKey(privateKey)) {
    throw new AzethError(
      'AZETH_PRIVATE_KEY is malformed. Must be 0x-prefixed followed by 64 hex characters.',
      'UNAUTHORIZED',
    );
  }

  // Guardian co-signing key (optional — enables auto-approval for operations exceeding spending limits)
  const guardianKey = process.env['AZETH_GUARDIAN_KEY'];
  if (guardianKey && !validatePrivateKey(guardianKey)) {
    throw new AzethError(
      'AZETH_GUARDIAN_KEY is malformed. Must be 0x-prefixed followed by 64 hex characters.',
      'UNAUTHORIZED',
    );
  }

  const resolvedChain = resolveChain(chain);

  // Guardian auto-sign: must be explicitly set to "true" to enable.
  // When false (default), operations exceeding limits require interactive guardian approval.
  const guardianAutoSign = process.env['AZETH_GUARDIAN_AUTO_SIGN']?.toLowerCase() === 'true';

  const config: AzethKitConfig = {
    privateKey: privateKey as `0x${string}`,
    chain: resolvedChain,
    serverUrl: process.env['AZETH_SERVER_URL'],
    guardianKey: guardianKey as `0x${string}` | undefined,
    guardianAutoSign,
  };

  const rpcUrl = process.env['AZETH_RPC_URL'];
  if (rpcUrl) {
    config.rpcUrl = rpcUrl;
  }

  const bundlerUrl = process.env['AZETH_BUNDLER_URL'];
  if (bundlerUrl) {
    config.bundlerUrl = bundlerUrl;
  }

  const paymasterUrl = process.env['AZETH_PAYMASTER_URL'];
  if (paymasterUrl) {
    config.paymasterUrl = paymasterUrl;
  }

  // Wire XMTP config from env vars for persistent installations.
  // Without a persistent encryption key, each MCP call creates a new XMTP installation
  // which quickly exhausts the 10-installation-per-inbox limit.
  const xmtpEncryptionKey = process.env['XMTP_ENCRYPTION_KEY'];
  if (xmtpEncryptionKey) {
    const xmtpConfig: XMTPConfig = {
      dbEncryptionKey: xmtpEncryptionKey,
      env: (process.env['XMTP_ENV'] as 'production' | 'dev') ?? 'production',
    };
    const xmtpDbPath = process.env['XMTP_DB_PATH'];
    if (xmtpDbPath) {
      xmtpConfig.dbPath = xmtpDbPath;
    }
    config.xmtp = xmtpConfig;
  }

  const client = await AzethKit.create(config);

  // Auto-resolve smart account(s) if any exist on-chain.
  // Non-fatal: if no account exists yet, callers will get null from .smartAccount
  try {
    await client.getSmartAccounts();
  } catch {
    // No smart accounts deployed yet — fine, createAccount() will set them
  }

  return client;
}

/** Validate that a string looks like a hex private key */
export function validatePrivateKey(key: string): key is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(key.trim());
}

/** Validate that a string looks like an Ethereum address */
export function validateAddress(addr: string): addr is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}
