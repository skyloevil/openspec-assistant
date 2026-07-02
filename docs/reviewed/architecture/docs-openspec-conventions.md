# Docs and OpenSpec Conventions

This project keeps change workflow, durable specs, and reusable engineering context
in separate layers. The goal is to let agents read the right context before they
write a proposal, while keeping reviewed human knowledge distinct from generated
indexes.

## Directory Model

```text
openspec/
  project.md
  AGENTS.md
  config.yaml
  specs/<domain>/spec.md
  changes/<changeId>/
    proposal.md
    specs/spec.md
    design.md
    tasks.md
    verification.md
    implementation-notes.md
docs/
  generated/
    global/
    modules/
  reviewed/
    architecture/
    modules/
    integration/
    deployment/
  knowledge/
    global/
    modules/
```

## OpenSpec Layer

`openspec/changes/<changeId>/` is the working area for one change. It contains the
proposal, delta spec, design, tasks, validation evidence, and implementation notes.
Agents may update these files during the active workflow.

`openspec/specs/<domain>/spec.md` is the durable domain spec. Before archive, the
active change delta should be synced into the relevant domain spec with
`openspec_sync_specs`. If the domain is not known, use `general`.

`openspec/project.md` stores project-wide technical context. `openspec/AGENTS.md`
stores agent behavior guidance for the repository.

## Docs Layers

`docs/generated/` is machine generated. It should contain code indexes, module maps,
entry points, configuration indexes, and dependency summaries. Generated files should
be reproducible and safe to overwrite.

`docs/reviewed/` is human-reviewed project documentation. It should contain stable
architecture notes, integration flows, deployment notes, and module-level design
documents. Agents may propose edits, but substantial changes should be reviewed.

`docs/knowledge/` is accumulated operational knowledge. It should contain pitfalls,
compatibility notes, implementation lessons, and decisions discovered during past
changes. Entries should be concise and traceable to a source change when possible.

## Read Path

Proposal and planning skills should call `docs_build_context` before writing new
artifacts. The context pack should include:

- `openspec/project.md`
- `openspec/AGENTS.md`
- relevant `openspec/specs/<domain>/spec.md`
- matching generated docs
- matching reviewed docs
- matching knowledge notes

For targeted lookup, use `docs_search`. For historical pitfalls and decisions, use
`knowledge_search`.

## Write Path

During implementation, write change-specific findings into
`openspec/changes/<changeId>/implementation-notes.md`. Keep durable docs updates
separate from implementation churn.

Before archive:

1. Call `openspec_sync_specs` for affected domains.
2. Call `docs_check_freshness` to confirm domain specs include the active change.
3. Archive the change with `openspec_archive_change`.

Future generated docs should use manifests that record source files, content hashes,
and generator metadata. Reviewed and knowledge docs should prefer append-only,
traceable updates unless a human explicitly approves replacement.

## Compatibility Rules

Existing changes that only have `openspec/changes/<changeId>/specs/spec.md` remain
valid. Domain specs are an additional durable layer, not a replacement for change
artifacts.

Archive should not delete change artifacts. Archived changes remain the audit trail;
domain specs and docs layers are optimized for future context retrieval.
