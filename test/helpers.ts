import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface RegisteredTool {
  schema: unknown;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Create a mock McpServer that captures tool registrations.
 * Call `tools.get(name)` to retrieve and invoke handlers directly.
 */
export function createMockMcpServer() {
  const tools = new Map<string, RegisteredTool>();

  const mockServer = {
    registerTool(
      name: string,
      config: { inputSchema: unknown },
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      tools.set(name, { schema: config.inputSchema, handler });
    },
    tools,
  };

  return mockServer as unknown as McpServer & { tools: Map<string, RegisteredTool> };
}

/** A valid test private key (Hardhat/Anvil account #0 — do NOT use on mainnet) */
export const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/** A valid test Ethereum address (Hardhat/Anvil account #1) */
export const TEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/** USDC address on Base for testing */
export const TEST_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Smart account address returned by mocked SDK */
export const MOCK_SMART_ACCOUNT = '0x1234567890AbcdEF1234567890aBcdef12345678';
