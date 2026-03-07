#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAccountTools } from './tools/account.js';
import { registerTransferTools } from './tools/transfer.js';
import { registerPaymentTools } from './tools/payments.js';
import { registerAgreementTools } from './tools/agreements.js';
import { registerRegistryTools } from './tools/registry.js';
import { registerReputationTools } from './tools/reputation.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerGuardianTools } from './tools/guardian.js';
import { registerGuardianApprovalTools } from './tools/guardian-approval.js';
import { createRateLimiter, wrapServerWithRateLimit } from './utils/rate-limit.js';
import { ensurePrivateKey } from './utils/auto-key.js';

const SERVER_NAME = '@azeth/mcp-server';
const SERVER_VERSION = '0.1.0';

/** Create and configure the Azeth MCP server with all Phase 0 tools */
function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // H-8: Wrap server with per-tool rate limiting before registering tools
  const rateLimiter = createRateLimiter();
  const rateLimitedServer = wrapServerWithRateLimit(server, rateLimiter);

  // Register all Phase 0 tools (via rate-limited wrapper)
  registerAccountTools(rateLimitedServer);
  registerTransferTools(rateLimitedServer);
  registerPaymentTools(rateLimitedServer);
  registerAgreementTools(rateLimitedServer);
  registerRegistryTools(rateLimitedServer);
  registerReputationTools(rateLimitedServer);
  registerMessagingTools(rateLimitedServer);
  registerGuardianTools(rateLimitedServer);
  registerGuardianApprovalTools(rateLimitedServer);

  return server;
}

/** Sandbox server for Smithery scanning — returns server without requiring credentials */
export function createSandboxServer(): McpServer {
  return createServer();
}

/** Start the MCP server on stdio transport */
async function main(): Promise<void> {
  ensurePrivateKey();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
