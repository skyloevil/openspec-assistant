#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadLocalEnv();

const apiBase = process.env.TAPD_API_BASE || 'https://api.tapd.cn';
const apiUser = process.env.TAPD_API_USER;
const apiPassword = process.env.TAPD_API_PASSWORD;

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(line).catch((error) => {
      writeError(null, -32603, error instanceof Error ? error.message : String(error));
    });
  }
});

async function handleMessage(line) {
  const message = JSON.parse(line);
  if (!message.id) return;

  if (message.method === 'initialize') {
    writeResult(message.id, {
      protocolVersion: message.params?.protocolVersion || '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'tapd-requirement',
        version: '0.1.0',
      },
    });
    return;
  }

  if (message.method === 'tools/list') {
    writeResult(message.id, {
      tools: [
        {
          name: 'fetch_story',
          description: 'Fetch a TAPD story requirement by TAPD story URL or by workspaceId and storyId.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'TAPD story detail URL, for example https://www.tapd.cn/tapd_fe/12345678/story/detail/1000000000000000001',
              },
              workspaceId: {
                type: 'string',
                description: 'TAPD workspace id. Optional when url is provided.',
              },
              storyId: {
                type: 'string',
                description: 'TAPD story id. Optional when url is provided.',
              },
            },
            anyOf: [
              { required: ['url'] },
              { required: ['workspaceId', 'storyId'] },
            ],
          },
        },
      ],
    });
    return;
  }

  if (message.method === 'tools/call') {
    const { name, arguments: args = {} } = message.params || {};
    if (name !== 'fetch_story') {
      writeError(message.id, -32602, `Unknown tool: ${name}`);
      return;
    }
    try {
      const result = await fetchStory(args);
      writeResult(message.id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (error) {
      writeError(message.id, -32603, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  writeError(message.id, -32601, `Unsupported method: ${message.method}`);
}

async function fetchStory(args) {
  const ids = parseStoryInput(args);
  if (!apiUser || !apiPassword) {
    throw new Error('Missing TAPD_API_USER or TAPD_API_PASSWORD. Set them in the Codex environment or personal MCP config before using tapd-requirement.');
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
  let body;
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

function parseStoryInput(args) {
  if (args.url) {
    const match = String(args.url).match(/tapd(?:_fe)?\/(\d+)\/story\/detail\/(\d+)/);
    if (!match) {
      throw new Error(`Cannot parse TAPD story URL: ${args.url}`);
    }
    return {
      workspaceId: match[1],
      storyId: match[2],
      sourceUrl: String(args.url),
    };
  }

  if (!args.workspaceId || !args.storyId) {
    throw new Error('Provide either url or both workspaceId and storyId.');
  }

  return {
    workspaceId: String(args.workspaceId),
    storyId: String(args.storyId),
    sourceUrl: `https://www.tapd.cn/tapd_fe/${args.workspaceId}/story/detail/${args.storyId}`,
  };
}

function normalizeStory(body, ids) {
  const story = extractStory(body);
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

function extractStory(body) {
  if (Array.isArray(body?.data) && body.data[0]?.Story) return body.data[0].Story;
  if (body?.data?.Story) return body.data.Story;
  if (body?.Story) return body.Story;
  if (Array.isArray(body) && body[0]?.Story) return body[0].Story;
  return body?.data || body || {};
}

function readFirst(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

function htmlToText(value) {
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

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function loadLocalEnv() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), '.tapd.env.local'),
    path.join(scriptDir, '..', '.tapd.env.local'),
  ];

  for (const envPath of candidates) {
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
