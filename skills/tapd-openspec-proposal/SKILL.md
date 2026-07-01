---
name: codex-sdd-loop:tapd-openspec-proposal
description: Fetch TAPD story requirements before OpenSpec proposal generation. Use when the user asks OpenSpec propose with a TAPD story URL/id, says to import TAPD requirements, or asks to generate proposal.md from TAPD.
---

# TAPD OpenSpec Proposal

## Overview

Use `openspec_fetch_tapd_story` from the main `codex-sdd-loop` MCP server to fetch TAPD story content before calling `openspec_create_change`. In older installations that do not expose this tool, fall back to the project-local `tapd-requirement:fetch_story` MCP server. Treat TAPD as source material for scope, background, constraints, out-of-scope notes, and acceptance criteria.

## Workflow

1. Extract TAPD input from the user message:
   - URL example: `https://www.tapd.cn/tapd_fe/12345678/story/detail/1000000000000000001`
   - Parsed workspace id: `12345678`
   - Parsed story id: `1000000000000000001`
2. Call MCP tool `openspec_fetch_tapd_story` with either:
   - `{ "url": "<tapd story url>" }`
   - `{ "workspaceId": "<workspace id>", "storyId": "<story id>" }`
   - If `openspec_fetch_tapd_story` is unavailable but `tapd-requirement:fetch_story` is available, call `tapd-requirement:fetch_story` with the same arguments.
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
   - `hookName`: `openspec_fetch_tapd_story` when the main MCP tool was used, or `tapd-requirement:fetch_story` for the fallback tool.
   - `status`: `passed` when TAPD content was fetched, `failed` when the MCP/API call failed, or `skipped` only after the user explicitly chooses to paste requirements manually.

## Failure Handling

If neither `openspec_fetch_tapd_story` nor `tapd-requirement:fetch_story` is available, tell the user to reload Codex after rebuilding/reinstalling the plugin or verify that the MCP server is enabled. If credentials are missing, ask the user to set `TAPD_API_USER` and `TAPD_API_PASSWORD` in their local Codex environment, personal MCP config, or `.tapd.env.local`.

If the TAPD API response is accessible but incomplete, ask one concise clarification question for the missing scope or acceptance criterion instead of filling gaps from codebase guesses.

## Reference

Read `references/tapd-api.md` when you need exact endpoint assumptions, credential requirements, or the example story URL mapping.
