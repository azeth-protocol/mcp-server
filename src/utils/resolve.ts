import type { AzethKit } from '@azeth/sdk';
import { AzethError, AZETH_CONTRACTS, ERC8004_REGISTRY, RPC_ENV_KEYS, SUPPORTED_CHAINS } from '@azeth/common';
import { TrustRegistryModuleAbi, AzethOracleAbi } from '@azeth/common/abis';
import { validateAddress, resolveChain, resolveViemChain } from './client.js';

/** Minimal ABI for ERC-8004 Identity Registry tokenURI (external contract) */
const ERC8004_TOKEN_URI_ABI = [
  {
    type: 'function' as const,
    name: 'tokenURI',
    inputs: [{ name: 'tokenId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
    stateMutability: 'view' as const,
  },
] as const;

/** Parse an ERC-8004 data: URI to extract the agent name */
function parseAgentName(uri: string): string {
  try {
    if (!uri.startsWith('data:application/json,')) return '(unknown)';
    const jsonStr = decodeURIComponent(uri.slice('data:application/json,'.length));
    const metadata = JSON.parse(jsonStr) as { name?: string };
    return metadata.name ?? '(unknown)';
  } catch {
    return '(unknown)';
  }
}

/** Look up an account's name on-chain via TrustRegistryModule.getTokenId → ERC-8004 tokenURI */
async function lookupAccountName(
  client: AzethKit,
  addr: `0x${string}`,
): Promise<{ name: string; tokenId: string } | null> {
  const chain = resolveChain(process.env['AZETH_CHAIN']);
  const trustRegistryAddr = AZETH_CONTRACTS[chain].trustRegistryModule;
  const identityRegistryAddr = ERC8004_REGISTRY[chain];

  try {
    const tokenId = await client.publicClient.readContract({
      address: trustRegistryAddr,
      abi: TrustRegistryModuleAbi,
      functionName: 'getTokenId',
      args: [addr],
    });

    if (tokenId === 0n) return null;

    try {
      const uri = await client.publicClient.readContract({
        address: identityRegistryAddr,
        abi: ERC8004_TOKEN_URI_ABI,
        functionName: 'tokenURI',
        args: [tokenId],
      });
      return { name: parseAgentName(uri), tokenId: tokenId.toString() };
    } catch {
      return { name: '(registered)', tokenId: tokenId.toString() };
    }
  } catch {
    return null;
  }
}

/** Result of resolving a human-friendly identifier to an on-chain address */
export interface ResolvedAddress {
  address: `0x${string}`;
  /** Original input if it was not already a raw address */
  resolvedFrom?: string;
  /** Trust registry tokenId (when resolved via name) */
  tokenId?: string;
  /** Trust registry name (when resolved via name) */
  name?: string;
}

/**
 * Resolve a human-friendly identifier to an Ethereum address.
 *
 * Resolution order:
 * 1. Raw address (0x...) → returned as-is, no network call
 * 2. "me" → client.resolveSmartAccount() (first smart account)
 * 3. "#token:N" → on-chain ERC-8004 tokenId lookup (unambiguous)
 * 4. "#N" → client.getSmartAccounts()[N-1] (1-indexed)
 * 5. Name string → query server discovery API with exact match
 *    - Deduplicates by owner (keeps highest tokenId per owner)
 *    - 0 matches → SERVICE_NOT_FOUND error
 *    - 1 match → resolved
 *    - Multiple distinct owners → INVALID_INPUT error with disambiguation list
 *
 * @param input - Address, "me", "#token:N", "#N", or a participant name
 * @param client - AzethKit instance (required for "me", "#N", and name resolution)
 */
export async function resolveAddress(
  input: string,
  client?: AzethKit,
  context?: 'service' | 'account',
): Promise<ResolvedAddress> {
  const trimmed = input.trim();

  // 1. Raw address — or malformed hex (starts with 0x but isn't 42 chars)
  if (validateAddress(trimmed)) {
    return { address: trimmed as `0x${string}` };
  }
  if (/^0x/i.test(trimmed)) {
    throw new AzethError(
      `"${trimmed}" looks like an address but is not valid (expected 0x + 40 hex characters).`,
      'INVALID_INPUT',
      { field: 'address', provided: trimmed },
    );
  }

  // 2. "me" — resolve to first smart account
  if (trimmed.toLowerCase() === 'me') {
    if (!client) {
      throw new AzethError(
        '"me" requires a connected client (AZETH_PRIVATE_KEY). Provide an explicit address instead.',
        'UNAUTHORIZED',
      );
    }
    const addr = await client.resolveSmartAccount();
    return { address: addr, resolvedFrom: 'me' };
  }

  // 3. "#token:N" — resolve by ERC-8004 tokenId (unambiguous)
  const tokenMatch = /^#token:(\d+)$/i.exec(trimmed);
  if (tokenMatch) {
    const chain = resolveChain(process.env['AZETH_CHAIN']);
    const trustRegistryAddr = AZETH_CONTRACTS[chain].trustRegistryModule;
    try {
      const { createPublicClient, http } = await import('viem');
      const viemChain = resolveViemChain(chain);
      const rpcUrl = process.env[RPC_ENV_KEYS[chain]] ?? SUPPORTED_CHAINS[chain].rpcDefault;
      const pubClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

      const tokenId = BigInt(tokenMatch[1]!);
      const accountAddr = await pubClient.readContract({
        address: trustRegistryAddr,
        abi: TrustRegistryModuleAbi,
        functionName: 'getAccountByTokenId',
        args: [tokenId],
      }) as `0x${string}`;

      if (accountAddr === '0x0000000000000000000000000000000000000000') {
        throw new AzethError(
          `No participant registered with token ID ${tokenMatch[1]}.`,
          context === 'account' ? 'ACCOUNT_NOT_FOUND' : 'SERVICE_NOT_FOUND',
        );
      }

      return {
        address: accountAddr,
        resolvedFrom: trimmed,
        tokenId: tokenMatch[1]!,
      };
    } catch (err) {
      if (err instanceof AzethError) throw err;
      throw new AzethError(
        `Failed to resolve token ID ${tokenMatch[1]}: ${err instanceof Error ? err.message : String(err)}`,
        'NETWORK_ERROR',
      );
    }
  }

  // 4. "#N" — resolve to Nth smart account (1-indexed)
  const indexMatch = /^#(\d+)$/.exec(trimmed);
  if (indexMatch) {
    if (!client) {
      throw new AzethError(
        `"${trimmed}" requires a connected client (AZETH_PRIVATE_KEY). Provide an explicit address instead.`,
        'UNAUTHORIZED',
      );
    }
    const accounts = await client.getSmartAccounts();
    const idx = parseInt(indexMatch[1]!, 10);
    if (idx < 1 || idx > accounts.length) {
      throw new AzethError(
        `Account index ${idx} is out of range. You have ${accounts.length} account(s): ${accounts.map((a, i) => `#${i + 1}=${a}`).join(', ')}`,
        'INVALID_INPUT',
      );
    }
    return { address: accounts[idx - 1]!, resolvedFrom: trimmed };
  }

  // 4. Name string — query server discovery API, with on-chain fallback
  const serverUrl = process.env['AZETH_SERVER_URL'] ?? 'https://api.azeth.ai';
  const queryParams = new URLSearchParams({ name: trimmed, limit: '10' });
  let matches: Array<{ tokenId: string; owner: string; name: string; capabilities: string[] }>;

  try {
    const response = await fetch(`${serverUrl}/api/v1/registry/discover?${queryParams}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errorCode = response.status >= 400 && response.status < 500 ? 'SERVICE_NOT_FOUND' : 'NETWORK_ERROR';
      throw new AzethError(
        `Discovery API returned ${response.status} while resolving name "${trimmed}"`,
        errorCode,
        { cause: 'server', httpStatus: response.status },
      );
    }

    const body = await response.json() as {
      data: Array<{ tokenId: string | number; owner: string; name: string; capabilities: string[] }>;
    };
    matches = (body.data ?? []).map(d => ({
      tokenId: String(d.tokenId),
      owner: d.owner,
      name: d.name,
      capabilities: d.capabilities,
    }));
  } catch (err) {
    // Fall back to on-chain name resolution for server errors
    const isAzethErr = err instanceof AzethError;
    const isFetchErr = err instanceof TypeError && (err as Error).message.includes('fetch');
    const shouldFallback = isFetchErr || (isAzethErr && ['SERVER_UNAVAILABLE', 'SERVICE_NOT_FOUND', 'NETWORK_ERROR'].includes(err.code));

    if (!shouldFallback) {
      if (isAzethErr) throw err;
      throw err;
    }

    // On-chain fallback: enumerate registry via AzethOracle.discoverRegistry()
    matches = await resolveNameOnChain(trimmed);
  }

  // Deduplicate by owner: when the same owner re-registers with the same name,
  // keep only the entry with the highest tokenId (most recent registration).
  // This mirrors the dedup logic in azeth_discover_services (registry.ts).
  const dedupMap = new Map<string, typeof matches[number]>();
  for (const m of matches) {
    const key = m.owner.toLowerCase();
    const existing = dedupMap.get(key);
    if (!existing || BigInt(m.tokenId) > BigInt(existing.tokenId)) {
      dedupMap.set(key, m);
    }
  }
  const deduped = [...dedupMap.values()];

  // 0 matches
  if (deduped.length === 0) {
    throw new AzethError(
      `No participant named "${trimmed}" found in the trust registry.`,
      context === 'account' ? 'ACCOUNT_NOT_FOUND' : 'SERVICE_NOT_FOUND',
    );
  }

  // 1 match after dedup
  if (deduped.length === 1) {
    const m = deduped[0]!;
    return {
      address: m.owner as `0x${string}`,
      resolvedFrom: trimmed,
      tokenId: m.tokenId,
      name: m.name,
    };
  }

  // Multiple distinct owners — error with disambiguation list
  const disambigList = deduped.map(m =>
    `  - "${m.name}" (tokenId: ${m.tokenId}, address: ${m.owner}, capabilities: [${m.capabilities.join(', ')}])`,
  ).join('\n');

  throw new AzethError(
    `Multiple participants named "${trimmed}" found. Use the address, #token:N, or tokenId directly:\n${disambigList}`,
    'INVALID_INPUT',
    { matches: deduped.map(m => ({ tokenId: m.tokenId, owner: m.owner, name: m.name })) },
  );
}

/** On-chain name resolution fallback via AzethOracle.discoverRegistry().
 *  Enumerates the ERC-8004 Identity Registry and matches by name (case-insensitive). */
async function resolveNameOnChain(
  name: string,
): Promise<Array<{ tokenId: string; owner: string; name: string; capabilities: string[] }>> {
  const { createPublicClient, http } = await import('viem');
  const chain = resolveChain(process.env['AZETH_CHAIN']);
  const viemChain = resolveViemChain(chain);
  const rpcUrl = process.env[RPC_ENV_KEYS[chain]] ?? SUPPORTED_CHAINS[chain].rpcDefault;

  const registryAddress = ERC8004_REGISTRY[chain];
  const oracleAddress = AZETH_CONTRACTS[chain]?.priceOracle;
  if (!registryAddress || !oracleAddress) {
    throw new AzethError(
      `No ERC-8004 registry or AzethOracle configured for ${chain}. Provide an explicit address.`,
      'REGISTRY_ERROR',
    );
  }

  const pubClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const BATCH_SIZE = 1000;
  const nameLower = name.trim().toLowerCase();
  const results: Array<{ tokenId: string; owner: string; name: string; capabilities: string[] }> = [];
  let startId = 0;
  let reachedEnd = false;

  while (!reachedEnd) {
    let snapshots: readonly { tokenId: bigint; owner: `0x${string}`; uri: string; exists: boolean }[];
    let scannedCount: bigint;

    try {
      [snapshots, scannedCount] = await pubClient.readContract({
        address: oracleAddress,
        abi: AzethOracleAbi,
        functionName: 'discoverRegistry',
        args: [registryAddress, BigInt(startId), BigInt(BATCH_SIZE)],
      });
    } catch {
      throw new AzethError(
        `Failed to query on-chain registry for name "${name}". Provide an explicit address instead.`,
        'NETWORK_ERROR',
      );
    }

    for (const snap of snapshots) {
      if (!snap.exists) continue;
      if (!snap.uri.startsWith('data:application/json,')) continue;

      try {
        const jsonStr = decodeURIComponent(snap.uri.slice('data:application/json,'.length));
        const meta = JSON.parse(jsonStr) as { name?: string; capabilities?: string[] };
        const entryName = typeof meta.name === 'string' ? meta.name : '';
        if (entryName.trim().toLowerCase() === nameLower) {
          results.push({
            tokenId: snap.tokenId.toString(),
            owner: snap.owner,
            name: entryName,
            capabilities: Array.isArray(meta.capabilities)
              ? meta.capabilities.filter((c): c is string => typeof c === 'string')
              : [],
          });
        }
      } catch {
        // Malformed metadata — skip
      }
    }

    if (scannedCount < BigInt(BATCH_SIZE)) {
      reachedEnd = true;
    } else {
      startId += BATCH_SIZE;
    }
  }

  return results;
}

/**
 * Resolve a smartAccount field that can be an address, name, "me", or "#N".
 * Looks up owned accounts and matches by name (exact, case-insensitive).
 *
 * @param input - Address, name, "me", "#N", or undefined (defaults to first account)
 * @param client - AzethKit instance
 */
export async function resolveSmartAccount(
  input: string | undefined,
  client: AzethKit,
): Promise<`0x${string}` | undefined> {
  if (!input) return undefined;

  const trimmed = input.trim();

  // Raw address — return as-is
  if (validateAddress(trimmed)) {
    return trimmed as `0x${string}`;
  }

  // "me", "#N", or "#token:N" — same as resolveAddress
  if (trimmed.toLowerCase() === 'me' || /^#\d+$/.test(trimmed) || /^#token:\d+$/i.test(trimmed)) {
    const result = await resolveAddress(trimmed, client);
    return result.address;
  }

  // Name string — look up own accounts by name on-chain
  const accounts = await client.getSmartAccounts();
  if (accounts.length === 0) {
    throw new AzethError(
      'No smart accounts found. Create one first with azeth_create_account.',
      'ACCOUNT_NOT_FOUND',
    );
  }

  const nameLower = trimmed.toLowerCase();

  // Look up each account's name on-chain via TrustRegistryModule + ERC-8004
  const matchedAccounts: Array<{ address: `0x${string}`; name: string; tokenId: string }> = [];
  for (const addr of accounts) {
    const info = await lookupAccountName(client, addr);
    if (info && info.name.trim().toLowerCase() === nameLower) {
      matchedAccounts.push({ address: addr, name: info.name, tokenId: info.tokenId });
    }
  }

  if (matchedAccounts.length === 0) {
    throw new AzethError(
      `No smart account named "${trimmed}" found. Your accounts: ${accounts.map((a, i) => `#${i + 1}=${a}`).join(', ')}`,
      'ACCOUNT_NOT_FOUND',
    );
  }

  if (matchedAccounts.length === 1) {
    return matchedAccounts[0]!.address;
  }

  const list = matchedAccounts.map(m => `  - "${m.name}" (address: ${m.address}, tokenId: ${m.tokenId})`).join('\n');
  throw new AzethError(
    `Multiple of your accounts match "${trimmed}". Use the address directly:\n${list}`,
    'INVALID_INPUT',
  );
}
