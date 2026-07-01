import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TapdStoryInput {
  url?: string;
  workspaceId?: string;
  storyId?: string;
}

interface TapdStoryIds {
  workspaceId: string;
  storyId: string;
  sourceUrl: string;
}

export async function fetchTapdStory(projectRoot: string, input: TapdStoryInput): Promise<unknown> {
  loadLocalEnv(projectRoot);

  const apiBase = process.env.TAPD_API_BASE || 'https://api.tapd.cn';
  const apiUser = process.env.TAPD_API_USER;
  const apiPassword = process.env.TAPD_API_PASSWORD;
  const ids = parseTapdStoryInput(input);

  if (!apiUser || !apiPassword) {
    throw new Error('Missing TAPD_API_USER or TAPD_API_PASSWORD. Set them in the Codex environment or .tapd.env.local.');
  }

  const url = new URL('/stories', apiBase);
  url.searchParams.set('workspace_id', ids.workspaceId);
  url.searchParams.set('id', ids.storyId);

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiUser}:${apiPassword}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });

  const bodyText = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = bodyText;
  }

  if (!response.ok) {
    throw new Error(`TAPD API request failed: HTTP ${response.status} ${response.statusText}; body=${bodyText.slice(0, 500)}`);
  }

  return normalizeStory(body, ids);
}

export function parseTapdStoryInput(input: TapdStoryInput): TapdStoryIds {
  if (input.url) {
    const match = String(input.url).match(/tapd(?:_fe)?\/(\d+)\/story\/detail\/(\d+)/);
    if (!match) {
      throw new Error(`Cannot parse TAPD story URL: ${input.url}`);
    }
    return {
      workspaceId: match[1],
      storyId: match[2],
      sourceUrl: String(input.url),
    };
  }

  if (!input.workspaceId || !input.storyId) {
    throw new Error('Provide either url or both workspaceId and storyId.');
  }

  return {
    workspaceId: String(input.workspaceId),
    storyId: String(input.storyId),
    sourceUrl: `https://www.tapd.cn/tapd_fe/${input.workspaceId}/story/detail/${input.storyId}`,
  };
}

function normalizeStory(body: unknown, ids: TapdStoryIds): unknown {
  const story = extractStory(body) as Record<string, unknown>;
  const description = readFirst(story, ['description', 'markdown_description', 'detail']);
  const descriptionText = htmlToText(description);
  return {
    source: {
      system: 'TAPD',
      workspaceId: ids.workspaceId,
      storyId: ids.storyId,
      url: ids.sourceUrl,
    },
    raw: body,
    proposalInput: {
      title: readFirst(story, ['name', 'title']),
      description,
      descriptionText,
      acceptanceCriteria: readFirst(story, ['acceptance_criteria', 'custom_acceptance_criteria', 'criteria']),
      priority: readFirst(story, ['priority', 'priority_label', 'custom_field_six']),
      status: readFirst(story, ['status', 'status_label']),
      owner: readFirst(story, ['owner', 'creator', 'developer', 'pm']),
      developer: readFirst(story, ['developer']),
      module: readFirst(story, ['module', 'category']),
      iteration: readFirst(story, ['iteration_id', 'iteration']),
    },
  };
}

function extractStory(body: unknown): unknown {
  const value = body as {
    data?: Array<{ Story?: unknown }> | { Story?: unknown };
    Story?: unknown;
  };
  if (Array.isArray(value?.data) && value.data[0]?.Story) return value.data[0].Story;
  if (!Array.isArray(value?.data) && value?.data?.Story) return value.data.Story;
  if (value?.Story) return value.Story;
  if (Array.isArray(body) && body[0]?.Story) return body[0].Story;
  return value?.data || body || {};
}

function readFirst(object: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }
  }
  return '';
}

function htmlToText(value: string): string {
  if (!value) return '';
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|ol|ul)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function loadLocalEnv(projectRoot: string): void {
  for (const envPath of localEnvCandidates(projectRoot)) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function localEnvCandidates(projectRoot: string): string[] {
  return [
    path.join(projectRoot, '.tapd.env.local'),
    path.join(process.cwd(), '.tapd.env.local'),
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.tapd.env.local'),
  ];
}
