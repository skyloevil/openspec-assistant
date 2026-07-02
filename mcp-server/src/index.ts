import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  archiveChange,
  cancelChange,
  createChange,
  createGoal,
  createDesign,
  createOrUpdateArtifact,
  createProposal,
  createTasks,
  buildDocsContext,
  checkDocsFreshness,
  continueLoop,
  detectLayout,
  formatToolResponse,
  getGoal,
  getNextActions,
  getPendingHooks,
  initProject,
  listArchives,
  listChanges,
  readArtifact,
  recordIteration,
  recordValidationEvidence,
  recordHookResult,
  requestHumanReview,
  resolveHumanReview,
  searchDocs,
  setGate,
  summarizeNext,
  syncSpecs,
  updateGoalStatus,
  updateTaskStatus,
  validateDrift,
} from './openspec.js';
import { readState, resolveProjectRoot } from './state.js';
import { fetchTapdStory } from './tapd.js';
import type { ArtifactId, GateMode, HookKind, HookStatus, HumanGate, HumanReviewRecord, Preset, ResponseFormat, ValidationEvidenceStatus, ValidationEvidenceType } from './types.js';

const server = new Server(
  {
    name: 'codex-sdd-loop',
    version: '0.3.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const responseFormatSchema = {
  type: 'string',
  enum: ['json', 'markdown'],
  description: 'Output format: json for structured data, markdown for readable summaries.',
};

const workDirSchema = {
  type: 'string',
  description: 'Project working directory. Defaults to the MCP server current working directory.',
};

const TOOL_DEFINITIONS = [
  {
    name: 'openspec_detect_layout',
    description: 'Scan the project for Codex SDD Loop dirs, changes, files, and state.',
    inputSchema: { type: 'object', properties: { workDir: workDirSchema, response_format: responseFormatSchema } },
  },
  {
    name: 'openspec_get_status',
    description: 'Get active change status, gates, paths, next action, and full v3 state summary.',
    inputSchema: { type: 'object', properties: { workDir: workDirSchema, response_format: responseFormatSchema } },
  },
  {
    name: 'openspec_list_changes',
    description: 'List all tracked OpenSpec changes, including archived changes.',
    inputSchema: { type: 'object', properties: { workDir: workDirSchema, response_format: responseFormatSchema } },
  },
  {
    name: 'openspec_get_next_actions',
    description: 'Return the next workflow actions derived from artifact state, gates, and task progress.',
    inputSchema: { type: 'object', properties: { workDir: workDirSchema, response_format: responseFormatSchema } },
  },
  {
    name: 'openspec_create_goal',
    description: 'Create or replace the goal-compatible loop state for the active OpenSpec change.',
    inputSchema: {
      type: 'object',
      properties: {
        workDir: workDirSchema,
        objective: { type: 'string' },
        successCriteria: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['auto', 'review', 'manual'] },
        tokenBudget: { type: 'number' },
        maxIterations: { type: 'number' },
        maxRuntimeMs: { type: 'number' },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_get_goal',
    description: 'Get active loop objective, status, usage, blockers, evidence, and next decision.',
    inputSchema: { type: 'object', properties: { workDir: workDirSchema, response_format: responseFormatSchema } },
  },
  {
    name: 'openspec_continue_loop',
    description: 'Advance the loop decision state until action, validation, human review, archive, complete, or blocked is required.',
    inputSchema: { type: 'object', properties: { workDir: workDirSchema, response_format: responseFormatSchema } },
  },
  {
    name: 'openspec_read_artifact',
    description: 'Read one active change artifact by artifact id.',
    inputSchema: {
      type: 'object',
      required: ['artifactId'],
      properties: {
        workDir: workDirSchema,
        artifactId: { type: 'string', enum: ['proposal', 'specs', 'design', 'tasks', 'verification', 'implementation_notes'] },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'docs_search',
    description: 'Search openspec specs and docs/generated, docs/reviewed, docs/knowledge markdown files.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        workDir: workDirSchema,
        query: { type: 'string' },
        layers: { type: 'array', items: { type: 'string', enum: ['openspec', 'generated', 'reviewed', 'knowledge'] } },
        limit: { type: 'number' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'knowledge_search',
    description: 'Search docs/knowledge markdown files for historical pitfalls, decisions, and compatibility notes.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        workDir: workDirSchema,
        query: { type: 'string' },
        limit: { type: 'number' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'docs_build_context',
    description: 'Build a bounded context pack from openspec project guidance, domain specs, generated docs, reviewed docs, and knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        workDir: workDirSchema,
        query: { type: 'string' },
        domains: { type: 'array', items: { type: 'string' } },
        modules: { type: 'array', items: { type: 'string' } },
        maxBytes: { type: 'number' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'docs_check_freshness',
    description: 'Check whether main openspec domain specs include the active change.',
    inputSchema: {
      type: 'object',
      properties: {
        workDir: workDirSchema,
        domains: { type: 'array', items: { type: 'string' } },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_sync_specs',
    description: 'Append active change delta specs into main openspec/specs/<domain>/spec.md files.',
    inputSchema: {
      type: 'object',
      properties: {
        workDir: workDirSchema,
        domains: { type: 'array', items: { type: 'string' } },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_validate',
    description: 'Validate artifact existence, task completion, and required hook completion.',
    inputSchema: { type: 'object', properties: { workDir: workDirSchema, response_format: responseFormatSchema } },
  },
  {
    name: 'openspec_init_project',
    description: 'Initialize openspec/config.yaml, default schema/templates, changes directory, and state file.',
    inputSchema: {
      type: 'object',
      properties: {
        workDir: workDirSchema,
        schema: { type: 'string', description: 'Default schema name. Defaults to spec-driven.' },
        overwrite: { type: 'boolean', description: 'Overwrite existing openspec/config.yaml if true.' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_create_change',
    description: 'Create openspec/changes/<changeId>/ artifacts and make it the active change.',
    inputSchema: {
      type: 'object',
      required: ['description'],
      properties: {
        workDir: workDirSchema,
        description: { type: 'string' },
        background: { type: 'string' },
        outOfScope: { type: 'string' },
        preset: { type: 'string', enum: ['full', 'hotfix', 'tweak'] },
        schema: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_fetch_tapd_story',
    description: 'Fetch a TAPD story requirement by TAPD story URL or by workspaceId and storyId.',
    inputSchema: {
      type: 'object',
      properties: {
        workDir: workDirSchema,
        url: {
          type: 'string',
          description: 'TAPD story detail URL, for example https://www.tapd.cn/tapd_fe/12345678/story/detail/1000000000000000001',
        },
        workspaceId: { type: 'string', description: 'TAPD workspace id. Optional when url is provided.' },
        storyId: { type: 'string', description: 'TAPD story id. Optional when url is provided.' },
        response_format: responseFormatSchema,
      },
      anyOf: [
        { required: ['url'] },
        { required: ['workspaceId', 'storyId'] },
      ],
    },
  },
  {
    name: 'openspec_create_or_update_artifact',
    description: 'Create or replace an artifact file inside the active change directory.',
    inputSchema: {
      type: 'object',
      required: ['artifactId', 'content'],
      properties: {
        workDir: workDirSchema,
        artifactId: { type: 'string', enum: ['proposal', 'specs', 'design', 'tasks', 'verification', 'implementation_notes'] },
        content: { type: 'string' },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_update_task',
    description: 'Mark a task checkbox as complete or reopened in tasks.md.',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'done'],
      properties: {
        workDir: workDirSchema,
        taskId: { type: 'string', description: 'Task id such as T1 or T2.' },
        done: { type: 'boolean' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_set_gate',
    description: 'Record human confirmation for a workflow gate such as scope, design, validation, or archive.',
    inputSchema: {
      type: 'object',
      required: ['gate', 'confirmed'],
      properties: {
        workDir: workDirSchema,
        gate: { type: 'string', enum: ['scope', 'design', 'validation', 'archive'] },
        confirmed: { type: 'boolean' },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_archive_change',
    description: 'Archive the active change and write knowledge-base metadata. Required pre_archive hooks must be passed unless force is true.',
    inputSchema: {
      type: 'object',
      properties: {
        workDir: workDirSchema,
        message: { type: 'string' },
        changeId: { type: 'string' },
        force: { type: 'boolean' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_cancel_change',
    description: 'Cancel the active change and clear activeChangeId without deleting artifacts.',
    inputSchema: { type: 'object', properties: { workDir: workDirSchema, response_format: responseFormatSchema } },
  },
  {
    name: 'openspec_get_pending_hooks',
    description: 'Return hooks configured for a hook point and whether required hooks block progress.',
    inputSchema: {
      type: 'object',
      required: ['hookPoint'],
      properties: {
        workDir: workDirSchema,
        hookPoint: { type: 'string', description: 'Hook point such as pre_proposal, post_task, or pre_archive.' },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_record_hook_result',
    description: 'Record the result of a custom MCP, command, or skill hook in state and verification evidence.',
    inputSchema: {
      type: 'object',
      required: ['hookPoint', 'hookName', 'status'],
      properties: {
        workDir: workDirSchema,
        hookPoint: { type: 'string' },
        hookName: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'passed', 'failed', 'skipped'] },
        message: { type: 'string' },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_record_iteration',
    description: 'Record one loop iteration with task, changed files, commands, tests, errors, and evidence references.',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        workDir: workDirSchema,
        taskId: { type: 'string' },
        summary: { type: 'string' },
        filesChanged: { type: 'array', items: { type: 'string' } },
        commandsRun: { type: 'array', items: { type: 'string' } },
        testResults: { type: 'array', items: { type: 'string' } },
        errors: { type: 'array', items: { type: 'string' } },
        evidenceRefs: { type: 'array', items: { type: 'string' } },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_record_validation_evidence',
    description: 'Record structured validation evidence and append it to verification artifacts.',
    inputSchema: {
      type: 'object',
      required: ['type', 'status', 'summary'],
      properties: {
        workDir: workDirSchema,
        type: { type: 'string', enum: ['test', 'lint', 'typecheck', 'manual', 'hook', 'spec_alignment', 'ci'] },
        status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
        summary: { type: 'string' },
        command: { type: 'string' },
        relatedTaskIds: { type: 'array', items: { type: 'string' } },
        relatedCriteria: { type: 'array', items: { type: 'string' } },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_request_human_review',
    description: 'Create a pending human review gate for risk, validation, archive, or business approval.',
    inputSchema: {
      type: 'object',
      required: ['gate', 'reason'],
      properties: {
        workDir: workDirSchema,
        gate: {
          type: 'string',
          enum: [
            'scope_review',
            'design_review',
            'risk_review',
            'destructive_change_review',
            'external_write_review',
            'public_api_review',
            'database_schema_review',
            'security_review',
            'validation_review',
            'archive_review',
            'blocked_review',
          ],
        },
        reason: { type: 'string' },
        riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
        options: { type: 'array', items: { type: 'string' } },
        recommendedOption: { type: 'string' },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_resolve_human_review',
    description: 'Resolve a pending human review gate.',
    inputSchema: {
      type: 'object',
      required: ['reviewId', 'status'],
      properties: {
        workDir: workDirSchema,
        reviewId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'revise', 'cancelled'] },
        resolution: { type: 'string' },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'openspec_update_goal_status',
    description: 'Mark loop goal complete, blocked, or cancelled while enforcing completion and blocker rules.',
    inputSchema: {
      type: 'object',
      required: ['status'],
      properties: {
        workDir: workDirSchema,
        status: { type: 'string', enum: ['complete', 'blocked', 'cancelled'] },
        blockerId: { type: 'string' },
        blockerDescription: { type: 'string' },
        changeId: { type: 'string' },
        response_format: responseFormatSchema,
      },
    },
  },
  {
    name: 'list_archives',
    description: 'Deprecated alias: list archived knowledge-base entries.',
    inputSchema: { type: 'object', properties: { workDir: workDirSchema, response_format: responseFormatSchema } },
  },
  ...deprecatedAliases(),
];

function deprecatedAliases() {
  return [
    ['detect_spec_layout', 'Deprecated alias for openspec_detect_layout.'],
    ['create_proposal', 'Deprecated alias for openspec_create_change with preset=full.'],
    ['create_design', 'Deprecated alias for openspec_create_or_update_artifact artifactId=design.'],
    ['create_tasks', 'Deprecated alias for openspec_create_or_update_artifact artifactId=tasks.'],
    ['update_task', 'Deprecated alias for openspec_update_task.'],
    ['get_status', 'Deprecated alias for openspec_get_status.'],
    ['summarize_next', 'Deprecated alias for openspec_get_next_actions.'],
    ['validate_drift', 'Deprecated alias for openspec_validate.'],
    ['archive_change', 'Deprecated alias for openspec_archive_change.'],
    ['cancel_change', 'Deprecated alias for openspec_cancel_change.'],
  ].map(([name, description]) => ({
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
  }));
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs || {}) as Record<string, unknown>;
  const projectRoot = resolveProjectRoot((args.workDir as string | undefined) || process.cwd());
  const responseFormat = (args.response_format as ResponseFormat | undefined) || 'json';

  try {
    const data = await dispatchTool(name, args, projectRoot);
    return {
      content: [{ type: 'text', text: formatToolResponse(data, responseFormat) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function dispatchTool(name: string, args: Record<string, unknown>, projectRoot: string): Promise<unknown> {
  switch (name) {
    case 'openspec_detect_layout':
    case 'detect_spec_layout':
      return detectLayout(projectRoot);
    case 'openspec_get_status':
    case 'get_status':
      return { state: readState(projectRoot), summary: summarizeNext(projectRoot) };
    case 'openspec_list_changes':
      return listChanges(projectRoot);
    case 'openspec_get_next_actions':
    case 'summarize_next':
      return getNextActions(projectRoot);
    case 'openspec_create_goal':
      return createGoal(projectRoot, {
        objective: args.objective as string | undefined,
        successCriteria: args.successCriteria as string[] | undefined,
        mode: args.mode as GateMode | undefined,
        tokenBudget: args.tokenBudget as number | undefined,
        maxIterations: args.maxIterations as number | undefined,
        maxRuntimeMs: args.maxRuntimeMs as number | undefined,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_get_goal':
      return getGoal(projectRoot);
    case 'openspec_continue_loop':
      return continueLoop(projectRoot);
    case 'openspec_read_artifact':
      return readArtifact(projectRoot, {
        artifactId: args.artifactId as ArtifactId,
        changeId: args.changeId as string | undefined,
      });
    case 'docs_search':
      return searchDocs(projectRoot, {
        query: args.query as string,
        layers: args.layers as Array<'openspec' | 'generated' | 'reviewed' | 'knowledge'> | undefined,
        limit: args.limit as number | undefined,
      });
    case 'knowledge_search':
      return searchDocs(projectRoot, {
        query: args.query as string,
        layers: ['knowledge'],
        limit: args.limit as number | undefined,
      });
    case 'docs_build_context':
      return buildDocsContext(projectRoot, {
        query: args.query as string | undefined,
        domains: args.domains as string[] | undefined,
        modules: args.modules as string[] | undefined,
        maxBytes: args.maxBytes as number | undefined,
      });
    case 'docs_check_freshness':
      return checkDocsFreshness(projectRoot, {
        domains: args.domains as string[] | undefined,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_sync_specs':
      return syncSpecs(projectRoot, {
        domains: args.domains as string[] | undefined,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_validate':
    case 'validate_drift':
      return validateDrift(projectRoot);
    case 'openspec_init_project':
      return initProject(projectRoot, {
        schema: args.schema as string | undefined,
        overwrite: args.overwrite as boolean | undefined,
      });
    case 'openspec_create_change':
      return createChange(projectRoot, {
        description: args.description as string,
        background: args.background as string | undefined,
        outOfScope: args.outOfScope as string | undefined,
        preset: args.preset as Preset | undefined,
        schema: args.schema as string | undefined,
      });
    case 'openspec_fetch_tapd_story':
      return fetchTapdStory(projectRoot, {
        url: args.url as string | undefined,
        workspaceId: args.workspaceId as string | undefined,
        storyId: args.storyId as string | undefined,
      });
    case 'create_proposal':
      return createProposal(projectRoot, args.description as string, args.background as string | undefined, args.outOfScope as string | undefined);
    case 'openspec_create_or_update_artifact':
      return createOrUpdateArtifact(projectRoot, {
        artifactId: args.artifactId as ArtifactId,
        content: args.content as string,
        changeId: args.changeId as string | undefined,
      });
    case 'create_design':
      return createDesign(projectRoot, args.content as string | undefined);
    case 'create_tasks':
      return createTasks(projectRoot, args.taskDescriptions ? (args.taskDescriptions as string[]).map((description, index) => ({
        id: `T${index + 1}`,
        description,
        done: false,
        priority: 'medium' as const,
      })) : undefined);
    case 'openspec_update_task':
    case 'update_task':
      return updateTaskStatus(projectRoot, {
        taskId: args.taskId as string,
        done: args.done as boolean,
      });
    case 'openspec_set_gate':
      return setGate(projectRoot, {
        gate: args.gate as 'scope' | 'design' | 'validation' | 'archive',
        confirmed: args.confirmed as boolean,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_archive_change':
    case 'archive_change':
      return archiveChange(projectRoot, {
        message: args.message as string | undefined,
        changeId: args.changeId as string | undefined,
        force: args.force as boolean | undefined,
      });
    case 'openspec_cancel_change':
    case 'cancel_change':
      return cancelChange(projectRoot);
    case 'openspec_get_pending_hooks':
      return getPendingHooks(projectRoot, {
        hookPoint: args.hookPoint as string,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_record_hook_result':
      return recordHookResult(projectRoot, {
        hookPoint: args.hookPoint as string,
        hookName: args.hookName as string,
        status: args.status as HookStatus,
        message: args.message as string | undefined,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_record_iteration':
      return recordIteration(projectRoot, {
        taskId: args.taskId as string | undefined,
        summary: args.summary as string,
        filesChanged: args.filesChanged as string[] | undefined,
        commandsRun: args.commandsRun as string[] | undefined,
        testResults: args.testResults as string[] | undefined,
        errors: args.errors as string[] | undefined,
        evidenceRefs: args.evidenceRefs as string[] | undefined,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_record_validation_evidence':
      return recordValidationEvidence(projectRoot, {
        type: args.type as ValidationEvidenceType,
        status: args.status as ValidationEvidenceStatus,
        summary: args.summary as string,
        command: args.command as string | undefined,
        relatedTaskIds: args.relatedTaskIds as string[] | undefined,
        relatedCriteria: args.relatedCriteria as string[] | undefined,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_request_human_review':
      return requestHumanReview(projectRoot, {
        gate: args.gate as HumanGate,
        reason: args.reason as string,
        riskLevel: args.riskLevel as 'low' | 'medium' | 'high' | undefined,
        options: args.options as string[] | undefined,
        recommendedOption: args.recommendedOption as string | undefined,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_resolve_human_review':
      return resolveHumanReview(projectRoot, {
        reviewId: args.reviewId as string,
        status: args.status as HumanReviewRecord['status'],
        resolution: args.resolution as string | undefined,
        changeId: args.changeId as string | undefined,
      });
    case 'openspec_update_goal_status':
      return updateGoalStatus(projectRoot, {
        status: args.status as 'complete' | 'blocked' | 'cancelled',
        blockerId: args.blockerId as string | undefined,
        blockerDescription: args.blockerDescription as string | undefined,
        changeId: args.changeId as string | undefined,
      });
    case 'list_archives':
      return listArchives(projectRoot);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Codex SDD Loop MCP server started on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
