---
name: openspec-assistant:continue
description: Resume the active OpenSpec Assistant workflow by selecting the next action from the state machine.
---

# OpenSpec Continue

## Context
Continue is the high-level entry point for a smooth Codex App workflow. It
uses the state machine to decide what should happen next, instead of requiring
the user to remember propose/plan/implement/validate/archive commands.

## Workflow
1. Call `openspec_get_goal`.
2. If there is an active change but no useful loop objective, call
   `openspec_create_goal` using the change proposal/next action as the
   objective and the acceptance criteria as `successCriteria`.
3. Call `openspec_continue_loop` and follow the returned `decision`.
4. If `decision.kind` is `ask_human`, summarize the pending review, the gate,
   and the risk. Wait for approval before calling `openspec_resolve_human_review`.
5. If `decision.kind` is `act`, read `tasks` with `openspec_read_artifact`,
   implement the referenced task, call `openspec_record_iteration`, run focused
   checks, call `openspec_record_validation_evidence`, then call
   `openspec_update_task` only after evidence exists or the user explicitly
   accepts a pending validation state.
6. If `decision.kind` is `validate`, call `openspec_validate`, run relevant
   checks, record evidence, fix drift, and request/resolve the validation gate
   when clean.
7. If `decision.kind` is `run_hook`, execute or ask for the required hook based
   on its policy, then call `openspec_record_hook_result`.
8. If `decision.kind` is `archive`, call `openspec_archive_change`.
9. If `decision.kind` is `complete` or `blocked`, report the final loop state.

## Human Gates
Confirm at scope, design, validation, archive, and before destructive work:
file deletion, public API changes, database schema changes, broad refactors, or
external-system writes.

Automatically request a human review with `openspec_request_human_review` when
requirements are ambiguous, validation repeatedly fails, required hooks fail,
or a step would perform destructive changes, public API changes, database schema
changes, security-sensitive changes, or external-system writes.
