# Installing Azeth MCP Server

## Prerequisites

- Node.js 20+
- An Ethereum private key (for smart account ownership)

## Quick Install

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "azeth": {
      "command": "npx",
      "args": ["-y", "@azeth/mcp-server"],
      "env": {
        "AZETH_PRIVATE_KEY": "0x_YOUR_PRIVATE_KEY_HERE",
        "AZETH_CHAIN": "baseSepolia"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `AZETH_PRIVATE_KEY` | Yes | Owner private key (0x-prefixed, 64 hex chars) |
| `AZETH_CHAIN` | No | `baseSepolia`, `base`, `ethereumSepolia`, or `ethereum` (default: `baseSepolia`) |
| `AZETH_RPC_URL` | No | Custom RPC endpoint |
| `AZETH_GUARDIAN_KEY` | No | Guardian co-signing key for operations exceeding spending limits |
| `AZETH_GUARDIAN_AUTO_SIGN` | No | Set to `true` to auto-approve guardian requests |
| `XMTP_ENCRYPTION_KEY` | No | For persistent XMTP messaging |

## For Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`

## For Claude Code

Add to `.claude/settings.json` in your project.

## For Cursor

Add to MCP server settings in Cursor preferences.

## Verify Installation

After adding, ask your AI assistant: "Check my Azeth balance" — it should invoke `azeth_balance`.

## Testnet First

Start with `AZETH_CHAIN=baseSepolia` (default). No real funds needed. Switch to `base` or `ethereum` for mainnet.
