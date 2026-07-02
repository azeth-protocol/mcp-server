import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Account, Chain, Transport, WalletClient } from 'viem';
import { resolveChain, resolveViemChain, validatePrivateKey } from '../utils/client.js';
import { success, error, handleError, formatUSD } from '../utils/response.js';
import {
  buildL2UsdDeltaProof,
  proveL2UsdDelta,
  getCrossChainReputation,
  type CrossChainReputationResult,
} from '@azeth/sdk';
import {
  AZETH_CONTRACTS,
  RPC_ENV_KEYS,
  SUPPORTED_CHAINS,
  type SupportedChainName,
} from '@azeth/common';

/** L2 → L1 verification chain mapping. Only chains listed here can be proven. */
const L1_FOR_L2: Partial<Record<SupportedChainName, SupportedChainName>> = {
  baseSepolia: 'ethereumSepolia',
  base: 'ethereum',
};

/** Per-chain ARCHIVE RPC env vars — proof building needs eth_getProof at the
 *  ~7-day-old anchor block, which public RPCs reject. Falls back to the regular
 *  per-chain RPC env var, then the public default. */
const ARCHIVE_RPC_ENV_KEYS: Record<SupportedChainName, string> = {
  base: 'AZETH_ARCHIVE_RPC_URL_BASE',
  baseSepolia: 'AZETH_ARCHIVE_RPC_URL_BASE_SEPOLIA',
  ethereumSepolia: 'AZETH_ARCHIVE_RPC_URL_ETH_SEPOLIA',
  ethereum: 'AZETH_ARCHIVE_RPC_URL_ETHEREUM',
};

/** Resolve the TrustL2Reader address on the L1 chain, or undefined when not deployed */
function trustL2ReaderFor(l1Name: SupportedChainName): `0x${string}` | undefined {
  const addr = AZETH_CONTRACTS[l1Name].trustL2Reader;
  if (!addr || addr === ('' as `0x${string}`)) return undefined;
  return addr;
}

/** Build the human-readable summary for a cross-chain reputation result */
function buildReputationSummary(r: CrossChainReputationResult): string {
  const registered = r.registeredChainIds.length;

  if (r.totalNetPaidUSD === 0n) {
    const detail = r.chains
      .map((c) =>
        c.proven
          ? `${c.chainName} — proven, $0 net in this direction`
          : `${c.chainName} — no proof submitted`,
      )
      .join('; ');
    return (
      `No L1-proven cross-chain payments from ${r.from} to ${r.to} ` +
      `(${registered} registered chain(s)${detail ? `: ${detail}` : ''}). ` +
      `Use azeth_prove_reputation to submit one.`
    );
  }

  const provenChains = r.chains.filter((c) => c.proven);
  const detail = provenChains
    .map((c) => {
      const iso = new Date(Number(c.provenAt) * 1000).toISOString();
      return `${c.chainName} (${formatUSD(c.netPaidUSD)}, proven at L2 block ${c.l2BlockNumber}, ${iso})`;
    })
    .join('; ');
  return (
    `${r.from} has provably paid ${r.to} ${formatUSD(r.totalNetPaidUSD)} USD ` +
    `across ${provenChains.length} of ${registered} registered L2 chain(s): ${detail}.`
  );
}

/** Register cross-chain reputation MCP tools: azeth_prove_reputation, azeth_get_cross_chain_reputation */
export function registerCrosschainTools(server: McpServer): void {
  // ──────────────────────────────────────────────
  // azeth_prove_reputation
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_prove_reputation',
    {
      description: [
        'Prove an L2 net-USD payment relationship on L1 via MPT storage proof against TrustL2Reader.',
        '',
        'Use this when: you want L2 (Base Sepolia) payment reputation between two accounts recognized on Ethereum L1 (feeds ReputationModule.getTotalNetPaidUSD cross-chain aggregation).',
        'Builds the proof from the current rollup anchor and SIMULATES it. Only submits an L1 transaction when broadcast=true.',
        '',
        'Returns: status (simulated | broadcast | already-proven), the proven usdDelta and direction, anchor block, and txHash when broadcast.',
        '',
        'Note: broadcast=false (default) is read-only and needs no private key. broadcast=true requires AZETH_PRIVATE_KEY whose EOA holds L1 ETH for gas (plain L1 transaction — permissionless, no guardian/bundler involved). Proof building requires an archive L2 RPC (AZETH_ARCHIVE_RPC_URL_BASE_SEPOLIA).',
        '',
        'Example: { "payer": "0x1111…", "payee": "0x2222…", "broadcast": false }',
      ].join('\n'),
      inputSchema: z.object({
        chain: z.string().optional()
          .describe('L2 chain whose reputation to prove. Defaults to AZETH_CHAIN env var or "baseSepolia". Accepts "base", "baseSepolia" (and aliases like "base-sepolia"). Must be an L2 registered on TrustL2Reader.'),
        payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid Ethereum address')
          .describe('Payer address (the account whose net USD payments should be recognized on L1).'),
        payee: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid Ethereum address')
          .describe('Payee address (counterparty that was paid).'),
        broadcast: z.boolean().default(false)
          .describe('When true, submit the proof transaction on L1 (requires AZETH_PRIVATE_KEY with L1 ETH for gas). Default false = build + simulate only.'),
      }),
    },
    async (args) => {
      try {
        // (1) Resolve the L2 chain and its L1 verification chain
        const l2Name = resolveChain(args.chain);
        const l1Name = L1_FOR_L2[l2Name];
        if (!l1Name) {
          return error(
            'INVALID_INPUT',
            `"${l2Name}" is not a supported L2 — cross-chain proofs prove an L2 against its L1.`,
            'Use chain "baseSepolia" (or "base" on mainnet).',
          );
        }

        // (2) Distinct pair guard
        if (args.payer.toLowerCase() === args.payee.toLowerCase()) {
          return error('INVALID_INPUT', 'payer and payee must differ.');
        }

        // (3) Reader must be deployed on the L1
        const readerAddress = trustL2ReaderFor(l1Name);
        if (!readerAddress) {
          return error(
            'NETWORK_ERROR',
            `TrustL2Reader not deployed on ${l1Name}`,
            'Cross-chain proofs verify on L1 (ethereumSepolia). Deploy/sync addresses first.',
          );
        }

        // (4) L1 public client + L2 ARCHIVE client
        const { createPublicClient, createWalletClient, http } = await import('viem');
        const l1Rpc = process.env[RPC_ENV_KEYS[l1Name]] ?? SUPPORTED_CHAINS[l1Name].rpcDefault;
        const l2ArchiveRpc =
          process.env[ARCHIVE_RPC_ENV_KEYS[l2Name]] ??
          process.env[RPC_ENV_KEYS[l2Name]] ??
          SUPPORTED_CHAINS[l2Name].rpcDefault;

        const l1Client = createPublicClient({
          chain: resolveViemChain(l1Name),
          transport: http(l1Rpc),
        });
        const l2ArchiveClient = createPublicClient({
          chain: resolveViemChain(l2Name),
          transport: http(l2ArchiveRpc),
        });

        // (5) Build the proof bundle at the current rollup anchor
        const proof = await buildL2UsdDeltaProof(l1Client, l2ArchiveClient, readerAddress, {
          chainId: BigInt(SUPPORTED_CHAINS[l2Name].id),
          accountA: args.payer as `0x${string}`,
          accountB: args.payee as `0x${string}`,
        });

        // (6) Broadcast requires a funded L1 EOA from AZETH_PRIVATE_KEY
        let l1WalletClient: WalletClient<Transport, Chain, Account> | undefined;
        if (args.broadcast) {
          const pk = process.env['AZETH_PRIVATE_KEY'];
          if (!pk || !validatePrivateKey(pk)) {
            return error(
              'UNAUTHORIZED',
              'broadcast=true requires AZETH_PRIVATE_KEY — the proof is submitted as a plain L1 transaction paid in L1 ETH.',
              'Set AZETH_PRIVATE_KEY and fund its EOA with Sepolia ETH on ethereumSepolia, or run with broadcast=false to simulate only.',
            );
          }
          const { privateKeyToAccount } = await import('viem/accounts');
          l1WalletClient = createWalletClient({
            account: privateKeyToAccount(pk),
            chain: resolveViemChain(l1Name),
            transport: http(l1Rpc),
          });
        }

        // (7) Simulate (always) and broadcast only when requested
        const result = await proveL2UsdDelta(l1Client, readerAddress, proof, {
          broadcast: args.broadcast ?? false,
          ...(l1WalletClient ? { l1WalletClient } : {}),
        });

        // (8) Structured payload — direction derived from usdDelta sign vs canonical pair
        const payerIsAccount0 = args.payer.toLowerCase() === result.account0.toLowerCase();
        const positiveDelta = result.usdDelta >= 0n;
        const direction = positiveDelta === payerIsAccount0 ? 'payer→payee' : 'payee→payer';
        const absDelta = result.usdDelta < 0n ? -result.usdDelta : result.usdDelta;

        const data: Record<string, unknown> = {
          status: result.status,
          l2Chain: l2Name,
          l2ChainId: String(SUPPORTED_CHAINS[l2Name].id),
          l1Chain: l1Name,
          trustL2Reader: readerAddress,
          account0: result.account0,
          account1: result.account1,
          usdDelta: result.usdDelta.toString(),
          usdDeltaFormatted: formatUSD(absDelta),
          direction,
          anchor: {
            l2BlockNumber: result.anchorL2BlockNumber.toString(),
            outputRoot: proof.anchor.root,
          },
          proof: {
            stateRootProofBytes: (proof.stateRootProof.length - 2) / 2,
            accountProofNodes: proof.accountProof.length,
            storageProofNodes: proof.storageProof.length,
            slot: proof.slot,
            baseSlot: proof.baseSlot.toString(),
          },
        };
        if (result.status === 'simulated') {
          data['note'] = 'Simulation only — re-run with broadcast=true to submit on L1.';
        }
        if (result.receiptStatus) {
          data['receiptStatus'] = result.receiptStatus;
          if (result.receiptStatus === 'pending') {
            data['note'] =
              'Transaction broadcast but the receipt is not confirmed yet (wait timed out or the RPC failed). ' +
              'Track txHash on the L1 explorer — do NOT re-run this tool: the proof is already submitted and ' +
              'a re-submission reverts ProofOutdated once it lands.';
          }
        }
        if (result.txHash) {
          data['txHash'] = result.txHash;
          return success(data, { txHash: result.txHash });
        }
        return success(data);
      } catch (err) {
        return handleError(err);
      }
    },
  );

  // ──────────────────────────────────────────────
  // azeth_get_cross_chain_reputation
  // ──────────────────────────────────────────────
  server.registerTool(
    'azeth_get_cross_chain_reputation',
    {
      description: [
        'Get L1-proven cross-chain payment reputation between two accounts from TrustL2Reader.',
        '',
        'Use this when: you want the trust-weighted net USD one account has provably paid another across all registered L2 chains, as visible on Ethereum L1.',
        '',
        'Returns: totalNetPaidUSD aggregate, per-chain breakdown (proven flag, anchor block, proven-at timestamp), and a human-readable summary.',
        '',
        'Note: read-only L1 query — no private key or gas required. Values only update when someone submits a storage proof (azeth_prove_reputation).',
        '',
        'Example: { "from": "0x1111…", "to": "0x2222…" }',
      ].join('\n'),
      inputSchema: z.object({
        from: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid Ethereum address').describe('Payer address.'),
        to: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid Ethereum address').describe('Payee address.'),
        l1Chain: z.string().optional()
          .describe('L1 chain hosting TrustL2Reader. Defaults to "ethereumSepolia". Accepts "ethereum" (and aliases like "eth-sepolia", "mainnet").'),
      }),
    },
    async (args) => {
      try {
        // Explicit default — do NOT let AZETH_CHAIN leak in for the L1 read side.
        const l1Name = args.l1Chain ? resolveChain(args.l1Chain) : 'ethereumSepolia';

        if (args.from.toLowerCase() === args.to.toLowerCase()) {
          return error('INVALID_INPUT', 'from and to must differ.');
        }

        const readerAddress = trustL2ReaderFor(l1Name);
        if (!readerAddress) {
          return error(
            'NETWORK_ERROR',
            `TrustL2Reader not deployed on ${l1Name}`,
            'Cross-chain proofs verify on L1 (ethereumSepolia). Deploy/sync addresses first.',
          );
        }

        const { createPublicClient, http } = await import('viem');
        const l1Rpc = process.env[RPC_ENV_KEYS[l1Name]] ?? SUPPORTED_CHAINS[l1Name].rpcDefault;
        const l1Client = createPublicClient({
          chain: resolveViemChain(l1Name),
          transport: http(l1Rpc),
        });

        const r = await getCrossChainReputation(
          l1Client,
          readerAddress,
          args.from as `0x${string}`,
          args.to as `0x${string}`,
        );

        const chains = r.chains.map((c) => ({
          chainId: c.chainId.toString(),
          chainName: c.chainName,
          netPaidUSD: c.netPaidUSD.toString(),
          netPaidUSDFormatted: formatUSD(c.netPaidUSD),
          proven: c.proven,
          l2BlockNumber: c.l2BlockNumber.toString(),
          provenAt: c.provenAt.toString(),
          provenAtISO: c.proven ? new Date(Number(c.provenAt) * 1000).toISOString() : null,
        }));

        return success({
          from: r.from,
          to: r.to,
          l1Chain: l1Name,
          trustL2Reader: readerAddress,
          totalNetPaidUSD: r.totalNetPaidUSD.toString(),
          totalNetPaidUSDFormatted: formatUSD(r.totalNetPaidUSD),
          registeredChainIds: r.registeredChainIds.map((id) => id.toString()),
          chains,
          summary: buildReputationSummary(r),
        });
      } catch (err) {
        return handleError(err);
      }
    },
  );
}
