---
name: openspec-assistant:tapd-openspec-proposal
description: Fetch TAPD story requirements before OpenSpec proposal generation. Use when the user asks OpenSpec propose with a TAPD story URL/id, says to import TAPD requirements, or asks to generate proposal.md from TAPD.
---

# TAPD OpenSpec Proposal

## Overview

Use the project-local `tapd-requirement` MCP server to fetch TAPD story content before calling `openspec_create_change`. Treat TAPD as source material for scope, background, constraints, out-of-scope notes, and acceptance criteria.

## Workflow

1. Extract TAPD input from the user message:
   - URL example: `https://www.tapd.cn/tapd_fe/47034349/story/detail/1147034349001283046`
   - Parsed workspace id: `47034349`
   - Parsed story id: `1147034349001283046`
2. Call MCP tool `tapd-requirement:fetch_story` with either:
   - `{ "url": "<tapd story url>" }`
   - `{ "workspaceId": "<workspace id>", "storyId": "<story id>" }`
3. Read `proposalInput` from the MCP response. If fields are missing, inspect `raw` for team custom fields, comments, or rich description fields.
4. Build the OpenSpec proposal input:
   - `description`: TAPD title plus requirement description.
   - `background`: TAPD business context, source URL, workspace id, story id, owner/status/priority if present.
   - `outOfScope`: Explicit TAPD non-goals only. If none are present, leave empty and do not invent exclusions.
   - Acceptance criteria: preserve TAPD criteria verbatim enough to avoid changing intent, then normalize into checkable bullets.
5. Before `openspec_create_change`, call `openspec_detect_layout` if available.
6. Call `openspec_create_change` with `preset: "full"`.
7. Record the pre-proposal hook result with `openspec_record_hook_result`:
   - `hookPoint`: `pre_proposal`
   - `hookName`: `tapd-requirement:fetch_story`
   - `status`: `passed` when TAPD content was fetched, `failed` when the MCP/API call failed, or `skipped` only after the user explicitly chooses to paste requirements manually.

## Failure Handling

If `tapd-requirement` is unavailable, tell the user to reload Codex after adding `.mcp.json` or verify that the MCP server is enabled. If credentials are missing, ask the user to set `TAPD_API_USER` and `TAPD_API_PASSWORD` in their local Codex environment or personal MCP config.

If the TAPD API response is accessible but incomplete, ask one concise clarification question for the missing scope or acceptance criterion instead of filling gaps from codebase guesses.

## Reference

Read `references/tapd-api.md` when you need exact endpoint assumptions, credential requirements, or the example story URL mapping.
