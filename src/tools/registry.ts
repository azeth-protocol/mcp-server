import { z } from 'zod';
import { hexToString } from 'viem';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { discoverServicesWithFallback, getRegistryEntry } from '@azeth/sdk';
import { AZETH_CONTRACTS, ERC8004_REGISTRY, formatTokenAmount, CATALOG_MAX_ENTRIES, CATALOG_MAX_PATH_LENGTH } from '@azeth/common';
import type { CatalogEntry, CatalogMethod } from '@azeth/common';
import { TrustRegistryModuleAbi, ReputationModuleAbi } from '@azeth/common/abis';
import { createClient, resolveChain, resolveViemChain, validateAddress } from '../utils/client.js';
import { success, error, handleError } from '../utils/response.js';

/** Minimal ABI for ERC-8004 tokenURI (read-only) */
const ERC8004_TOKEN_URI_ABI = [
  {
    type: 'function' as const,
    name: 'tokenURI',
    inputs: [{ name: 'tokenId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
    stateMutability: 'view' as const,
  },
] as const;

/** Minimal ABI for ERC-721 ownerOf (read-only) */
const ERC721_OWNER_OF_ABI = [
  {
    type: 'function' as const,
    name: 'ownerOf',
    inputs: [{ name: 'tokenId', type: 'uint256', internalType: 'uint256' }],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view' as const,
  },
] as const;

/** Minimal ABI for ERC-8004 getMetadata (read per-key metadata updates) */
const ERC8004_GET_METADATA_ABI = [{
  type: 'function' as const,
  name: 'getMetadata',
  inputs: [
    { name: 'agentId', type: 'uint256', internalType: 'uint256' },
    { name: 'metadataKey', type: 'string', internalType: 'string' },
  ],
  outputs: [{ name: '', type: 'bytes', internalType: 'bytes' }],
  stateMutability: 'view' as const,
}] as const;

/** Metadata keys that can be updated via setMetadata and should overlay tokenURI values.
 *  Note: "catalog" is NOT included — catalogs are off-chain and served from the provider's endpoint. */
const OVERLAY_METADATA_KEYS = ['endpoint', 'description', 'name', 'entityType', 'capabilities', 'pricing'];

/** Overlay per-key metadata updates from getMetadata() onto a parsed registry entry.
 *  The ERC-8004 tokenURI is immutable after minting, but individual keys can be updated
 *  via setMetadata(). This reads those updates and overrides the base entry values. */
async function overlayMetadataUpdates(
  publicClient: { readContract: (args: unknown) => Promise<unknown> },
  registryAddr: `0x${string}`,
  tokenId: bigint,
  entry: Record<string, unknown>,
): Promise<void> {
  await Promise.all(OVERLAY_METADATA_KEYS.map(async (key) => {
    try {
      const raw = await publicClient.readContract({
        address: registryAddr,
        abi: ERC8004_GET_METADATA_ABI,
        functionName: 'getMetadata',
        args: [tokenId, key],
      }) as `0x${string}`;
      if (raw && raw !== '0x') {
        const decoded = hexToString(raw);
        if (decoded) {
          entry[key] = decoded;
        }
      }
    } catch { /* no metadata for this key */ }
  }));
}

/** Parse a raw catalog array from metadata into typed CatalogEntry objects */
function parseCatalogFromMeta(raw: unknown): CatalogEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries: CatalogEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || typeof rec.path !== 'string') continue;
    const entry: CatalogEntry = {
      name: rec.name,
      path: rec.path,
    };
    if (typeof rec.method === 'string') entry.method = rec.method as CatalogMethod;
    if (typeof rec.description === 'string') entry.description = rec.description;
    if (typeof rec.pricing === 'string') entry.pricing = rec.pricing;
    if (typeof rec.mimeType === 'string') entry.mimeType = rec.mimeType;
    if (Array.isArray(rec.capabilities)) {
      entry.capabilities = rec.capabilities.filter((c): c is string => typeof c === 'string');
    }
    if (typeof rec.params === 'object' && rec.params !== null && !Array.isArray(rec.params)) {
      entry.params = rec.params as Record<string, string>;
    }
    if (typeof rec.paid === 'boolean') entry.paid = rec.paid;
    if (Array.isArray(rec.accepts)) {
      entry.accepts = (rec.accepts as Array<Record<string, unknown>>)
        .filter(a => typeof a.network === 'string' && typeof a.asset === 'string')
        .map(a => ({
          network: a.network as string,
          asset: a.asset as `0x${string}`,
          ...(typeof a.symbol === 'string' ? { symbol: a.symbol } : {}),
        }));
    }
    entries.push(entry);
  }
  return entries.length > 0 ? entries : undefined;
}

/** Parse a data:application/json, URI into registry metadata */
function parseRegistryDataURI(uri: string): {
  name: string;
  description: string;
  entityType: string;
  capabilities: string[];
  endpoint?: string;
  pricing?: string;
  catalog?: CatalogEntry[];
} | null {
  try {
    if (!uri.startsWith('data:application/json,')) return null;
    const jsonStr = decodeURIComponent(uri.slice('data:application/json,'.length));
    const meta = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      name: typeof meta.name === 'string' ? meta.name : '',
      description: typeof meta.description === 'string' ? meta.description : '',
      entityType: typeof meta.entityType === 'string' ? meta.entityType : 'agent',
      capabilities: Array.isArray(meta.capabilities)
        ? meta.capabilities.filter((c): c is string => typeof c === 'string')
        : [],
      endpoint: typeof meta.endpoint === 'string' ? meta.endpoint : undefined,
      pricing: typeof meta.pricing === 'string' ? meta.pricing : undefined,
      catalog: parseCatalogFromMeta(meta.catalog),
    };
  } catch {
    return null;
  }
}

/** Register trust registry MCP tools: azeth_publish_service, azeth_discover_services, azeth_get_registry_entry, azeth_update_service */
export function registerRegistryTools(server: McpServer): void {
  // ──────────────────────────────────────────────
  // azeth_publish_service
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_publish_service',
    {
      description: [
        'Register a service, agent, or infrastructure on the ERC-8004 trust registry with metadata and capabilities.',
        '',
        'Use this when: You want to make your agent or service discoverable by other participants in the Azeth network.',
        '',
        'Returns: The trust registry token ID and creation transaction hash.',
        '',
        'Note: This is a state-changing on-chain operation. The token ID is your permanent identity in the trust registry.',
        'Other participants can discover you by capability, entity type, and reputation score.',
        'The account is determined by the AZETH_PRIVATE_KEY environment variable.',
        '',
        'Example: { "name": "MarketOracle", "description": "Real-time market data API", "entityType": "service", "capabilities": ["price-feed", "market-data"], "endpoint": "https://api.example.com" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        name: z.string().min(1).max(256).describe('Display name for this participant in the trust registry.'),
        description: z.string().min(1).max(2048).describe('Human-readable description of what this participant does.'),
        entityType: z.enum(['agent', 'service', 'infrastructure']).describe('Participant type: "agent" (AI agent), "service" (API/oracle), or "infrastructure" (bridge/relay).'),
        capabilities: z.preprocess(
          (val) => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(z.string().max(128)).min(1).max(50),
        ).describe('List of capabilities offered (e.g., ["swap", "price-feed", "translation"]).'),
        endpoint: z.string().url().max(2048)
          .refine(url => url.startsWith('https://') || url.startsWith('http://'), {
            message: 'Endpoint must use HTTP or HTTPS protocol',
          })
          .optional()
          .describe('Optional HTTP endpoint where this participant can be reached.'),
        pricing: z.string().max(256).optional()
          .describe('Listed price for this service (e.g., "$0.01/request", "Free", "$10/month"). Informational — actual x402 settlement price may differ.'),
        catalog: z.preprocess(
          (val) => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(z.object({
            name: z.string().min(1).max(256),
            path: z.string().min(1).max(CATALOG_MAX_PATH_LENGTH),
            method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
            description: z.string().max(1024).optional(),
            pricing: z.string().max(256).optional(),
            mimeType: z.string().max(128).optional(),
            capabilities: z.array(z.string().max(128)).max(20).optional(),
            params: z.record(z.string(), z.string().max(512)).optional(),
            paid: z.boolean().optional(),
            accepts: z.array(z.object({
              network: z.string().min(1).max(64),
              asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<`0x${string}`>,
              symbol: z.string().max(16).optional(),
            })).max(10).optional(),
          })).max(CATALOG_MAX_ENTRIES).optional(),
        ).optional().describe('Off-chain service catalog for multi-service providers. Included in initial registration as a snapshot; providers should serve their live catalog from their endpoint. Each entry: name, path, method (GET/POST/etc), description, pricing, capabilities, params, paid (default true), accepts (multi-chain payment methods).'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        // Check if the smart account is already registered to prevent silent duplicates
        try {
          const chainName = resolveChain(args.chain);
          const trustRegAddr = AZETH_CONTRACTS[chainName].trustRegistryModule as `0x${string}`;
          const smartAccount = await client.resolveSmartAccount();
          const isAlreadyRegistered = await client.publicClient.readContract({
            address: trustRegAddr,
            abi: TrustRegistryModuleAbi,
            functionName: 'isRegistered',
            args: [smartAccount],
          }) as boolean;
          if (isAlreadyRegistered) {
            return error(
              'ACCOUNT_EXISTS',
              'This account is already registered on the trust registry.',
              'Use azeth_update_service to update your existing registration metadata.',
            );
          }
        } catch {
          // Non-fatal: if the check fails (RPC error, module not deployed), proceed anyway
        }

        const result = await client.publishService({
          name: args.name,
          description: args.description,
          entityType: args.entityType,
          capabilities: args.capabilities,
          endpoint: args.endpoint,
          pricing: args.pricing,
          catalog: args.catalog,
        });

        return success(
          {
            tokenId: result.tokenId.toString(),
            txHash: result.txHash,
          },
          { txHash: result.txHash },
        );
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch (e) { process.stderr.write(`[azeth-mcp] destroy error: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_discover_services
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_discover_services',
    {
      description: [
        'Find services, agents, and infrastructure on the trust registry by capability, entity type, and reputation.',
        '',
        'Use this when: You need to find a participant that offers a specific capability (e.g., "swap", "price-feed"),',
        'or you want to browse available services filtered by type and minimum reputation score.',
        '',
        'Returns: Array of registry entries with token ID, owner, entity type, name, capabilities, endpoint, and status.',
        '',
        'Note: This queries the Azeth server API. Set AZETH_SERVER_URL env var if the server is not at the default location.',
        'Results are ranked by reputation score. No private key is required for read-only discovery.',
        '',
        'Example: { "capability": "price-feed" } or { "entityType": "service", "minReputation": 50, "limit": 5 }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        capability: z.string().max(128).optional().describe('Filter by capability (e.g., "swap", "price-feed", "translation").'),
        entityType: z.enum(['agent', 'service', 'infrastructure']).optional().describe('Filter by participant type.'),
        minReputation: z.coerce.number().min(0).max(100).optional().describe('Minimum reputation score (0-100). Higher means more trusted.'),
        limit: z.coerce.number().int().min(1).max(100).optional().describe('Maximum number of results. Defaults to 10.'),
        offset: z.coerce.number().int().min(0).optional().describe('Number of results to skip for pagination. Defaults to 0.'),
      }),
    },
    async (args) => {
      try {
        const serverUrl = process.env['AZETH_SERVER_URL'] ?? 'https://api.azeth.ai';
        const chainName = resolveChain(args.chain);

        // Create a public client for the on-chain fallback
        const { createPublicClient, http } = await import('viem');
        const chain = resolveViemChain(chainName);
        const rpcUrl = process.env['AZETH_RPC_URL'];
        const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

        const result = await discoverServicesWithFallback(
          serverUrl,
          {
            capability: args.capability,
            entityType: args.entityType as 'agent' | 'service' | 'infrastructure' | undefined,
            minReputation: args.minReputation,
            limit: args.limit ?? 10,
            offset: args.offset,
          },
          // Cast needed: viem's chain-specific PublicClient has extra tx types
          // that are a superset of the generic Chain type the SDK expects
          publicClient as any,
          chainName,
        );

        // Deduplicate entries: when the same entity appears multiple times
        // (e.g., registered from both EOA and smart account), keep the entry
        // with the highest tokenId (most recent) per owner+name pair.
        const deduped = new Map<string, typeof result.entries[number]>();
        for (const entry of result.entries) {
          const key = `${entry.owner?.toLowerCase() ?? ''}:${entry.name?.toLowerCase() ?? ''}`;
          const existing = deduped.get(key);
          if (!existing || BigInt(entry.tokenId) > BigInt(existing.tokenId)) {
            deduped.set(key, entry);
          }
        }
        const uniqueEntries = [...deduped.values()];

        // ── Overlay per-key metadata updates for on-chain fallback results ──
        if (result.source === 'on-chain' && uniqueEntries.length <= 10) {
          const overlayRegistryAddr = ERC8004_REGISTRY[chainName] as `0x${string}`;
          await Promise.all(
            uniqueEntries.map(async (entry) => {
              try {
                await overlayMetadataUpdates(publicClient as any, overlayRegistryAddr, BigInt(entry.tokenId), entry as unknown as Record<string, unknown>);
              } catch { /* non-fatal */ }
            }),
          );
        }

        // ── Optional reputation enrichment ──
        // For small result sets (≤10), fetch weighted reputation for each entry.
        // Non-fatal: if reputation is unavailable for any entry, it's set to null.
        const reputationModuleAddr = AZETH_CONTRACTS[chainName].reputationModule;
        const shouldEnrich = uniqueEntries.length <= 10
          && !!reputationModuleAddr
          && reputationModuleAddr !== ('' as `0x${string}`);
        const DEFAULT_REPUTATION = { weightedValue: '0', weightedValueFormatted: '0', totalWeight: '0', totalWeightFormatted: '0', opinionCount: '0' };
        const reputationMap = new Map<string, { weightedValue: string; weightedValueFormatted: string; totalWeight: string; totalWeightFormatted: string; opinionCount: string }>();

        if (shouldEnrich) {
          await Promise.all(
            uniqueEntries.map(async (entry) => {
              try {
                const tid = BigInt(entry.tokenId);
                if (tid === 0n) return;
                const rep = await publicClient.readContract({
                  address: reputationModuleAddr,
                  abi: ReputationModuleAbi,
                  functionName: 'getWeightedReputationAll',
                  args: [tid],
                }) as readonly [bigint, bigint, bigint];
                const [weightedValue, totalWeight, opinionCount] = rep;
                // Format weighted value using same heuristic as reputation.ts
                const absValue = weightedValue < 0n ? -weightedValue : weightedValue;
                const isHighPrecision = absValue > 10n ** 15n;
                const weightedValueFormatted = isHighPrecision
                  ? formatTokenAmount(weightedValue, 18, 4)
                  : weightedValue.toString();
                // Format totalWeight as USD with adaptive precision
                const totalWeightFormatted = formatTokenAmount(totalWeight, 12, 2);
                reputationMap.set(String(entry.tokenId), {
                  weightedValue: weightedValue.toString(),
                  weightedValueFormatted,
                  totalWeight: totalWeight.toString(),
                  totalWeightFormatted,
                  opinionCount: opinionCount.toString(),
                });
              } catch { /* reputation not available for this entry */ }
            }),
          );
        }

        const requestedLimit = args.limit ?? 10;
        // hasMore: true if the API returned a full page (before dedup), suggesting more results exist
        const hasMore = result.entries.length >= requestedLimit;

        return success({
          count: uniqueEntries.length,
          hasMore,
          source: result.source,
          offset: args.offset ?? 0,
          limit: requestedLimit,
          ...(result.minReputationIgnored ? { warning: 'minReputation filter is not supported in on-chain fallback mode and was ignored.' } : {}),
          services: uniqueEntries.map((s) => ({
            tokenId: String(s.tokenId),
            owner: s.owner,
            entityType: s.entityType,
            name: s.name,
            description: s.description ?? '',
            capabilities: s.capabilities,
            endpoint: s.endpoint,
            pricing: s.pricing,
            catalog: s.catalog ?? null,
            active: s.active,
            reputation: reputationMap.get(String(s.tokenId)) ?? (s.reputation ?? DEFAULT_REPUTATION),
          })),
        });
      } catch (err) {
        return handleError(err);
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_get_registry_entry
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_get_registry_entry',
    {
      description: [
        'Look up a specific participant on the trust registry by token ID or smart account address.',
        '',
        'Use this when: You know a specific agent/service address or token ID and want',
        'to see their registration details, capabilities, and reputation.',
        '',
        'Provide EITHER tokenId OR address (at least one required).',
        'If address is provided, it is resolved to a token ID via on-chain lookup.',
        '',
        'Returns: Full registry entry including name, description, entity type,',
        'capabilities, endpoint, and weighted reputation score.',
        '',
        'This is read-only and safe to call at any time.',
        '',
        'Example: { "address": "0x1234..." } or { "tokenId": "5" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        tokenId: z.string().regex(/^\d+$/).optional().describe('ERC-8004 token ID of the participant to look up.'),
        address: z.string().optional().describe('Smart account address of the participant. Resolved to tokenId on-chain.'),
      }),
    },
    async (args) => {
      try {
        if (!args.tokenId && !args.address) {
          return error('INVALID_INPUT', 'Provide at least one of "tokenId" or "address".');
        }

        const chainName = resolveChain(args.chain);
        const serverUrl = process.env['AZETH_SERVER_URL'] ?? 'https://api.azeth.ai';

        // Create a public client for on-chain reads
        const { createPublicClient, http } = await import('viem');
        const viemChain = resolveViemChain(chainName);
        const rpcUrl = process.env['AZETH_RPC_URL'];
        const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

        // Resolve tokenId from address if needed
        let tokenId: bigint;
        let resolvedAddress = args.address as `0x${string}` | undefined;

        if (args.tokenId) {
          tokenId = BigInt(args.tokenId);
        } else {
          // Validate address format
          if (!validateAddress(args.address!)) {
            return error('INVALID_INPUT', `Invalid address: "${args.address}". Expected 0x + 40 hex characters.`);
          }
          const addr = args.address!.trim() as `0x${string}`;
          resolvedAddress = addr;

          const trustRegAddr = AZETH_CONTRACTS[chainName].trustRegistryModule as `0x${string}`;
          try {
            tokenId = await publicClient.readContract({
              address: trustRegAddr,
              abi: TrustRegistryModuleAbi,
              functionName: 'getTokenId',
              args: [addr],
            }) as bigint;
          } catch {
            return error('ACCOUNT_NOT_FOUND', `Could not resolve token ID for address ${addr}. The address may not be registered.`);
          }

          if (tokenId === 0n) {
            return error('ACCOUNT_NOT_FOUND', `Address ${addr} is not registered on the trust registry.`);
          }
        }

        // Try server API first
        let entry: { tokenId: string | number; owner: string; name: string; description: string; entityType: string; capabilities: string[]; endpoint?: string; pricing?: string; catalog?: CatalogEntry[]; active: boolean } | null = null;
        let source: 'server' | 'on-chain' = 'server';

        try {
          const serverEntry = await getRegistryEntry(serverUrl, tokenId);
          if (serverEntry) {
            entry = serverEntry as unknown as typeof entry;
          }
        } catch {
          // Server unavailable — fall back to on-chain
        }

        // On-chain fallback via tokenURI
        if (!entry) {
          source = 'on-chain';
          try {
            const registryAddr = ERC8004_REGISTRY[chainName] as `0x${string}`;
            const uri = await publicClient.readContract({
              address: registryAddr,
              abi: ERC8004_TOKEN_URI_ABI,
              functionName: 'tokenURI',
              args: [tokenId],
            }) as string;

            const meta = parseRegistryDataURI(uri);
            if (meta) {
              // If no address was provided (lookup by tokenId), resolve owner via ownerOf
              let ownerAddress = resolvedAddress ?? '';
              if (!ownerAddress) {
                try {
                  ownerAddress = await publicClient.readContract({
                    address: registryAddr,
                    abi: ERC721_OWNER_OF_ABI,
                    functionName: 'ownerOf',
                    args: [tokenId],
                  }) as `0x${string}`;
                } catch { /* owner resolution failed — leave empty */ }
              }
              entry = {
                tokenId: tokenId.toString(),
                owner: ownerAddress,
                name: meta.name,
                description: meta.description,
                entityType: meta.entityType,
                capabilities: meta.capabilities,
                endpoint: meta.endpoint,
                pricing: meta.pricing,
                catalog: meta.catalog,
                active: true,
              };
            }
          } catch {
            return error('ACCOUNT_NOT_FOUND', `Token ID ${tokenId} not found on the trust registry.`);
          }
        }

        if (!entry) {
          return error('ACCOUNT_NOT_FOUND', `No registry entry found for token ID ${tokenId}.`);
        }

        // Overlay per-key metadata updates (from setMetadata) onto the base entry.
        // This ensures fields updated via azeth_update_service are reflected in reads.
        const registryAddr = ERC8004_REGISTRY[chainName] as `0x${string}`;
        await overlayMetadataUpdates(publicClient as any, registryAddr, tokenId, entry as Record<string, unknown>);

        // Optional reputation enrichment
        let reputation: { weightedValue: string; weightedValueFormatted: string; totalWeight: string; totalWeightFormatted: string; opinionCount: string } = { weightedValue: '0', weightedValueFormatted: '0', totalWeight: '0', totalWeightFormatted: '0', opinionCount: '0' };
        try {
          const repModuleAddr = AZETH_CONTRACTS[chainName].reputationModule;
          if (repModuleAddr) {
            const rep = await publicClient.readContract({
              address: repModuleAddr,
              abi: ReputationModuleAbi,
              functionName: 'getWeightedReputationAll',
              args: [tokenId],
            }) as readonly [bigint, bigint, bigint];
            const [wv, tw, oc] = rep;
            // Format weighted value using same heuristic as reputation.ts
            const absValue = wv < 0n ? -wv : wv;
            const isHighPrecision = absValue > 10n ** 15n;
            const weightedValueFormatted = isHighPrecision
              ? formatTokenAmount(wv, 18, 4)
              : wv.toString();
            // Format totalWeight as USD with adaptive precision
            const totalWeightFormatted = formatTokenAmount(tw, 12, 2);
            reputation = {
              weightedValue: wv.toString(),
              weightedValueFormatted,
              totalWeight: tw.toString(),
              totalWeightFormatted,
              opinionCount: oc.toString(),
            };
          }
        } catch { /* reputation not available — default zeros used */ }

        return success({
          tokenId: tokenId.toString(),
          address: entry.owner || resolvedAddress || null,
          name: entry.name,
          description: entry.description,
          entityType: entry.entityType,
          capabilities: entry.capabilities,
          endpoint: entry.endpoint ?? null,
          pricing: entry.pricing ?? null,
          catalog: entry.catalog ?? null,
          active: entry.active,
          reputation,
          source,
        });
      } catch (err) {
        return handleError(err);
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_update_service
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_update_service',
    {
      description: [
        'Update metadata for your registered service on the trust registry.',
        '',
        'Use this when: You need to change your service endpoint, description, capabilities,',
        'or other metadata after initial registration with azeth_publish_service.',
        '',
        'Supported metadata keys: "endpoint", "description", "capabilities", "name", "entityType", "pricing".',
        'For capabilities, provide a JSON array string (e.g., \'["translation", "nlp"]\').',
        '',
        'Note: Catalogs are off-chain and served from your endpoint. Update your catalog by',
        'updating the response at your endpoint, not via this tool.',
        '',
        'Returns: Confirmation with transaction hash.',
        '',
        'Note: Your account must already be registered on the trust registry.',
        'This requires a transaction (gas cost). Only the account owner can update metadata.',
        '',
        'Example: { "key": "endpoint", "value": "https://api.example.com/v2" }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        key: z.enum(['endpoint', 'description', 'capabilities', 'name', 'entityType', 'pricing']).describe(
          'Metadata key to update.',
        ),
        value: z.string().min(1).max(2048).describe(
          'New value. For "capabilities", provide a JSON array string like \'["translation", "nlp"]\'.',
        ),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        const txHash = await client.updateServiceMetadata(args.key, args.value);

        return success({
          key: args.key,
          value: args.value,
          message: `Service metadata "${args.key}" updated successfully.`,
        }, { txHash });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* M-10 */ }
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_update_service_batch
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_update_service_batch',
    {
      description: [
        'Update multiple metadata fields for your registered service in a single transaction.',
        '',
        'Use this when: You need to change several metadata fields at once (e.g., endpoint + description + capabilities).',
        'This is more gas-efficient than calling azeth_update_service multiple times.',
        '',
        'Supported metadata keys: "endpoint", "description", "capabilities", "name", "entityType", "pricing".',
        'For capabilities, provide a JSON array string (e.g., \'["translation", "nlp"]\').',
        '',
        'Note: Catalogs are off-chain. Update your catalog by updating your endpoint response.',
        '',
        'Returns: Confirmation with a single transaction hash for all updates.',
        '',
        'Note: All updates are atomic — if one fails, none are applied.',
        'Maximum 5 key-value pairs per batch.',
        '',
        'Example: { "updates": [{"key": "endpoint", "value": "https://api.example.com/v2"}, {"key": "description", "value": "Updated service"}] }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional().describe('Target chain. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia", "ethereumSepolia", "ethereum" (and aliases like "base-sepolia", "eth-sepolia", "sepolia", "eth", "mainnet").'),
        updates: z.preprocess(
          (val) => typeof val === 'string' ? JSON.parse(val) : val,
          z.array(z.object({
            key: z.enum(['endpoint', 'description', 'capabilities', 'name', 'entityType', 'pricing']),
            value: z.string().min(1).max(2048),
          })).min(1).max(5),
        ).describe('Array of {key, value} pairs to update. Max 5 updates per batch.'),
      }),
    },
    async (args) => {
      let client;
      try {
        client = await createClient(args.chain);

        const txHash = await client.updateServiceMetadataBatch(
          args.updates as Array<{ key: string; value: string }>,
        );

        return success({
          updates: (args.updates as Array<{ key: string; value: string }>).map(u => ({
            key: u.key,
            value: u.value,
          })),
          count: (args.updates as Array<{ key: string; value: string }>).length,
          message: `${(args.updates as Array<{ key: string; value: string }>).length} metadata field(s) updated in a single transaction.`,
        }, { txHash });
      } catch (err) {
        return handleError(err);
      } finally {
        try { await client?.destroy(); } catch { /* M-10 */ }
      }
    },
  );
}
