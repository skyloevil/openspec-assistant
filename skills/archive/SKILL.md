---
name: codex-sdd-loop:archive
description: Preserve change artifacts (proposal, design, tasks) into structured archive and update knowledge base. Final phase of OpenSpec workflow.
---

# OpenSpec Archive

## Context
Archive is the final phase of the OpenSpec workflow. It preserves the change
artifacts (proposal, design, tasks) into a structured archive directory and
updates the knowledge base for future reference. This is the "accumulate
experience" step.

## Trigger
Any of these patterns triggers this skill:
- User says "openspec archive" or "openspec:archive"
- Validation passed and user wants to finalize
- `openspec_get_status` shows phase is `validate` or `archive` and ready to archive
- User manually requests archiving

## Prerequisites
- Validation passed (or user explicitly wants to archive without validation)
- All spec files exist

## Workflow

### Step 1: Prepare Archive
Call `openspec_get_status` to confirm the change is ready for archiving.
Check that all key artifacts are present:
- `openspec/changes/<changeId>/proposal.md`
- `openspec/changes/<changeId>/tasks.md`
- `openspec/changes/<changeId>/verification.md`
- `openspec/changes/<changeId>/implementation-notes.md`

### Step 2: Confirm with User
**Gate: Archive Confirmation** — Ask:
- "Archive change [changeId]? This will store the spec documents and reset the workflow."
- Optionally ask for an archive summary message

### Step 3: Execute Archive
Before archiving, call `openspec_get_pending_hooks({ hookPoint: "pre_archive" })`.
Required hooks must be recorded as passed or skipped with `openspec_record_hook_result`.

Before calling `openspec_archive_change`, call `openspec_sync_specs` for the relevant
domain names so the change delta is appended to `openspec/specs/<domain>/spec.md`.
If the domain is unknown, use `general`. Then call `docs_check_freshness`; unresolved
stale domain specs should block archive unless the user explicitly accepts the gap.

Call `openspec_archive_change` with an optional summary message:

```
openspec_archive_change({
  message: "Implemented X feature with Y approach. Key decisions: ..."
})
```

This:
1. Copies active artifacts to `openspec/changes/archive/<changeId>/`
2. Writes `archive-metadata.json` with timestamps and paths
3. Adds an entry to `openspec/changes/archive/_knowledge-base/<changeId>.json`
   for the accumulated knowledge base
4. Preserves the main domain spec sync metadata in state
5. Resets the state machine to `complete` phase

### Step 4: Summarize
Present the archive summary:
- Change ID
- Archive location
- Knowledge base updated
- Ready for next change

## Knowledge Base Accumulation
The knowledge base at `openspec/changes/archive/_knowledge-base/` accumulates over time.
Each entry contains:
- changeId
- Date
- Summary message
- Paths to archived documents

Future proposals can reference this knowledge base to:
- Understand past design decisions
- Reuse successful patterns
- Avoid repeated mistakes
- Onboard new team members faster

## Output
- Archived spec documents in `openspec/changes/archive/<changeId>/`
- Knowledge base entry in `openspec/changes/archive/_knowledge-base/<changeId>.json`
- State reset to `complete` for next change
- Archived files can be retrieved via `list_archives`

## Customization Hooks
Teams can inject custom behavior:
- **Post-archive**: Notify team in Slack/WeCom about the archived change
- **Knowledge Base**: Connect to external knowledge management system
- **Metrics**: Track cycle time, task completion rate, drift frequency
See `customize/SKILL.md` for details.
