---
name: codex-sdd-loop:plan
description: Create design.md with technical architecture and tasks.md with executable breakdown from an approved proposal. Second phase of OpenSpec workflow.
---

# OpenSpec Plan

## Context
Plan is the second phase of the OpenSpec workflow. It transforms an approved proposal
into two artifacts:
- **design.md** — Technical architecture, API contracts, data design, decisions
- **tasks.md** — Executable task breakdown
This is the "constrain the implementation" step.

## Trigger
Any of these patterns triggers this skill:
- User says "openspec plan" or "openspec:plan"
- User confirms the proposal scope
- `openspec_get_status` shows phase is `plan` or phase is `propose` with confirmed scope

## Prerequisites
- An active proposal at `openspec/changes/<changeId>/proposal.md`
- Scope has been confirmed by the user

## Workflow

### Step 1: Read the Proposal
Call `openspec_read_artifact({ artifactId: "proposal" })` to understand the requirement scope and constraints.

### Step 2: Build Context
Call `docs_build_context` using keywords from the proposal. Include likely spec
domains and modules when known. The design should cite relevant source paths from
`openspec/specs`, `docs/generated`, `docs/reviewed`, or `docs/knowledge` when they
affect interfaces, compatibility, risks, or task sequencing.

### Step 3: Generate Design
Use `openspec_create_or_update_artifact` with detailed technical analysis:

```
openspec_create_or_update_artifact({
  artifactId: "design",
  content: "<technical design markdown>"
})
```

For best results, you should analyze the proposal and generate a thorough technical
design covering:
- Overall architecture approach
- New/modified interfaces (API endpoints, function signatures)
- Data model changes
- Caching strategy
- Concurrency/locking considerations
- Compatibility with existing systems
- Risks and edge cases

Write the full design to `openspec/changes/<changeId>/design.md`.

### Step 4: Generate Tasks
After design is created, generate tasks:

```
openspec_create_or_update_artifact({
  artifactId: "tasks",
  content: "<checkbox task markdown>"
})
```

This creates or updates `openspec/changes/<changeId>/tasks.md` with check-box tasks.

### Step 5: Present Design for Review
**Gate: Design Confirmation** — This is a key human-in-the-loop point.
Present the design to the user and ask for confirmation:
- "Here is the technical design. Does this look correct?"
- Highlight key decisions, especially breaking changes or risky choices
- If the user requests changes, update the design and regenerate tasks
- If approved, mark the design as confirmed

### Step 6: Transition
Once design is confirmed:
1. Call `openspec_set_gate({ gate: "design", confirmed: true })`
2. Tell user they can proceed to implementation with `openspec:implement`
3. The state machine is now in `implement` phase

## Output
- `openspec/changes/<changeId>/design.md` — Technical design document
- `openspec/changes/<changeId>/tasks.md` — Task breakdown with checkboxes
- State updated to `plan` or `implement` phase

## Customization Hooks
Teams can inject custom behavior:
- **Pre-hook**: Call MCP tool to fetch existing API specs or codebase context
- **Design Review**: Call MCP tool to enforce architecture rules (e.g., check naming conventions)
- **Post-hook**: Sync design to team wiki or send for peer review
See `customize/SKILL.md` for details.
