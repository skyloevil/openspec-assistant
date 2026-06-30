---
name: openspec-assistant:validate
description: Check implementation alignment with specification, detect drift between planned design and actual code. Fourth phase of OpenSpec workflow.
---

# OpenSpec Validate

## Context
Validate is the fourth phase of the OpenSpec workflow. It checks that the
implementation aligns with the specification and identifies drift between
the planned design and actual code. This is the "catch deviation early" step.

## Trigger
Any of these patterns triggers this skill:
- User says "openspec validate" or "openspec:validate"
- User says "check spec" or "validate change"
- All tasks are completed (state auto-transitions to `validate`)
- User reports unexpected behavior during testing
- `openspec_get_status` shows phase is `validate`

## Prerequisites
- All implementation tasks completed (or at least started)
- active change artifacts exist under `openspec/changes/<changeId>/`

## Workflow

### Step 1: Run Validation
Call `openspec_validate` to get a programmatic drift report:

```
openspec_validate({})
```

This checks:
- All active artifacts exist
- All tasks are marked complete
- Required hooks are complete
- Completed tasks have structured validation evidence when the loop state is active

### Step 2: Manual Validation Checks
Beyond the automated checks, also verify:

**Interface Alignment:**
- Do the implemented APIs match the design document?
- Are request/response fields consistent with the spec?
- Are error codes and edge cases handled?

**Behavioral Coverage:**
- Are the main acceptance scenarios from the proposal covered?
- Are edge cases handled (null inputs, empty states, timeouts)?
- Are concurrency/locking behaviors correct?

**Code Quality:**
- Are there any obvious issues (hard-coded values, security concerns)?
- Are tests added for new functionality?

Record each concrete validation result with `openspec_record_validation_evidence`.
Use evidence type `test`, `lint`, `typecheck`, `manual`, `hook`,
`spec_alignment`, or `ci`. A task should not be treated as fully accepted until
its required behavior has passed evidence or a human review explicitly accepts
the gap.

### Step 3: Report Results
Present findings to the user in a structured format:
- **Pass**: No drift detected
- **Warnings**: Minor deviations (field naming, missing comments)
- **Issues**: Significant drift that needs fixing (missing interfaces, behavioral gaps)

**Gate: Validation Results** — Present findings and ask:
- If issues found: "Found X issue(s). Should I fix them?"
- If clean: "Validation passed. Ready to archive."

### Step 4: Remediation
If issues are found:
1. Fix the spec-or-code alignment
2. Update either the implementation or the spec document
3. Re-run validation until clean
4. For spec changes, update the relevant document and re-confirm with user

### Step 5: Transition
Once validation passes:
- State is ready for archive phase
- For loop-driven changes, request or resolve the validation review through
  `openspec_request_human_review` / `openspec_resolve_human_review`.
- For legacy flow, call `openspec_set_gate({ gate: "validation", confirmed: true })`
  after clean validation and human confirmation.
- Tell user they can run `openspec:archive` to finalize

## Output
- Drift report with issues and severity
- Optional: updated spec files or code fixes
- State transitions to ready-for-archive

## Customization Hooks
Teams can inject custom behavior:
- **Pre-validate**: Run the full test suite or lint checks
- **Post-validate**: Send validation report to code review channel
- **Auto-fix**: Apply auto-fixable issues (formatting, naming)
- **CI Integration**: Trigger CI pipeline for pre-merge checks
See `customize/SKILL.md` for details.
