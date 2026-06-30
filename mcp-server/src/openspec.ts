import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ArtifactId,
  ChangeState,
  DetectResult,
  DriftItem,
  GateMode,
  HookDefinition,
  HookResult,
  HumanGate,
  HumanReviewRecord,
  LoopDecision,
  LoopIterationRecord,
  NextAction,
  OpenSpecState,
  Preset,
  ProjectConfig,
  ResponseFormat,
  TaskItem,
  ValidationEvidence,
  ValidationEvidenceStatus,
  ValidationEvidenceType,
} from './types.js';
import {
  ARCHIVE_DIR,
  CHANGES_DIR,
  DEFAULT_OPENSPEC_DIR,
  DEFAULT_PROJECT_CONFIG,
} from './types.js';
import { createLoopState, ensureLoopState, getActiveChange, readState, resolveProjectRoot, setActiveChange, updatePhase, writeState } from './state.js';

type ArtifactDefinition = {
  id: ArtifactId;
  path: string;
  requires: ArtifactId[];
  title: string;
};

const ARTIFACTS: Record<ArtifactId, ArtifactDefinition> = {
  proposal: { id: 'proposal', path: 'proposal.md', requires: [], title: 'Proposal' },
  specs: { id: 'specs', path: 'specs/spec.md', requires: ['proposal'], title: 'Specification' },
  design: { id: 'design', path: 'design.md', requires: ['proposal', 'specs'], title: 'Design' },
  tasks: { id: 'tasks', path: 'tasks.md', requires: ['proposal'], title: 'Tasks' },
  verification: { id: 'verification', path: 'verification.md', requires: ['tasks'], title: 'Verification' },
  implementation_notes: {
    id: 'implementation_notes',
    path: 'implementation-notes.md',
    requires: ['tasks'],
    title: 'Implementation Notes',
  },
};

const PRESET_ARTIFACTS: Record<Preset, ArtifactId[]> = {
  full: ['proposal', 'specs', 'design', 'tasks', 'verification', 'implementation_notes'],
  hotfix: ['proposal', 'tasks', 'verification', 'implementation_notes'],
  tweak: ['proposal', 'tasks', 'verification', 'implementation_notes'],
};

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function writeFileSafe(filePath: string, content: string): boolean {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

function safeJoin(projectRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Path must be relative to project root: ${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  const fullPath = path.resolve(projectRoot, normalized);
  const rootPath = path.resolve(projectRoot);
  if (fullPath !== rootPath && !fullPath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return fullPath;
}

function generateChangeId(description: string): string {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const asciiSlug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const fallback = `change-${Date.now().toString(36)}`;
  return `${asciiSlug || fallback}-${dateStr}`;
}

function now(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function mergeConfig(input?: Partial<ProjectConfig>): ProjectConfig {
  return {
    ...structuredClone(DEFAULT_PROJECT_CONFIG),
    ...input,
    interaction: {
      ...DEFAULT_PROJECT_CONFIG.interaction,
      ...input?.interaction,
    },
    rules: input?.rules || {},
    hooks: input?.hooks || {},
  };
}

function configToYaml(config: ProjectConfig): string {
  const context = config.context ? indentBlock(config.context, 2) : '  团队技术栈、接口规范、缓存/锁/历史兼容规则';
  const rules = Object.entries(config.rules);
  const hooks = Object.entries(config.hooks);

  return `version: ${config.version}
schema: ${config.schema}
interaction:
  autoTransition: ${config.interaction.autoTransition}
  defaultGate: ${config.interaction.defaultGate}
context: |
${context}
rules:
${rules.length ? rules.map(([artifact, values]) => `  ${artifact}:\n${values.map((item) => `    - ${item}`).join('\n')}`).join('\n') : '  design:\n    - 必须说明接口字段、Redis Key、用户锁范围和兼容逻辑'}
hooks:
${hooks.length ? hooks.map(([hookPoint, defs]) => `  ${hookPoint}:\n${defs.map((hook) => `    - kind: ${hook.kind}\n      name: ${hook.name}\n      required: ${hook.required}${hook.command ? `\n      command: ${hook.command}` : ''}`).join('\n')}`).join('\n') : '  pre_proposal: []'}
`;
}

function indentBlock(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function readProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = path.join(projectRoot, DEFAULT_OPENSPEC_DIR, 'config.yaml');
  const raw = readFileSafe(configPath);
  if (!raw) {
    return structuredClone(DEFAULT_PROJECT_CONFIG);
  }
  return parseProjectConfig(raw);
}

function parseProjectConfig(raw: string): ProjectConfig {
  const config = structuredClone(DEFAULT_PROJECT_CONFIG);
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    if (line.startsWith('version:')) {
      config.version = Number(line.split(':').slice(1).join(':').trim()) || 1;
    } else if (line.startsWith('schema:')) {
      config.schema = line.split(':').slice(1).join(':').trim() || 'spec-driven';
    } else if (line.startsWith('interaction:')) {
      i = parseInteraction(lines, i + 1, config) - 1;
    } else if (line.startsWith('context: |')) {
      const contextLines: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || !lines[i].trim())) {
        contextLines.push(lines[i].replace(/^  /, ''));
        i++;
      }
      config.context = contextLines.join('\n').trimEnd();
      continue;
    } else if (line.startsWith('rules:')) {
      i = parseRules(lines, i + 1, config) - 1;
    } else if (line.startsWith('hooks:')) {
      i = parseHooks(lines, i + 1, config) - 1;
    }
    i++;
  }
  return config;
}

function parseInteraction(lines: string[], start: number, config: ProjectConfig): number {
  let i = start;
  while (i < lines.length && lines[i].startsWith('  ')) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('autoTransition:')) {
      config.interaction.autoTransition = trimmed.endsWith('true');
    } else if (trimmed.startsWith('defaultGate:')) {
      const gate = trimmed.split(':').slice(1).join(':').trim();
      if (gate === 'auto' || gate === 'review' || gate === 'manual') {
        config.interaction.defaultGate = gate;
      }
    }
    i++;
  }
  return i;
}

function parseRules(lines: string[], start: number, config: ProjectConfig): number {
  config.rules = {};
  let i = start;
  let currentKey = '';
  while (i < lines.length && lines[i].startsWith('  ')) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }
    if (!trimmed.startsWith('-') && trimmed.endsWith(':')) {
      currentKey = trimmed.slice(0, -1);
      config.rules[currentKey] = [];
    } else if (currentKey && trimmed.startsWith('-')) {
      config.rules[currentKey].push(trimmed.replace(/^-\s*/, ''));
    }
    i++;
  }
  return i;
}

function parseHooks(lines: string[], start: number, config: ProjectConfig): number {
  config.hooks = {};
  let i = start;
  let hookPoint = '';
  let current: HookDefinition | null = null;
  while (i < lines.length && lines[i].startsWith('  ')) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }
    if (!trimmed.startsWith('-') && trimmed.endsWith(':')) {
      hookPoint = trimmed.slice(0, -1);
      config.hooks[hookPoint] = [];
      current = null;
    } else if (hookPoint && trimmed === '[]') {
      config.hooks[hookPoint] = [];
      current = null;
    } else if (hookPoint && trimmed.startsWith('- kind:')) {
      current = {
        kind: trimmed.split(':').slice(1).join(':').trim() as HookDefinition['kind'],
        name: '',
        required: false,
      };
      config.hooks[hookPoint].push(current);
    } else if (current && trimmed.startsWith('name:')) {
      current.name = trimmed.split(':').slice(1).join(':').trim();
    } else if (current && trimmed.startsWith('required:')) {
      current.required = trimmed.endsWith('true');
    } else if (current && trimmed.startsWith('command:')) {
      current.command = trimmed.split(':').slice(1).join(':').trim();
    }
    i++;
  }
  return i;
}

function artifactRelativePath(changeDir: string, artifactId: ArtifactId): string {
  const def = ARTIFACTS[artifactId];
  if (!def) {
    throw new Error(`Unknown artifact: ${artifactId}`);
  }
  return path.posix.join(changeDir, def.path);
}

function createArtifactContent(
  artifactId: ArtifactId,
  changeId: string,
  description: string,
  preset: Preset,
  background?: string,
  outOfScope?: string,
): string {
  switch (artifactId) {
    case 'proposal':
      return `# ${changeId}

## Background
${background || description}

## Requirement
${description}

## Scope
### In Scope
- Define the requested behavior and affected capabilities.

### Out of Scope
${outOfScope || '- To be confirmed during scope review.'}

## Acceptance Criteria
- [ ] Main path works.
- [ ] Interface behavior is aligned with design/specs.
- [ ] Compatibility and edge cases are covered.

---
Preset: ${preset}
Created: ${now()}
`;
    case 'specs':
      return `# ${changeId} Specification

## ADDED Requirements

### Requirement: ${description}
The system SHALL support the requested behavior.

#### Scenario: Main path
- GIVEN the user exercises the main workflow
- WHEN the change is active
- THEN the expected behavior is available and compatible with existing flows.
`;
    case 'design':
      return `# ${changeId} Design

## Architecture
- Describe the implementation approach.

## Interfaces
- List new or changed APIs, request fields, response fields, and compatibility rules.

## Data, Cache, and Locking
- Document persistence, Redis keys, user lock scope, idempotency, and historical compatibility.

## Risks
- Record high-risk assumptions before implementation.
`;
    case 'tasks':
      return tasksContent(changeId, defaultTasks(preset));
    case 'verification':
      return `# ${changeId} Verification

## Checks
- [ ] TypeScript/build checks
- [ ] Unit tests
- [ ] Integration or manual acceptance scenarios
- [ ] Spec drift reviewed

## Evidence
- Pending.
`;
    case 'implementation_notes':
      return `# ${changeId} Implementation Notes

## Debugging Notes
- Record interface naming, response field, lock scope, compatibility, and self-test findings here.

## Follow-up Knowledge
- Pending archive summary.
`;
  }
}

function defaultTasks(preset: Preset): TaskItem[] {
  if (preset === 'full') {
    return [
      { id: 'T1', description: 'Implement core behavior described by the proposal/specs', done: false, priority: 'high' },
      { id: 'T2', description: 'Update interfaces and compatibility paths from design.md', done: false, priority: 'high' },
      { id: 'T3', description: 'Add or update tests for acceptance scenarios', done: false, priority: 'medium' },
      { id: 'T4', description: 'Record implementation notes and validation evidence', done: false, priority: 'medium' },
    ];
  }
  return [
    { id: 'T1', description: 'Implement the requested change with minimal scope', done: false, priority: 'high' },
    { id: 'T2', description: 'Verify behavior and record notes', done: false, priority: 'medium' },
  ];
}

function tasksContent(changeId: string, tasks: TaskItem[]): string {
  const lines = tasks.map((task) => `- [${task.done ? 'x' : ' '}] **${task.id}** [${task.priority}] ${task.description}`);
  return `# ${changeId} Tasks

## Task List
${lines.join('\n')}

## Progress
- Done: ${tasks.filter((task) => task.done).length} / ${tasks.length}
`;
}

function updateProgress(content: string): string {
  const total = (content.match(/- \[[ x]\]/g) || []).length;
  const done = (content.match(/- \[x\]/g) || []).length;
  if (/## Progress\n- Done: \d+ \/ \d+/.test(content)) {
    return content.replace(/## Progress\n- Done: \d+ \/ \d+/, `## Progress\n- Done: ${done} / ${total}`);
  }
  return `${content.trimEnd()}\n\n## Progress\n- Done: ${done} / ${total}\n`;
}

function createDefaultSchema(projectRoot: string): void {
  const schemaDir = path.join(projectRoot, DEFAULT_OPENSPEC_DIR, 'schemas', 'spec-driven');
  ensureDir(path.join(schemaDir, 'templates'));
  writeFileSafe(
    path.join(schemaDir, 'schema.yaml'),
    `name: spec-driven
version: 1
description: Default OpenSpec Assistant workflow
artifacts:
  - id: proposal
    generates: proposal.md
    requires: []
  - id: specs
    generates: specs/spec.md
    requires: [proposal]
  - id: design
    generates: design.md
    requires: [proposal, specs]
  - id: tasks
    generates: tasks.md
    requires: [proposal, design]
apply:
  requires: [tasks]
  tracks: tasks.md
`,
  );
  for (const artifactId of Object.keys(ARTIFACTS) as ArtifactId[]) {
    writeFileSafe(
      path.join(schemaDir, 'templates', ARTIFACTS[artifactId].path.replace(/\//g, '-')),
      `# ${ARTIFACTS[artifactId].title}\n\nUse project context, artifact rules, and current change documents to create this artifact.\n`,
    );
  }
}

function createChangeState(
  changeId: string,
  preset: Preset,
  schema: string,
  artifactIds: ArtifactId[],
): ChangeState {
  const createdAt = now();
  const changeDir = path.posix.join(CHANGES_DIR, changeId);
  const change: ChangeState = {
    changeId,
    phase: 'propose',
    preset,
    schema,
    paths: {
      changeDir,
      archiveDir: ARCHIVE_DIR,
    },
    artifacts: {},
    gates: {
      scope: false,
      design: preset !== 'full',
      validation: false,
      archive: false,
    },
    hooks: [],
    archived: false,
    nextAction: 'Confirm scope before continuing to design or implementation.',
    createdAt,
    updatedAt: createdAt,
  };

  for (const artifactId of artifactIds) {
    const artifactPath = artifactRelativePath(changeDir, artifactId);
    change.artifacts[artifactId] = {
      id: artifactId,
      path: artifactPath,
      status: 'done',
      requires: ARTIFACTS[artifactId].requires.filter((id) => artifactIds.includes(id)),
      updatedAt: createdAt,
    };
    if (artifactId === 'proposal') change.paths.proposal = artifactPath;
    if (artifactId === 'specs') {
      change.paths.specs = artifactPath;
      change.paths.specsDir = path.posix.join(changeDir, 'specs');
    }
    if (artifactId === 'design') change.paths.design = artifactPath;
    if (artifactId === 'tasks') change.paths.tasks = artifactPath;
    if (artifactId === 'verification') change.paths.verification = artifactPath;
    if (artifactId === 'implementation_notes') change.paths.implementationNotes = artifactPath;
  }
  return change;
}

function requireActiveChange(projectRoot: string): { state: OpenSpecState; change: ChangeState } {
  const state = readState(projectRoot);
  const change = getActiveChange(state);
  if (!change) {
    throw new Error('No active OpenSpec change. Create a change first.');
  }
  return { state, change };
}

function countRemainingTasks(projectRoot: string, change: ChangeState): number {
  if (!change.paths.tasks) return 0;
  const content = readFileSafe(safeJoin(projectRoot, change.paths.tasks));
  return content ? (content.match(/- \[ \]/g) || []).length : 0;
}

function firstIncompleteTaskId(projectRoot: string, change: ChangeState): string | undefined {
  if (!change.paths.tasks) return undefined;
  const content = readFileSafe(safeJoin(projectRoot, change.paths.tasks));
  const match = content?.match(/- \[ \] \*\*(T\d+)\*\*/);
  return match?.[1];
}

function countCompletedTasks(projectRoot: string, change: ChangeState): number {
  if (!change.paths.tasks) return 0;
  const content = readFileSafe(safeJoin(projectRoot, change.paths.tasks));
  return content ? (content.match(/- \[x\]/g) || []).length : 0;
}

function taskHasPassedEvidence(change: ChangeState, taskId: string): boolean {
  return Boolean(change.loop?.validationEvidence.some((evidence) => (
    evidence.status === 'passed' && evidence.relatedTaskIds.includes(taskId)
  )));
}

function allCompletedTasksHaveEvidence(projectRoot: string, change: ChangeState): boolean {
  if (!change.paths.tasks) return true;
  const content = readFileSafe(safeJoin(projectRoot, change.paths.tasks));
  if (!content) return false;
  const completedTaskIds = [...content.matchAll(/- \[x\] \*\*(T\d+)\*\*/g)].map((match) => match[1]);
  return completedTaskIds.every((taskId) => taskHasPassedEvidence(change, taskId));
}

function hasPendingHumanReview(change: ChangeState): boolean {
  return Boolean(change.loop?.humanReviews.some((review) => review.status === 'pending'));
}

function recordBlocker(change: ChangeState, id: string, description: string): number {
  const loop = ensureLoopState(change);
  const timestamp = now();
  const existing = loop.blockers.find((blocker) => blocker.id === id);
  if (existing) {
    existing.count += 1;
    existing.description = description;
    existing.lastSeenAt = timestamp;
    return existing.count;
  }
  loop.blockers.push({
    id,
    description,
    count: 1,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
  });
  return 1;
}

function createDecision(
  kind: LoopDecision['kind'],
  reason: string,
  nextAction: string,
  riskLevel: LoopDecision['riskLevel'] = 'low',
  extra: Partial<LoopDecision> = {},
): LoopDecision {
  return { kind, reason, nextAction, riskLevel, ...extra };
}

function deriveLoopDecision(projectRoot: string, change: ChangeState): LoopDecision {
  if (change.archived || change.phase === 'complete') {
    return createDecision('complete', 'The active change is already archived.', 'No further action is required.');
  }
  if (hasPendingHumanReview(change)) {
    return createDecision(
      'ask_human',
      'A human review is already pending.',
      'Resolve the pending human review before continuing.',
      'medium',
      { requiredGate: change.loop?.humanReviews.find((review) => review.status === 'pending')?.gate },
    );
  }
  if (!change.gates.scope) {
    return createDecision(
      'ask_human',
      'Scope has not been approved.',
      `Review and approve the scope for ${change.changeId}.`,
      'medium',
      { requiredGate: 'scope_review' },
    );
  }
  if (change.preset === 'full' && !change.gates.design) {
    return createDecision(
      'ask_human',
      'Design has not been approved.',
      `Review and approve the technical design for ${change.changeId}.`,
      'medium',
      { requiredGate: 'design_review' },
    );
  }
  const taskId = firstIncompleteTaskId(projectRoot, change);
  if (taskId) {
    return createDecision(
      'act',
      'There is an incomplete implementation task.',
      `Implement the next incomplete task: ${taskId}.`,
      'low',
      { taskId },
    );
  }
  if (!allCompletedTasksHaveEvidence(projectRoot, change)) {
    return createDecision(
      'validate',
      'At least one completed task lacks passed validation evidence.',
      'Run focused validation and record evidence for completed tasks.',
      'medium',
    );
  }
  if (!change.gates.validation) {
    return createDecision(
      'validate',
      'Validation has not been confirmed.',
      'Run validation and request validation review when clean.',
      'medium',
      { requiredGate: 'validation_review' },
    );
  }
  const pendingPreArchive = getPendingHooks(projectRoot, { hookPoint: 'pre_archive', changeId: change.changeId });
  if (pendingPreArchive.blocked) {
    return createDecision(
      'run_hook',
      'A required pre_archive hook is pending or failed.',
      'Run or resolve required pre_archive hooks before archiving.',
      'medium',
      { hookPoint: 'pre_archive' },
    );
  }
  if (!change.gates.archive) {
    return createDecision(
      'ask_human',
      'Archive approval has not been granted.',
      `Review archive readiness for ${change.changeId}.`,
      'medium',
      { requiredGate: 'archive_review' },
    );
  }
  return createDecision('archive', 'All loop completion prerequisites are satisfied.', `Archive ${change.changeId}.`);
}

function formatResponse(data: unknown, format: ResponseFormat = 'json'): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }
  if (typeof data !== 'object' || data === null) {
    return String(data);
  }
  return Object.entries(data as Record<string, unknown>)
    .map(([key, value]) => `- **${key}**: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
}

export function initProject(
  projectRoot: string,
  options: { schema?: string; config?: Partial<ProjectConfig>; overwrite?: boolean } = {},
): { success: boolean; configPath: string; schemaDir: string } {
  const config = mergeConfig({ ...options.config, schema: options.schema || options.config?.schema || 'spec-driven' });
  const openspecDir = path.join(projectRoot, DEFAULT_OPENSPEC_DIR);
  ensureDir(openspecDir);
  ensureDir(path.join(projectRoot, CHANGES_DIR));
  const configPath = path.join(openspecDir, 'config.yaml');
  if (options.overwrite || !fs.existsSync(configPath)) {
    writeFileSafe(configPath, configToYaml(config));
  }
  createDefaultSchema(projectRoot);
  const state = readState(projectRoot);
  writeState(projectRoot, state);
  return {
    success: true,
    configPath: path.posix.join(DEFAULT_OPENSPEC_DIR, 'config.yaml'),
    schemaDir: path.posix.join(DEFAULT_OPENSPEC_DIR, 'schemas', config.schema),
  };
}

export function detectLayout(startDir?: string): DetectResult {
  const projectRoot = resolveProjectRoot(startDir);
  const state = readState(projectRoot);
  const existingDirs: string[] = [];
  const existingFiles: string[] = [];
  for (const dir of [DEFAULT_OPENSPEC_DIR, CHANGES_DIR, ARCHIVE_DIR, '.openspec-codex']) {
    if (fs.existsSync(path.join(projectRoot, dir))) existingDirs.push(dir);
  }
  for (const file of [`${DEFAULT_OPENSPEC_DIR}/config.yaml`, `${DEFAULT_OPENSPEC_DIR}/proposal.md`, `${DEFAULT_OPENSPEC_DIR}/design.md`, `${DEFAULT_OPENSPEC_DIR}/tasks.md`]) {
    if (fs.existsSync(path.join(projectRoot, file))) existingFiles.push(file);
  }
  const changes = Object.values(state.changes).map((change) => ({
    changeId: change.changeId,
    phase: change.phase,
    archived: change.archived,
    preset: change.preset,
  }));
  return {
    hasOpenSpec: existingDirs.length > 0 || existingFiles.length > 0 || changes.length > 0,
    state: existingDirs.length || existingFiles.length || changes.length ? state : null,
    existingDirs,
    existingFiles,
    changes,
  };
}

export function createChange(
  projectRoot: string,
  options: {
    description: string;
    preset?: Preset;
    background?: string;
    outOfScope?: string;
    schema?: string;
  },
): { success: boolean; changeId: string; changeDir: string; state: ChangeState } {
  initProject(projectRoot, { schema: options.schema });
  const config = readProjectConfig(projectRoot);
  const preset = options.preset || 'full';
  const changeId = generateChangeId(options.description);
  const artifactIds = PRESET_ARTIFACTS[preset];
  const change = createChangeState(changeId, preset, options.schema || config.schema, artifactIds);
  change.loop = createLoopState(options.description, [
    'All required OpenSpec tasks are completed.',
    'Required validation evidence is recorded.',
    'Required hooks pass or are explicitly reviewed.',
  ], config.interaction.defaultGate);

  for (const artifactId of artifactIds) {
    const relativePath = artifactRelativePath(change.paths.changeDir, artifactId);
    writeFileSafe(
      safeJoin(projectRoot, relativePath),
      createArtifactContent(artifactId, changeId, options.description, preset, options.background, options.outOfScope),
    );
  }

  const state = readState(projectRoot);
  setActiveChange(state, change);
  writeState(projectRoot, state);
  return {
    success: true,
    changeId,
    changeDir: change.paths.changeDir,
    state: change,
  };
}

export function createGoal(
  projectRoot: string,
  options: {
    objective?: string;
    successCriteria?: string[];
    mode?: GateMode;
    tokenBudget?: number;
    maxIterations?: number;
    maxRuntimeMs?: number;
    changeId?: string;
  } = {},
): { success: boolean; changeId: string; loop: NonNullable<ChangeState['loop']>; decision: LoopDecision } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  const loop = createLoopState(
    options.objective || change.nextAction || change.changeId,
    options.successCriteria || [
      'All required OpenSpec tasks are completed.',
      'Required validation evidence is recorded.',
      'Required human gates are approved.',
    ],
    options.mode || readProjectConfig(projectRoot).interaction.defaultGate,
  );
  if (options.tokenBudget || options.maxIterations || options.maxRuntimeMs) {
    loop.budget = {
      tokenBudget: options.tokenBudget,
      maxIterations: options.maxIterations,
      maxRuntimeMs: options.maxRuntimeMs,
    };
  }
  change.loop = loop;
  const decision = deriveLoopDecision(projectRoot, change);
  loop.lastDecision = decision;
  loop.status = decision.kind === 'ask_human' ? 'waiting_for_human' : 'running';
  loop.usage.updatedAt = now();
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return { success: true, changeId: change.changeId, loop, decision };
}

export function getGoal(projectRoot: string): {
  activeChangeId?: string;
  phase: string;
  loop: ChangeState['loop'] | null;
  decision: LoopDecision | null;
  tasks: { completed: number; remaining: number };
} {
  const state = readState(projectRoot);
  const change = getActiveChange(state);
  if (!change) {
    return { phase: 'idle', loop: null, decision: null, tasks: { completed: 0, remaining: 0 } };
  }
  const loop = ensureLoopState(change, change.nextAction || change.changeId);
  const decision = deriveLoopDecision(projectRoot, change);
  loop.lastDecision = decision;
  loop.usage.updatedAt = now();
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return {
    activeChangeId: change.changeId,
    phase: change.phase,
    loop,
    decision,
    tasks: {
      completed: countCompletedTasks(projectRoot, change),
      remaining: countRemainingTasks(projectRoot, change),
    },
  };
}

export function continueLoop(projectRoot: string): {
  changeId: string;
  status: NonNullable<ChangeState['loop']>['status'];
  decision: LoopDecision;
  loop: NonNullable<ChangeState['loop']>;
} {
  const { state, change } = requireActiveChange(projectRoot);
  const loop = ensureLoopState(change, change.nextAction || change.changeId);
  const decision = deriveLoopDecision(projectRoot, change);
  loop.lastDecision = decision;
  loop.usage.iterations += 1;
  loop.usage.updatedAt = now();
  if (decision.kind === 'ask_human') {
    loop.status = 'waiting_for_human';
    if (decision.requiredGate && !loop.humanReviews.some((review) => review.status === 'pending' && review.gate === decision.requiredGate)) {
      loop.humanReviews.push(createHumanReview(decision.requiredGate, decision.reason, decision.riskLevel));
    }
  } else if (decision.kind === 'validate') {
    loop.status = 'validating';
  } else if (decision.kind === 'complete') {
    loop.status = 'complete';
  } else if (decision.kind === 'blocked') {
    loop.status = 'blocked';
  } else {
    loop.status = 'running';
  }
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return { changeId: change.changeId, status: loop.status, decision, loop };
}

function createHumanReview(gate: HumanGate, reason: string, riskLevel: LoopDecision['riskLevel']): HumanReviewRecord {
  return {
    id: createId('review'),
    gate,
    status: 'pending',
    reason,
    riskLevel,
    options: ['approve', 'revise', 'cancel'],
    recommendedOption: 'approve',
    createdAt: now(),
  };
}

export function requestHumanReview(
  projectRoot: string,
  options: {
    gate: HumanGate;
    reason: string;
    riskLevel?: LoopDecision['riskLevel'];
    options?: string[];
    recommendedOption?: string;
    changeId?: string;
  },
): { success: boolean; review: HumanReviewRecord; loop: NonNullable<ChangeState['loop']> } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  const loop = ensureLoopState(change);
  const review = createHumanReview(options.gate, options.reason, options.riskLevel || 'medium');
  if (options.options) review.options = options.options;
  if (options.recommendedOption) review.recommendedOption = options.recommendedOption;
  loop.status = 'waiting_for_human';
  loop.humanReviews.push(review);
  loop.usage.updatedAt = now();
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return { success: true, review, loop };
}

export function resolveHumanReview(
  projectRoot: string,
  options: { reviewId: string; status: HumanReviewRecord['status']; resolution?: string; changeId?: string },
): { success: boolean; review: HumanReviewRecord; loop: NonNullable<ChangeState['loop']> } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  const loop = ensureLoopState(change);
  const review = loop.humanReviews.find((item) => item.id === options.reviewId);
  if (!review) throw new Error(`Human review not found: ${options.reviewId}`);
  review.status = options.status;
  review.resolution = options.resolution;
  review.resolvedAt = now();
  if (options.status === 'approved') {
    if (review.gate === 'scope_review') {
      change.gates.scope = true;
      updatePhase(change, change.preset === 'full' ? 'plan' : 'implement', change.preset === 'full' ? 'Scope approved. Confirm design before implementation.' : 'Scope approved. Continue implementation tasks.');
    } else if (review.gate === 'design_review') {
      change.gates.design = true;
      updatePhase(change, 'implement', 'Design approved. Continue implementation tasks.');
    } else if (review.gate === 'validation_review') {
      change.gates.validation = true;
      updatePhase(change, 'archive', 'Validation approved. Ready for archive review.');
    } else if (review.gate === 'archive_review') {
      change.gates.archive = true;
      updatePhase(change, 'archive', 'Archive approved. Ready to archive.');
    }
  }
  loop.status = options.status === 'approved' ? 'running' : 'waiting_for_human';
  loop.usage.updatedAt = now();
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return { success: true, review, loop };
}

export function recordIteration(
  projectRoot: string,
  options: {
    taskId?: string;
    summary: string;
    filesChanged?: string[];
    commandsRun?: string[];
    testResults?: string[];
    errors?: string[];
    evidenceRefs?: string[];
    changeId?: string;
  },
): { success: boolean; iteration: LoopIterationRecord; loop: NonNullable<ChangeState['loop']> } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  const loop = ensureLoopState(change);
  const iteration: LoopIterationRecord = {
    id: createId('iteration'),
    taskId: options.taskId,
    summary: options.summary,
    filesChanged: options.filesChanged || [],
    commandsRun: options.commandsRun || [],
    testResults: options.testResults || [],
    errors: options.errors || [],
    evidenceRefs: options.evidenceRefs || [],
    createdAt: now(),
  };
  loop.iterations.push(iteration);
  loop.currentTaskId = options.taskId;
  loop.usage.updatedAt = now();
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return { success: true, iteration, loop };
}

export function recordValidationEvidence(
  projectRoot: string,
  options: {
    type: ValidationEvidenceType;
    status: ValidationEvidenceStatus;
    summary: string;
    command?: string;
    relatedTaskIds?: string[];
    relatedCriteria?: string[];
    changeId?: string;
  },
): { success: boolean; evidence: ValidationEvidence; loop: NonNullable<ChangeState['loop']> } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  const loop = ensureLoopState(change);
  const evidence: ValidationEvidence = {
    id: createId('evidence'),
    type: options.type,
    status: options.status,
    command: options.command,
    summary: options.summary,
    relatedTaskIds: options.relatedTaskIds || [],
    relatedCriteria: options.relatedCriteria || [],
    createdAt: now(),
  };
  loop.validationEvidence.push(evidence);
  loop.usage.updatedAt = now();
  state.changes[change.changeId] = change;
  writeValidationJson(projectRoot, change);
  appendEvidence(projectRoot, change, `- Evidence ${evidence.id}: ${evidence.type}/${evidence.status} - ${evidence.summary}`);
  writeState(projectRoot, state);
  return { success: true, evidence, loop };
}

function writeValidationJson(projectRoot: string, change: ChangeState): void {
  const filePath = safeJoin(projectRoot, path.posix.join(change.paths.changeDir, 'verification.json'));
  writeFileSafe(filePath, JSON.stringify({ changeId: change.changeId, evidence: change.loop?.validationEvidence || [] }, null, 2));
}

export function updateGoalStatus(
  projectRoot: string,
  options: { status: 'complete' | 'blocked' | 'cancelled'; blockerId?: string; blockerDescription?: string; changeId?: string },
): { success: boolean; status: NonNullable<ChangeState['loop']>['status']; loop: NonNullable<ChangeState['loop']> } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  const loop = ensureLoopState(change);
  if (options.status === 'complete') {
    const decision = deriveLoopDecision(projectRoot, change);
    if (decision.kind !== 'complete') {
      throw new Error(`Goal cannot be completed yet: ${decision.reason}`);
    }
    loop.status = 'complete';
  } else if (options.status === 'blocked') {
    const count = recordBlocker(change, options.blockerId || 'manual-blocker', options.blockerDescription || 'Goal is blocked.');
    if (count < 3) {
      loop.usage.updatedAt = now();
      state.changes[change.changeId] = change;
      writeState(projectRoot, state);
      throw new Error(`Goal cannot be marked blocked until the same blocker repeats 3 times. Current count: ${count}`);
    }
    loop.status = 'blocked';
  } else {
    loop.status = 'cancelled';
  }
  loop.usage.updatedAt = now();
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return { success: true, status: loop.status, loop };
}

export function createOrUpdateArtifact(
  projectRoot: string,
  options: { artifactId: ArtifactId; content: string; changeId?: string },
): { success: boolean; artifactPath: string; state: ChangeState } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  const artifactId = options.artifactId;
  if (!ARTIFACTS[artifactId]) throw new Error(`Unknown artifact: ${artifactId}`);
  const artifactPath = change.artifacts[artifactId]?.path || artifactRelativePath(change.paths.changeDir, artifactId);
  writeFileSafe(safeJoin(projectRoot, artifactPath), options.content);
  change.artifacts[artifactId] = {
    id: artifactId,
    path: artifactPath,
    status: 'done',
    requires: ARTIFACTS[artifactId].requires,
    updatedAt: now(),
  };
  if (artifactId === 'implementation_notes') change.paths.implementationNotes = artifactPath;
  if (artifactId === 'verification') change.paths.verification = artifactPath;
  if (artifactId === 'tasks') change.paths.tasks = artifactPath;
  if (artifactId === 'design') change.paths.design = artifactPath;
  if (artifactId === 'proposal') change.paths.proposal = artifactPath;
  if (artifactId === 'specs') {
    change.paths.specs = artifactPath;
    change.paths.specsDir = path.posix.dirname(artifactPath);
  }
  change.updatedAt = now();
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return { success: true, artifactPath, state: change };
}

export function updateTaskStatus(
  projectRoot: string,
  input: string | { taskId: string; done: boolean },
  legacyDone?: boolean,
): { success: boolean; tasksRemaining: number; tasksPath: string | undefined } {
  const { state, change } = requireActiveChange(projectRoot);
  const taskId = typeof input === 'string' ? input : input.taskId;
  const done = typeof input === 'string' ? Boolean(legacyDone) : input.done;
  if (!change.paths.tasks) return { success: false, tasksRemaining: -1, tasksPath: undefined };

  const tasksPath = safeJoin(projectRoot, change.paths.tasks);
  const content = readFileSafe(tasksPath);
  if (!content) return { success: false, tasksRemaining: -1, tasksPath: change.paths.tasks };

  const regex = new RegExp(`(- \\[)[ x](\\] \\*\\*)${escapeRegex(taskId)}(\\*\\*)`, 'g');
  const updated = updateProgress(content.replace(regex, `$1${done ? 'x' : ' '}$2${taskId}$3`));
  writeFileSafe(tasksPath, updated);
  const tasksRemaining = (updated.match(/- \[ \]/g) || []).length;
  if (tasksRemaining === 0) {
    updatePhase(change, 'validate', 'All tasks are complete. Run validation and record verification evidence.');
  } else {
    change.nextAction = `Task ${taskId} ${done ? 'completed' : 'reopened'}. ${tasksRemaining} task(s) remaining.`;
    change.phase = 'implement';
    change.updatedAt = now();
  }
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return { success: true, tasksRemaining, tasksPath: change.paths.tasks };
}

export function setGate(
  projectRoot: string,
  options: { gate: keyof ChangeState['gates']; confirmed: boolean; changeId?: string },
): { success: boolean; gates: ChangeState['gates']; nextAction: string } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  change.gates[options.gate] = options.confirmed;
  if (options.gate === 'scope' && options.confirmed) {
    updatePhase(change, change.preset === 'full' ? 'plan' : 'implement', change.preset === 'full' ? 'Confirm design before implementation.' : 'Scope confirmed. Continue implementation tasks.');
  } else if (options.gate === 'design' && options.confirmed) {
    updatePhase(change, 'implement', 'Design confirmed. Continue implementation tasks.');
  } else if (options.gate === 'validation' && options.confirmed) {
    updatePhase(change, 'archive', 'Validation confirmed. Ready to archive.');
  }
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  return { success: true, gates: change.gates, nextAction: change.nextAction };
}

export function getNextActions(projectRoot: string): { changeId: string; actions: NextAction[]; nextAction: string } {
  const state = readState(projectRoot);
  const change = getActiveChange(state);
  if (!change) {
    return {
      changeId: '',
      actions: [{ id: 'create_change', description: 'Create a new OpenSpec change.', phase: 'idle', mode: 'review' }],
      nextAction: 'No active change. Create a new change.',
    };
  }
  const config = readProjectConfig(projectRoot);
  const mode = config.interaction.defaultGate;
  const actions: NextAction[] = [];
  if (!change.gates.scope) {
    actions.push({ id: 'confirm_scope', description: `Confirm scope for ${change.changeId}.`, phase: 'propose', gate: 'scope', mode });
  } else if (change.preset === 'full' && !change.gates.design) {
    actions.push({ id: 'confirm_design', description: `Confirm design for ${change.changeId}.`, phase: 'plan', gate: 'design', mode });
  } else if (countRemainingTasks(projectRoot, change) > 0) {
    actions.push({ id: 'implement_next_task', description: `Implement the next incomplete task for ${change.changeId}.`, phase: 'implement', artifactId: 'tasks', mode: 'auto' });
  } else if (!change.gates.validation) {
    actions.push({ id: 'validate', description: `Validate implementation for ${change.changeId}.`, phase: 'validate', gate: 'validation', mode });
  } else if (!change.gates.archive && !change.archived) {
    actions.push({ id: 'archive', description: `Archive ${change.changeId}.`, phase: 'archive', gate: 'archive', mode });
  }
  return { changeId: change.changeId, actions, nextAction: actions[0]?.description || 'Change is complete.' };
}

export function readArtifact(
  projectRoot: string,
  options: { artifactId: ArtifactId; changeId?: string },
): { artifactId: ArtifactId; path: string; content: string } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  if (!ARTIFACTS[options.artifactId]) throw new Error(`Unknown artifact: ${options.artifactId}`);
  const artifact = change.artifacts[options.artifactId];
  if (!artifact) throw new Error(`Artifact is not part of this change: ${options.artifactId}`);
  const content = readFileSafe(safeJoin(projectRoot, artifact.path));
  if (content === null) throw new Error(`Artifact file missing: ${artifact.path}`);
  return { artifactId: options.artifactId, path: artifact.path, content };
}

export function getPendingHooks(
  projectRoot: string,
  options: { hookPoint: string; changeId?: string },
): { hookPoint: string; blocked: boolean; hooks: Array<HookDefinition & { status: HookStatusLike; message?: string }> } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  const config = readProjectConfig(projectRoot);
  const definitions = config.hooks[options.hookPoint] || [];
  const hooks = definitions.map((definition) => {
    const recorded = [...change.hooks].reverse().find((hook) => hook.hookPoint === options.hookPoint && hook.hookName === definition.name);
    return {
      ...definition,
      status: recorded?.status || 'pending',
      message: recorded?.message,
    };
  });
  return {
    hookPoint: options.hookPoint,
    hooks,
    blocked: hooks.some((hook) => hook.required && hook.status !== 'passed' && hook.status !== 'skipped'),
  };
}

type HookStatusLike = 'pending' | 'passed' | 'failed' | 'skipped';

export function recordHookResult(
  projectRoot: string,
  options: {
    hookPoint: string;
    hookName: string;
    status: HookResult['status'];
    message?: string;
    changeId?: string;
  },
): { success: boolean; result: HookResult } {
  const state = readState(projectRoot);
  const change = options.changeId ? state.changes[options.changeId] : getActiveChange(state);
  if (!change) throw new Error('No active OpenSpec change. Create a change first.');
  const config = readProjectConfig(projectRoot);
  const def = (config.hooks[options.hookPoint] || []).find((hook) => hook.name === options.hookName);
  const result: HookResult = {
    hookPoint: options.hookPoint,
    hookName: options.hookName,
    kind: def?.kind,
    required: def?.required,
    status: options.status,
    message: options.message,
    recordedAt: now(),
  };
  change.hooks.push(result);
  change.updatedAt = now();
  state.changes[change.changeId] = change;
  writeState(projectRoot, state);
  appendEvidence(projectRoot, change, `- Hook ${options.hookPoint}/${options.hookName}: ${options.status}${options.message ? ` - ${options.message}` : ''}`);
  return { success: true, result };
}

function appendEvidence(projectRoot: string, change: ChangeState, line: string): void {
  if (!change.paths.verification) return;
  const verificationPath = safeJoin(projectRoot, change.paths.verification);
  const existing = readFileSafe(verificationPath) || `# ${change.changeId} Verification\n\n## Evidence\n`;
  writeFileSafe(verificationPath, `${existing.trimEnd()}\n${line}\n`);
}

export function validateDrift(projectRoot: string): { driftItems: DriftItem[]; summary: string; state: ChangeState | null } {
  const state = readState(projectRoot);
  const change = getActiveChange(state);
  if (!change) return { driftItems: [], summary: 'No active change to validate.', state: null };
  const driftItems: DriftItem[] = [];
  for (const artifact of Object.values(change.artifacts)) {
    if (artifact && !fs.existsSync(safeJoin(projectRoot, artifact.path))) {
      driftItems.push({
        type: 'spec_file_missing',
        description: `Artifact file missing: ${artifact.path}`,
        severity: 'high',
        location: artifact.path,
      });
    }
  }
  const remaining = countRemainingTasks(projectRoot, change);
  if (remaining > 0) {
    driftItems.push({
      type: 'task_incomplete',
      description: `${remaining} task(s) not yet completed.`,
      severity: 'medium',
      location: change.paths.tasks,
    });
  }
  if (change.loop && remaining === 0 && !allCompletedTasksHaveEvidence(projectRoot, change)) {
    driftItems.push({
      type: 'validation_evidence_missing',
      description: 'One or more completed tasks do not have passed validation evidence.',
      severity: 'medium',
      location: path.posix.join(change.paths.changeDir, 'verification.json'),
    });
  }
  const pendingPreArchive = getPendingHooks(projectRoot, { hookPoint: 'pre_archive', changeId: change.changeId });
  if (pendingPreArchive.blocked) {
    driftItems.push({
      type: 'hook_blocked',
      description: 'Required pre_archive hook is not passed.',
      severity: 'high',
    });
  }
  driftItems.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]);
  const summary = driftItems.length === 0 ? 'No drift detected. Ready for validation confirmation.' : `Found ${driftItems.length} issue(s).`;
  if (driftItems.length === 0) {
    updatePhase(change, 'validate', 'Validation passed. Confirm validation before archive.');
    state.changes[change.changeId] = change;
    writeState(projectRoot, state);
  }
  return { driftItems, summary, state: change };
}

export function archiveChange(
  projectRoot: string,
  input?: string | { message?: string; changeId?: string; force?: boolean },
): { success: boolean; archiveDir: string; state: ChangeState | null } {
  const state = readState(projectRoot);
  const change = typeof input === 'object' && input?.changeId ? state.changes[input.changeId] : getActiveChange(state);
  const message = typeof input === 'string' ? input : input?.message;
  if (!change) return { success: false, archiveDir: '', state: null };
  const pending = getPendingHooks(projectRoot, { hookPoint: 'pre_archive', changeId: change.changeId });
  if (pending.blocked && !(typeof input === 'object' && input.force)) {
    return { success: false, archiveDir: '', state: change };
  }
  const archiveDirRel = path.posix.join(ARCHIVE_DIR, change.changeId);
  const archiveDirFull = safeJoin(projectRoot, archiveDirRel);
  ensureDir(archiveDirFull);
  for (const artifact of Object.values(change.artifacts)) {
    if (!artifact) continue;
    const src = safeJoin(projectRoot, artifact.path);
    if (!fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    if (stat.isFile()) {
      fs.copyFileSync(src, path.join(archiveDirFull, path.basename(artifact.path)));
    }
  }
  const verificationJson = safeJoin(projectRoot, path.posix.join(change.paths.changeDir, 'verification.json'));
  if (fs.existsSync(verificationJson)) {
    fs.copyFileSync(verificationJson, path.join(archiveDirFull, 'verification.json'));
  }
  if (change.loop) {
    change.loop.status = 'complete';
    change.loop.usage.updatedAt = now();
  }
  const metadata = {
    changeId: change.changeId,
    archivedAt: now(),
    message: message || 'Change archived.',
    preset: change.preset,
    schema: change.schema,
    artifacts: change.artifacts,
    hooks: change.hooks,
    loop: change.loop,
  };
  writeFileSafe(path.join(archiveDirFull, 'archive-metadata.json'), JSON.stringify(metadata, null, 2));
  const kbDir = safeJoin(projectRoot, path.posix.join(ARCHIVE_DIR, '_knowledge-base'));
  ensureDir(kbDir);
  writeFileSafe(
    path.join(kbDir, `${change.changeId}.json`),
    JSON.stringify({ changeId: change.changeId, date: now().slice(0, 10), summary: message || 'Change archived.', archiveDir: archiveDirRel }, null, 2),
  );
  change.archived = true;
  change.gates.archive = true;
  updatePhase(change, 'complete', `Change "${change.changeId}" archived successfully.`);
  state.changes[change.changeId] = change;
  if (state.activeChangeId === change.changeId) state.activeChangeId = undefined;
  writeState(projectRoot, state);
  return { success: true, archiveDir: archiveDirRel, state: change };
}

export function listChanges(projectRoot: string): { activeChangeId?: string; changes: Array<{ changeId: string; phase: string; preset: Preset; archived: boolean; nextAction: string }> } {
  const state = readState(projectRoot);
  return {
    activeChangeId: state.activeChangeId,
    changes: Object.values(state.changes)
      .map((change) => ({
        changeId: change.changeId,
        phase: change.phase,
        preset: change.preset,
        archived: change.archived,
        nextAction: change.nextAction,
      }))
      .sort((a, b) => a.changeId.localeCompare(b.changeId)),
  };
}

export function listArchives(projectRoot: string): { archives: Array<{ changeId: string; date: string; summary: string }> } {
  const kbDir = safeJoin(projectRoot, path.posix.join(ARCHIVE_DIR, '_knowledge-base'));
  const archives: Array<{ changeId: string; date: string; summary: string }> = [];
  if (!fs.existsSync(kbDir)) return { archives };
  for (const file of fs.readdirSync(kbDir).filter((name) => name.endsWith('.json'))) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(kbDir, file), 'utf-8'));
      archives.push({ changeId: entry.changeId, date: entry.date, summary: entry.summary });
    } catch {
      // Ignore malformed knowledge entries.
    }
  }
  return { archives: archives.sort((a, b) => b.date.localeCompare(a.date)) };
}

export function summarizeNext(projectRoot: string): {
  phase: string;
  changeId: string;
  nextAction: string;
  confirmed: ChangeState['gates'] | Record<string, never>;
  gates: ChangeState['gates'] | Record<string, never>;
  paths: ChangeState['paths'] | Record<string, never>;
  actions: NextAction[];
} {
  const state = readState(projectRoot);
  const change = getActiveChange(state);
  const next = getNextActions(projectRoot);
  return {
    phase: change?.phase || 'idle',
    changeId: change?.changeId || '',
    nextAction: next.nextAction,
    confirmed: change?.gates || {},
    gates: change?.gates || {},
    paths: change?.paths || {},
    actions: next.actions,
  };
}

export function cancelChange(projectRoot: string): { success: boolean } {
  const state = readState(projectRoot);
  const change = getActiveChange(state);
  if (change) {
    updatePhase(change, 'idle', 'Change cancelled. Create a new change to continue.');
    state.changes[change.changeId] = change;
  }
  state.activeChangeId = undefined;
  writeState(projectRoot, state);
  return { success: true };
}

export function createProposal(
  projectRoot: string,
  description: string,
  background?: string,
  outOfScope?: string,
): { success: boolean; changeId: string; proposalPath: string; state: ChangeState } {
  const result = createChange(projectRoot, { description, background, outOfScope, preset: 'full' });
  return { success: result.success, changeId: result.changeId, proposalPath: result.state.paths.proposal || '', state: result.state };
}

export function createDesign(
  projectRoot: string,
  content?: string,
): { success: boolean; designPath: string; state: ChangeState | null } {
  const { change } = requireActiveChange(projectRoot);
  const result = createOrUpdateArtifact(projectRoot, {
    artifactId: 'design',
    content: content || createArtifactContent('design', change.changeId, change.changeId, change.preset),
  });
  return { success: true, designPath: result.artifactPath, state: result.state };
}

export function createTasks(
  projectRoot: string,
  tasks?: TaskItem[],
): { success: boolean; tasksPath: string; taskCount: number; state: ChangeState | null } {
  const { change } = requireActiveChange(projectRoot);
  const content = tasks ? tasksContent(change.changeId, tasks) : createArtifactContent('tasks', change.changeId, change.changeId, change.preset);
  const result = createOrUpdateArtifact(projectRoot, { artifactId: 'tasks', content });
  return { success: true, tasksPath: result.artifactPath, taskCount: (content.match(/- \[[ x]\]/g) || []).length, state: result.state };
}

export function formatToolResponse(data: unknown, responseFormat?: ResponseFormat): string {
  return formatResponse(data, responseFormat);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
