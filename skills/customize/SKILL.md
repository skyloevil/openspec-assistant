---
name: openspec-assistant:customize
description: Guide for injecting custom MCP tools, skills, and hook points into the OpenSpec workflow for team-specific processes.
---

# OpenSpec Customize

## Context
OpenSpec Assistant is designed to be extensible. Teams can inject custom workflows
at key hook points throughout the lifecycle. This skill documents how to extend
the plugin with team-specific MCP tools, skills, and scripts.

## Extension Points

### 1. Hook Points in the Workflow
Each phase has well-defined hook points where custom behavior can be injected:

| Phase | Hook Point | Timing | Common Use Cases |
|-------|-----------|--------|-----------------|
| propose | pre_proposal | Before generating proposal | Fetch requirements from TAPD/JIRA, clarify with LLM |
| propose | post_confirm_scope | After scope is confirmed | Notify PM, create tracking ticket |
| plan | pre_design | Before design generation | Fetch existing API docs, load codebase context |
| plan | post_confirm_design | After design is approved | Send for team review, update wiki |
| implement | pre_execute_task | Before each task | Run lint, fetch latest code |
| implement | post_complete_task | After each task | Run unit tests, check types |
| validate | pre_validate | Before drift check | Run full test suite |
| validate | post_validate | After validation | Send report, create JIRA subtasks for fixes |
| archive | pre_archive | Before archiving | Generate change log, update release notes |
| archive | post_archive | After archiving | Notify team, sync to knowledge base |

Hooks are business extensions, not control-plane owners. They may provide
context, validation, review, notifications, or external synchronization, but the
OpenSpec loop state remains the source of truth for phase, goal status,
completion, blocked state, and human gates.

Recommended hook policy fields:

```yaml
hooks:
  pre_validate:
    - id: run_ci
      kind: command
      name: npm-test
      command: npm test
      required: true
      mode: auto
      timeoutMs: 120000
      onFailure: retry_then_human
```

- `required`: failed or pending result blocks the associated gate.
- `mode`: `auto`, `review`, or `manual`.
- `onFailure`: `warn`, `retry_then_human`, `human_review`, or `block`.
- External writes should default to `review` or `manual`.

### 2. Adding Custom MCP Tools
Add your team's MCP servers to the project's `.mcp.json` or to your personal
Codex MCP config. The OpenSpec skills will automatically discover MCP tools
for the current hook point.

Example — adding a TAPD requirement fetcher:
```json
{
  "mcpServers": {
    "openspec-assistant": { ... },
    "tapd-requirement": {
      "command": "node",
      "args": ["path/to/tapd-mcp-server/index.js"]
    }
  }
}
```

Then reference it in your team's customization skill:
```markdown
## Custom Pre-Proposal
Before calling `openspec_create_change`, call `tapd-requirement:fetch_ticket` to get
requirements from TAPD. Use the ticket content as the proposal description.
```

### 3. Adding Custom Skills
Add team-specific skills in `.agents/skills/` at the project root.
Name them clearly so they're triggered at the right time.

Example — custom lint check skill:
```
.agents/skills/openspec-lint/SKILL.md
```

The skill file should reference the OpenSpec hook point:
```markdown
# Openspec Lint Check
## Trigger
After `post_complete_task` in OpenSpec implement phase.

## Workflow
1. Wait for task completion
2. Run `npm run lint` on changed files
3. Report any lint errors to the user
```

### 4. Custom Validation Rules
Teams can enforce project-specific rules at each gate:

```markdown
## Custom Design Rules
Before confirming design, check:
- All API endpoints follow `/api/v1/` prefix convention
- No hard-coded values in config
- Rate limiting considered for new endpoints
```

Create a skill file for these rules and reference which phase they apply to.

### 5. Custom Knowledge Base
The built-in archive stores to `openspec/changes/archive/_knowledge-base/`.
Teams can customize this to sync with external systems:

- **Post-archive hook**: Call MCP tool to upload archive to Confluence/wiki
- **Pre-validate hook**: Fetch relevant past archives for context
- **Custom fields**: Add `metadata` to the state file for team-specific data

### 6. Environment Variables
The MCP server reads `process.cwd()` to determine the project root.
For custom configurations, set environment variables in `.mcp.json`:
```json
{
  "mcpServers": {
    "openspec-assistant": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

## Compatibility with Codex Skills
The OpenSpec skills are standard Codex SKILL.md files. They coexist with:
- Other project skills in `.agents/skills/`
- Repository-level `.codex/skills/`
- User-level skill sets

Skills are triggered by keyword matching on user input, so custom skills
can intercept or extend the workflow at any point.

## Best Practices
1. **Minimal injection**: Only add hooks at points where your team needs automation
2. **Fail gracefully**: Custom MCP failure should not block the core flow
3. **Document custom hooks**: Maintain a `.openspec-codex/customization.md` in your project
4. **Version control**: Commit custom hooks alongside project code
5. **Progressive adoption**: Start with core OpenSpec flow, add customizations as needed

## Human Review Escalation
Automatically escalate to human review when:
- Scope or acceptance criteria are ambiguous
- A hook marked `required` fails
- The same validation failure repeats
- A step changes public APIs, database schemas, permissions, security behavior,
  or external systems
- The agent cannot map the implementation back to the spec with confidence

Use `openspec_request_human_review` to create the gate and
`openspec_resolve_human_review` to record the decision. Do not bypass loop
state by directly marking tasks, gates, or archives complete when a review is
pending.
