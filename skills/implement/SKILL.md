---
name: openspec-assistant:implement
description: Execute tasks from tasks.md sequentially with automatic progress tracking and human checkpoints. Third phase of OpenSpec workflow.
---

# OpenSpec Implement

## Context
Implement is the third phase of the OpenSpec workflow. It executes the tasks
from `tasks.md` one by one, tracking progress and updating the state machine.
This is the "execute with discipline" step.

## Trigger
Any of these patterns triggers this skill:
- User says "openspec implement" or "openspec:implement"
- User says "start implementation" or "execute tasks"
- `openspec_get_status` shows phase is `implement`
- `openspec_get_status` shows phase is `plan` with design confirmed

## Prerequisites
- An approved `openspec/changes/<changeId>/design.md` for full preset changes
- A generated `openspec/changes/<changeId>/tasks.md` with tasks listed
- User has confirmed readiness to implement

## Workflow

### Step 1: Read Tasks
Call `openspec_read_artifact({ artifactId: "tasks" })` to understand the full task list and identify
incomplete tasks.

### Step 2: Check Status
Call `openspec_get_status` to confirm the project is in the `implement` phase.

### Step 3: Execute Next Task
Work through tasks one at a time:

1. Find the first incomplete task (marked `[ ]` in tasks.md)
2. Read `design`, `specs`, and `implementation_notes` artifacts when present
3. Implement the required code changes
4. Run focused verification for the task
5. Call `openspec_record_validation_evidence` with the check result
6. Call `openspec_record_iteration` with changed files, commands, test results,
   errors, and evidence references
7. After implementation is done, **ask user to verify** the change when the task
   has medium/high risk, external side effects, or ambiguous acceptance criteria
8. Call `openspec_update_task({ taskId: "T1", done: true })` only after passed
   evidence exists or the user explicitly approves pending validation
9. Repeat for the next incomplete task

### Step 4: Validation Checkpoints
After each task, provide a brief summary:
- What was implemented
- Related files changed
- Any notable decisions or deviations from the design

**Gate: Destructive Changes** — Auto-pause and ask before:
- Deleting or renaming files
- Changing public API signatures
- Modifying database schemas
- Large refactors affecting existing tests
- Writing to external systems
- Security-sensitive or permission-sensitive changes
- Flag these in the summary and ask for confirmation before proceeding
  with `openspec_request_human_review`.

### Step 5: Task Completion
When all tasks are done (`openspec_update_task` returns `tasksRemaining = 0`):
- State automatically transitions to `validate` phase
- Tell the user to run `openspec:validate` to check spec compliance

### Error Recovery
If a task cannot be completed:
1. Document the issue in the task description
2. Ask the user how to proceed (skip, redesign, fix)
3. Use `cancel_change` if the change needs to be abandoned

## Output
- Updated `openspec/changes/<changeId>/tasks.md` with completed tasks checked
- Code changes implementing each task
- State updated to `validate` phase when all tasks complete

## Customization Hooks
Teams can inject custom behavior:
- **Pre-task**: Run linters or type checkers before coding
- **Post-task**: Run specific tests after task completion
- **Code Review**: Call MCP tool to review generated code
- **Auto-test**: Trigger test suite execution automatically
See `customize/SKILL.md` for details.
