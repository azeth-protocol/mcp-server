# @azeth/mcp-server

MCP (Model Context Protocol) server for Azeth -- the trust, discovery, and payment layer for the machine economy. Provides 32 tools for AI agents to create accounts, make payments, discover services, manage reputation, and communicate via XMTP.

<a href="https://glama.ai/mcp/servers/@azeth-protocol/mcp-azeth">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@azeth-protocol/mcp-azeth/badge" alt="mcp-azeth MCP server" />
</a>

## Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "azeth": {
      "command": "npx",
      "args": ["@azeth/mcp-server"],
      "env": {
        "AZETH_PRIVATE_KEY": "0x...",
        "PIMLICO_API_KEY": "your-pimlico-api-key"
      }
    }
  }
}
```

### Claude Code

Add to `.claude/settings.json` in your project:

```json
{
  "mcpServers": {
    "azeth": {
      "command": "npx",
      "args": ["@azeth/mcp-server"],
      "env": {
        "AZETH_PRIVATE_KEY": "0x...",
        "PIMLICO_API_KEY": "your-pimlico-api-key"
      }
    }
  }
}
```

### Local Development

```json
{
  "mcpServers": {
    "azeth": {
      "command": "node",
      "args": ["path/to/Azeth/packages/mcp-server/dist/index.js"],
      "env": {
        "AZETH_PRIVATE_KEY": "0x...",
        "PIMLICO_API_KEY": "your-pimlico-api-key"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AZETH_PRIVATE_KEY` | Yes | Account owner's private key (0x-prefixed hex) |
| `PIMLICO_API_KEY` | Yes* | Pimlico bundler/paymaster API key (*required for state-changing operations) |
| `AZETH_CHAIN` | No | `"baseSepolia"` or `"base"` (default: `baseSepolia`) |
| `AZETH_RPC_URL` | No | Custom RPC endpoint |
| `AZETH_SERVER_URL` | No | Azeth API server URL (default: `https://api.azeth.ai`) |
| `XMTP_ENCRYPTION_KEY` | No | For XMTP messaging tools |

## Tools (32)

| Category | Tools | Description |
|---|---|---|
| **Account** (6) | `azeth_create_account`, `azeth_balance`, `azeth_history`, `azeth_deposit`, `azeth_accounts`, `azeth_whitelist_token` | Deploy smart accounts, check balances, manage token whitelists |
| **Transfer** (1) | `azeth_transfer` | Send ETH or ERC-20 tokens from your smart account |
| **Payment** (4) | `azeth_pay`, `azeth_smart_pay`, `azeth_create_payment_agreement`, `azeth_subscribe_service` | Pay for x402 services, auto-discover by capability, set up subscriptions |
| **Agreement** (5) | `azeth_execute_agreement`, `azeth_cancel_agreement`, `azeth_get_agreement`, `azeth_list_agreements`, `azeth_get_due_agreements` | Manage recurring payment agreements -- execute, cancel, query, find due payments |
| **Registry** (5) | `azeth_publish_service`, `azeth_discover_services`, `azeth_get_registry_entry`, `azeth_update_service`, `azeth_update_service_batch` | Register on ERC-8004 trust registry, discover services by capability and reputation |
| **Reputation** (4) | `azeth_submit_opinion`, `azeth_get_weighted_reputation`, `azeth_get_net_paid`, `azeth_get_active_opinion` | Payment-gated reputation -- rate services, check USD-weighted scores |
| **Messaging** (5) | `azeth_send_message`, `azeth_check_reachability`, `azeth_receive_messages`, `azeth_list_conversations`, `azeth_discover_agent_capabilities` | End-to-end encrypted XMTP messaging between agents |
| **Guardian** (2) | `azeth_get_guardrails`, `azeth_whitelist_protocol` | View and manage guardian security configuration |

## Address Resolution

All tools that accept addresses support flexible resolution:

- Ethereum address: `0x1234...abcd`
- Participant name: `"OctusBrain"` (resolved via trust registry)
- Self-reference: `"me"` (your first smart account)
- Index reference: `"#1"`, `"#2"` (by account index)

## Response Format

All tools return structured JSON:

```json
{
  "success": true,
  "data": { ... }
}
```

Errors include machine-readable codes and recovery suggestions:

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient USDC balance: have 5.00, need 10.00.",
    "suggestion": "Fund your smart account before retrying."
  }
}
```

## Full Documentation

See [docs/mcp-tools.md](../../docs/mcp-tools.md) for complete tool reference with parameter tables, return values, and example prompts for all 32 tools.

## Development

```bash
# Build
pnpm build

# Watch mode
pnpm dev

# Run tests
pnpm test

# Type check
pnpm typecheck
```

## License

MIT