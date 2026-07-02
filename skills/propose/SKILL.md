---
name: codex-sdd-loop:propose
description: Generate structured proposal.md from user requirements, defining scope, constraints, and acceptance criteria. First phase of OpenSpec workflow.
---

# OpenSpec Propose

## Context
Propose is the first phase of the OpenSpec workflow. It transforms a raw requirement
into a structured `proposal.md` that defines scope, constraints, and acceptance criteria.
This is the "constrain the requirement" step.

## Trigger
Any of these patterns triggers this skill:
- User says "openspec propose" or "openspec:propose"
- User describes a new feature or change they want to make
- User says "start a new change" or "new proposal"
- `openspec_get_status` shows phase is `idle` and user describes work

## Workflow

### Step 1: Understand the Requirement
Ask clarifying questions if the requirement is vague:
- What is the business goal?
- What is in scope / out of scope?
- Are there any constraints or acceptance criteria?

Use **minimal clarification** for straightforward requests.
For ambiguous/complex requests, spend more time to nail scope before writing.

### Step 2: Detect Existing Layout
Call the `openspec_detect_layout` tool to check if an OpenSpec structure already exists
in the project. If one does, note the existing archives and specs as prior context.

### Step 3: Build Context
Call `docs_build_context` with the requirement keywords before creating the proposal.
Also call `knowledge_search` for the same keywords to find prior pitfalls, decisions,
and compatibility notes. Use cited source paths from the context pack in the proposal
background or acceptance criteria when they affect scope.

### Step 4: Create Proposal
Call the `openspec_create_change` tool with the requirement description:

```
openspec_create_change({
  description: "<clear description of the requirement>",
  background: "<optional context>",
  outOfScope: "<optional out-of-scope items>",
  preset: "full"
})
```

This generates `openspec/changes/<changeId>/proposal.md` plus the preset artifacts
and sets up the v2 state machine.

### Step 5: Present for Review
Present the generated proposal to the user. Highlight:
- **Change ID**: So they can reference it later
- **Scope**: What will and won't be done
- **Next Action**: The state machine says what happens next

**Gate: Scope Confirmation** — This is a human-in-the-loop point.
Ask the user to confirm the scope with a clear yes/no question:
- "Is the scope correct? Can I proceed to technical planning?"
- If yes: transition to the **plan** phase
- If no: ask for clarifications and regenerate with `openspec_cancel_change` + fresh `openspec_create_change`

### Step 6: After Confirmation
Once scope is confirmed:
1. Call `openspec_set_gate({ gate: "scope", confirmed: true })`
2. Tell the user they can continue with `codex-sdd-loop:continue`

## Output
- `openspec/changes/<changeId>/proposal.md` — Structured proposal document
- State updated to `propose` phase
- `nextAction` tells what to do next

## Customization Hooks
Teams can inject custom behavior before/after each step:
- **Pre-hook**: Call a custom MCP tool (e.g., fetch requirement from TAPD) before generating proposal
- **Post-hook**: Call a custom MCP tool (e.g., notify Slack, create JIRA ticket) after proposal is confirmed
- **Validation**: Add custom validation rules before confirming scope
See `customize/SKILL.md` for details on hook points.
