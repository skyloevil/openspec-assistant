# TAPD API Reference for OpenSpec Proposal Import

## Source

TAPD provides an API documentation portal at `https://open.tapd.cn/document/api-doc/API%E6%96%87%E6%A1%A3/%E4%BD%BF%E7%94%A8%E5%BF%85%E8%AF%BB.html`. Public search did not find an official TAPD MCP server package, so this repository provides a small local MCP adapter in `scripts/tapd-mcp-server.mjs`.

## Authentication

Use TAPD API Basic Auth:

- `TAPD_API_USER`: TAPD API username or client id configured for the account.
- `TAPD_API_PASSWORD`: TAPD API password or secret configured for the account.
- `TAPD_API_BASE`: optional, defaults to `https://api.tapd.cn`.

Do not commit real credentials. Prefer personal Codex MCP config or local environment variables.

## Story Lookup

The local MCP adapter calls:

```text
GET https://api.tapd.cn/stories?workspace_id=<workspace_id>&id=<story_id>
```

The adapter accepts either a TAPD story URL or explicit ids.

Example:

```text
https://www.tapd.cn/tapd_fe/12345678/story/detail/1000000000000000001
```

Parsed values:

```text
workspace_id = 12345678
story_id = 1000000000000000001
```

MCP tool call:

```json
{
  "url": "https://www.tapd.cn/tapd_fe/12345678/story/detail/1000000000000000001"
}
```

## Expected Output

The `fetch_story` MCP tool returns JSON with:

- `source`: TAPD source metadata.
- `raw`: original TAPD API response for custom field inspection.
- `proposalInput`: normalized fields for OpenSpec proposal creation.

Use `proposalInput` first, then inspect `raw` only when normalized fields are empty or team-specific TAPD custom fields are needed.
