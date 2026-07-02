import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  archiveChange,
  continueLoop,
  createChange,
  createGoal,
  createOrUpdateArtifact,
  detectLayout,
  buildDocsContext,
  checkDocsFreshness,
  searchDocs,
  syncSpecs,
  getGoal,
  getNextActions,
  getPendingHooks,
  initProject,
  listChanges,
  readArtifact,
  recordValidationEvidence,
  recordHookResult,
  requestHumanReview,
  resolveHumanReview,
  setGate,
  updateGoalStatus,
  updateTaskStatus,
  validateDrift,
} from '../src/openspec.js';
import { readState, writeState } from '../src/state.js';
import { STATE_FILE } from '../src/types.js';

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sdd-loop-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n', 'utf-8');
  return dir;
}

test('creates a spec-driven project and change directory with default artifacts', () => {
  const root = tmpProject();

  const init = initProject(root, { schema: 'spec-driven' });
  assert.equal(init.success, true);
  assert.equal(fs.existsSync(path.join(root, 'openspec/config.yaml')), true);
  assert.equal(fs.existsSync(path.join(root, 'openspec/schemas/spec-driven/schema.yaml')), true);

  const change = createChange(root, {
    description: 'Add avatar upload',
    preset: 'full',
    background: 'Users need profile pictures.',
    outOfScope: 'Image editing',
  });

  assert.equal(change.success, true);
  assert.match(change.changeId, /^add-avatar-upload-\d{8}$/);
  assert.equal(fs.existsSync(path.join(root, 'openspec/changes', change.changeId, 'proposal.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'openspec/changes', change.changeId, 'design.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'openspec/changes', change.changeId, 'tasks.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'openspec/changes', change.changeId, 'specs/spec.md')), true);

  const state = readState(root);
  assert.equal(state.version, 3);
  assert.equal(state.activeChangeId, change.changeId);
  assert.equal(state.changes[change.changeId].preset, 'full');
  assert.equal(state.changes[change.changeId].artifacts.proposal.status, 'done');
  assert.equal(state.changes[change.changeId].loop?.objective, 'Add avatar upload');
});

test('initializes docs layers and main specs directories', () => {
  const root = tmpProject();

  initProject(root, { schema: 'spec-driven' });

  assert.equal(fs.existsSync(path.join(root, 'openspec/specs')), true);
  assert.equal(fs.existsSync(path.join(root, 'openspec/project.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'openspec/AGENTS.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'docs/generated/global')), true);
  assert.equal(fs.existsSync(path.join(root, 'docs/generated/modules')), true);
  assert.equal(fs.existsSync(path.join(root, 'docs/reviewed/architecture')), true);
  assert.equal(fs.existsSync(path.join(root, 'docs/reviewed/modules')), true);
  assert.equal(fs.existsSync(path.join(root, 'docs/knowledge/global')), true);
  assert.equal(fs.existsSync(path.join(root, 'docs/knowledge/modules')), true);
});

test('searches docs layers and builds a bounded context pack', () => {
  const root = tmpProject();
  initProject(root);
  fs.writeFileSync(path.join(root, 'docs/knowledge/global/avatar.md'), 'Avatar upload uses image/webp compatibility notes.\n', 'utf-8');
  fs.writeFileSync(path.join(root, 'docs/reviewed/architecture/media.md'), 'Media service owns avatar storage.\n', 'utf-8');
  fs.mkdirSync(path.join(root, 'openspec/specs/avatar'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/specs/avatar/spec.md'), '# Avatar Spec\n\nExisting avatar requirements.\n', 'utf-8');

  const search = searchDocs(root, { query: 'avatar', layers: ['knowledge', 'reviewed'], limit: 10 });
  assert.equal(search.results.some((item) => item.path === 'docs/knowledge/global/avatar.md'), true);
  assert.equal(search.results.some((item) => item.path === 'docs/reviewed/architecture/media.md'), true);

  const context = buildDocsContext(root, { query: 'avatar upload', domains: ['avatar'], maxBytes: 800 });
  assert.equal(context.sources.some((item) => item.path === 'openspec/project.md'), true);
  assert.equal(context.sources.some((item) => item.path === 'openspec/specs/avatar/spec.md'), true);
  assert.match(context.content, /Avatar Spec/);
  assert.match(context.content, /compatibility notes/);
});

test('syncs change specs into domain specs and reports freshness', () => {
  const root = tmpProject();
  initProject(root);
  const change = createChange(root, { description: 'Add avatar upload', preset: 'full' });
  createOrUpdateArtifact(root, {
    artifactId: 'specs',
    content: '# Avatar Delta\n\n## ADDED Requirements\n\n### Requirement: Upload avatar\nThe system SHALL store avatar images.\n',
  });

  let freshness = checkDocsFreshness(root, { domains: ['avatar'] });
  assert.equal(freshness.stale.length, 1);
  assert.equal(freshness.stale[0].domain, 'avatar');

  const synced = syncSpecs(root, { domains: ['avatar'] });
  assert.equal(synced.updated.length, 1);
  const mainSpec = fs.readFileSync(path.join(root, 'openspec/specs/avatar/spec.md'), 'utf-8');
  assert.match(mainSpec, /Source change:/);
  assert.match(mainSpec, new RegExp(change.changeId));
  assert.match(mainSpec, /Upload avatar/);

  freshness = checkDocsFreshness(root, { domains: ['avatar'] });
  assert.equal(freshness.stale.length, 0);
});

test('migrates legacy single-change state into v2 state', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, '.openspec-codex'), { recursive: true });
  fs.writeFileSync(
    path.join(root, STATE_FILE),
    JSON.stringify({
      changeId: 'legacy-change',
      phase: 'implement',
      paths: {
        proposal: 'openspec/proposal.md',
        design: 'openspec/design.md',
        tasks: 'openspec/tasks.md',
        archiveDir: 'openspec/archive/',
      },
      confirmed: {
        scope: true,
        design: false,
        readyForImplement: true,
        readyForArchive: false,
      },
      nextAction: 'Legacy next action',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf-8',
  );

  const state = readState(root);
  assert.equal(state.version, 3);
  assert.equal(state.activeChangeId, 'legacy-change');
  assert.equal(state.changes['legacy-change'].phase, 'implement');
  assert.equal(state.changes['legacy-change'].gates.scope, true);
  assert.equal(state.changes['legacy-change'].paths.tasks, 'openspec/tasks.md');
});

test('migrates v2 state into v3 while preserving changes', () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, '.openspec-codex'), { recursive: true });
  fs.writeFileSync(
    path.join(root, STATE_FILE),
    JSON.stringify({
      version: 2,
      activeChangeId: 'v2-change',
      changes: {
        'v2-change': {
          changeId: 'v2-change',
          phase: 'implement',
          preset: 'tweak',
          schema: 'spec-driven',
          paths: { changeDir: 'openspec/changes/v2-change', tasks: 'openspec/changes/v2-change/tasks.md' },
          artifacts: {},
          gates: { scope: true, design: true, validation: false, archive: false },
          hooks: [],
          archived: false,
          nextAction: 'Continue',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf-8',
  );

  const state = readState(root);
  assert.equal(state.version, 3);
  assert.equal(state.activeChangeId, 'v2-change');
  assert.equal(state.changes['v2-change'].loop, undefined);
});

test('updates artifacts, tasks, hooks, validation, and archive state', () => {
  const root = tmpProject();
  initProject(root, {
    config: {
      hooks: {
        pre_archive: [{ kind: 'skill', name: 'implementation-notes-backfill', required: true }],
      },
    },
  });
  const change = createChange(root, { description: 'Fix login bug', preset: 'hotfix' });

  const updated = createOrUpdateArtifact(root, {
    artifactId: 'implementation_notes',
    content: '# Notes\n\nObserved idempotency issue.\n',
  });
  assert.equal(updated.success, true);

  let taskResult = updateTaskStatus(root, { taskId: 'T1', done: true });
  assert.equal(taskResult.success, true);
  taskResult = updateTaskStatus(root, { taskId: 'T2', done: true });
  assert.equal(taskResult.tasksRemaining, 0);

  const pendingHooks = getPendingHooks(root, { hookPoint: 'pre_archive' });
  assert.equal(pendingHooks.blocked, true);
  assert.equal(pendingHooks.hooks.length, 1);

  recordHookResult(root, {
    hookPoint: 'pre_archive',
    hookName: 'implementation-notes-backfill',
    status: 'passed',
    message: 'notes are complete',
  });

  const validation = validateDrift(root);
  assert.equal(validation.driftItems.some((item) => item.type === 'task_incomplete'), false);

  const archived = archiveChange(root, { message: 'Login bug fixed' });
  assert.equal(archived.success, true);
  assert.equal(fs.existsSync(path.join(root, archived.archiveDir, 'proposal.md')), true);
  assert.equal(fs.existsSync(path.join(root, archived.archiveDir, 'implementation-notes.md')), true);

  const changes = listChanges(root);
  assert.equal(changes.changes.find((item) => item.changeId === change.changeId)?.archived, true);
});

test('read artifact rejects path traversal and next actions reflect gates', () => {
  const root = tmpProject();
  initProject(root);
  createChange(root, { description: 'Add search filter', preset: 'tweak' });

  assert.throws(() => readArtifact(root, { artifactId: '../package.json' }), /Unknown artifact/);

  const next = getNextActions(root);
  assert.equal(next.actions[0].gate, 'scope');
  assert.match(next.actions[0].description, /Confirm scope/);

  const layout = detectLayout(root);
  assert.equal(layout.hasOpenSpec, true);
  assert.equal(layout.changes.length, 1);
});

test('goal loop creates decisions, records evidence, and enforces blocker threshold', () => {
  const root = tmpProject();
  initProject(root);
  const change = createChange(root, { description: 'Add search filter', preset: 'tweak' });

  const goal = createGoal(root, {
    objective: 'Deliver search filter with validation evidence',
    successCriteria: ['T1 and T2 are done', 'Validation evidence exists'],
  });
  assert.equal(goal.success, true);
  assert.equal(goal.loop.objective, 'Deliver search filter with validation evidence');
  assert.equal(goal.decision.kind, 'ask_human');
  assert.equal(goal.decision.requiredGate, 'scope_review');

  let continued = continueLoop(root);
  assert.equal(continued.status, 'waiting_for_human');
  assert.equal(continued.loop.humanReviews.length, 1);

  const review = continued.loop.humanReviews[0];
  resolveHumanReview(root, { reviewId: review.id, status: 'approved', resolution: 'Scope approved' });
  updateTaskStatus(root, { taskId: 'T1', done: true });
  updateTaskStatus(root, { taskId: 'T2', done: true });

  continued = continueLoop(root);
  assert.equal(continued.decision.kind, 'validate');
  assert.match(continued.decision.reason, /lacks passed validation evidence/);

  const evidence = recordValidationEvidence(root, {
    type: 'test',
    status: 'passed',
    summary: 'Focused test passed',
    command: 'npm test',
    relatedTaskIds: ['T1', 'T2'],
  });
  assert.equal(evidence.success, true);
  assert.equal(fs.existsSync(path.join(root, 'openspec/changes', change.changeId, 'verification.json')), true);

  assert.throws(() => updateGoalStatus(root, {
    status: 'blocked',
    blockerId: 'ci-failure',
    blockerDescription: 'CI unavailable',
  }), /Current count: 1/);
  assert.throws(() => updateGoalStatus(root, {
    status: 'blocked',
    blockerId: 'ci-failure',
    blockerDescription: 'CI unavailable',
  }), /Current count: 2/);
  const blocked = updateGoalStatus(root, {
    status: 'blocked',
    blockerId: 'ci-failure',
    blockerDescription: 'CI unavailable',
  });
  assert.equal(blocked.status, 'blocked');

  const current = getGoal(root);
  assert.equal(current.loop?.blockers.find((item) => item.id === 'ci-failure')?.count, 3);
});

test('human review requests can be resolved manually', () => {
  const root = tmpProject();
  initProject(root);
  createChange(root, { description: 'Risky change', preset: 'hotfix' });

  const requested = requestHumanReview(root, {
    gate: 'risk_review',
    reason: 'Public behavior is ambiguous',
    riskLevel: 'high',
    options: ['approve', 'revise'],
    recommendedOption: 'revise',
  });
  assert.equal(requested.review.status, 'pending');
  assert.equal(requested.loop.status, 'waiting_for_human');

  const resolved = resolveHumanReview(root, {
    reviewId: requested.review.id,
    status: 'approved',
    resolution: 'Proceed with documented scope',
  });
  assert.equal(resolved.review.status, 'approved');
  assert.equal(resolved.loop.status, 'running');
});

test('goal cannot be marked complete while archive is only the next decision', () => {
  const root = tmpProject();
  initProject(root);
  createChange(root, { description: 'Complete only after archive', preset: 'tweak' });
  createGoal(root, { objective: 'Complete after archive artifacts exist' });

  setGate(root, { gate: 'scope', confirmed: true });
  updateTaskStatus(root, { taskId: 'T1', done: true });
  updateTaskStatus(root, { taskId: 'T2', done: true });
  recordValidationEvidence(root, {
    type: 'test',
    status: 'passed',
    summary: 'All acceptance checks passed',
    relatedTaskIds: ['T1', 'T2'],
  });
  setGate(root, { gate: 'validation', confirmed: true });
  setGate(root, { gate: 'archive', confirmed: true });

  const decision = continueLoop(root);
  assert.equal(decision.decision.kind, 'archive');
  assert.throws(() => updateGoalStatus(root, { status: 'complete' }), /cannot be completed/i);

  const state = readState(root);
  assert.equal(state.changes[state.activeChangeId || '']?.archived, false);
});

test('loop asks for validation evidence before required pre archive hooks', () => {
  const root = tmpProject();
  initProject(root, {
    config: {
      hooks: {
        pre_archive: [{ kind: 'skill', name: 'release-notes-check', required: true }],
      },
    },
  });
  createChange(root, { description: 'Validate before archive hook', preset: 'tweak' });
  createGoal(root, { objective: 'Validate before archive hook' });

  setGate(root, { gate: 'scope', confirmed: true });
  updateTaskStatus(root, { taskId: 'T1', done: true });
  updateTaskStatus(root, { taskId: 'T2', done: true });

  const decision = continueLoop(root);
  assert.equal(decision.decision.kind, 'validate');
  assert.match(decision.decision.reason, /validation evidence/);
});

test('archive preserves loop state and structured validation evidence', () => {
  const root = tmpProject();
  initProject(root);
  const change = createChange(root, { description: 'Archive loop evidence', preset: 'tweak' });
  createGoal(root, { objective: 'Archive loop evidence' });
  setGate(root, { gate: 'scope', confirmed: true });
  updateTaskStatus(root, { taskId: 'T1', done: true });
  updateTaskStatus(root, { taskId: 'T2', done: true });
  recordValidationEvidence(root, {
    type: 'test',
    status: 'passed',
    summary: 'Regression suite passed',
    command: 'npm test',
    relatedTaskIds: ['T1', 'T2'],
  });

  const archived = archiveChange(root, { message: 'Loop evidence archived' });
  assert.equal(archived.success, true);
  assert.equal(fs.existsSync(path.join(root, archived.archiveDir, 'verification.json')), true);

  const metadata = JSON.parse(fs.readFileSync(path.join(root, archived.archiveDir, 'archive-metadata.json'), 'utf-8'));
  assert.equal(metadata.loop.objective, 'Archive loop evidence');
  assert.equal(metadata.loop.validationEvidence.length, 1);
  assert.equal(metadata.loop.validationEvidence[0].summary, 'Regression suite passed');
  assert.equal(metadata.changeId, change.changeId);
});
