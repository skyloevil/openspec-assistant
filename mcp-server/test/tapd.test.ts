import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { fetchTapdStory, parseTapdStoryInput } from '../src/tapd.js';

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sdd-loop-tapd-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n', 'utf-8');
  return dir;
}

test('parses TAPD story URL and explicit ids', () => {
  const parsed = parseTapdStoryInput({
    url: 'https://www.tapd.cn/tapd_fe/47034349/story/detail/1147034349001276098',
  });
  assert.equal(parsed.workspaceId, '47034349');
  assert.equal(parsed.storyId, '1147034349001276098');

  const explicit = parseTapdStoryInput({ workspaceId: '47034349', storyId: '1147034349001276098' });
  assert.equal(explicit.sourceUrl, 'https://www.tapd.cn/tapd_fe/47034349/story/detail/1147034349001276098');
});

test('fetches and normalizes a TAPD story using local env credentials', async () => {
  const root = tmpProject();
  fs.writeFileSync(
    path.join(root, '.tapd.env.local'),
    'TAPD_API_USER=test-user\nTAPD_API_PASSWORD=test-password\n',
    'utf-8',
  );

  const originalFetch = globalThis.fetch;
  const originalUser = process.env.TAPD_API_USER;
  const originalPassword = process.env.TAPD_API_PASSWORD;
  delete process.env.TAPD_API_USER;
  delete process.env.TAPD_API_PASSWORD;

  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), 'https://api.tapd.cn/stories?workspace_id=47034349&id=1147034349001276098');
    assert.match(String(init?.headers?.Authorization), /^Basic /);
    return new Response(JSON.stringify({
      status: 1,
      data: [{
        Story: {
          id: '1147034349001276098',
          name: '第三方登录头像坏链问题解决方案',
          description: '<p>需求背景</p><p>第三方头像链接过期后展示坏链</p>',
          custom_field_six: 'P3',
          owner: '李帅锋;',
        },
      }],
    }));
  }) as typeof fetch;

  try {
    const result = await fetchTapdStory(root, {
      url: 'https://www.tapd.cn/tapd_fe/47034349/story/detail/1147034349001276098',
    }) as {
      proposalInput: { title: string; descriptionText: string; priority: string; owner: string };
    };

    assert.equal(result.proposalInput.title, '第三方登录头像坏链问题解决方案');
    assert.equal(result.proposalInput.priority, 'P3');
    assert.equal(result.proposalInput.owner, '李帅锋;');
    assert.match(result.proposalInput.descriptionText, /第三方头像链接过期/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUser === undefined) delete process.env.TAPD_API_USER;
    else process.env.TAPD_API_USER = originalUser;
    if (originalPassword === undefined) delete process.env.TAPD_API_PASSWORD;
    else process.env.TAPD_API_PASSWORD = originalPassword;
  }
});
