import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

describe('artifact store routes', () => {
  test('derives isolated profile key from redis storage key or non-default redis port', async () => {
    const { resolveArtifactProfileKey } = await import('../dist/utils/artifact-store-paths.js');

    assert.equal(resolveArtifactProfileKey({ REDIS_STORAGE_KEY: 'opensource-6398' }), 'opensource-6398');
    assert.equal(resolveArtifactProfileKey({ REDIS_PROFILE: 'opensource', REDIS_PORT: '6398' }), 'opensource-6398');
    assert.equal(resolveArtifactProfileKey({ REDIS_PROFILE: 'opensource', REDIS_PORT: '6399' }), 'default');
  });

  test('saves thread markdown under the common artifact root and registers it in thread memory', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'agentroom-artifacts-'));
    const { artifactStoreRoutes } = await import('../dist/routes/artifact-store.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const app = Fastify();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    await app.register(artifactStoreRoutes, {
      threadStore,
      messageStore,
      artifactRoot,
      env: { REDIS_STORAGE_KEY: 'opensource-6398' },
    });

    const thread = threadStore.create('user-1', 'Research Report');
    messageStore.append({
      threadId: thread.id,
      userId: 'user-1',
      catId: null,
      content: 'Please research AgentRoom.',
      mentions: [],
      timestamp: 1710000000000,
    });
    messageStore.append({
      threadId: thread.id,
      userId: 'user-1',
      catId: 'codex',
      content: 'AgentRoom should use a shared artifact store.',
      mentions: [],
      timestamp: 1710000001000,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/artifacts/markdown`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { source: 'thread-export' },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.profileKey, 'opensource-6398');
    assert.equal(body.artifact.storageScope, 'thread');
    assert.match(body.artifact.localPath, /Research-Report\.md$/);
    assert.ok(body.artifact.localPath.startsWith(artifactRoot));

    const saved = await readFile(body.artifact.localPath, 'utf-8');
    assert.match(saved, /Please research AgentRoom/);
    assert.match(saved, /shared artifact store/);

    const memory = threadStore.getThreadMemory(thread.id);
    assert.equal(memory.recentArtifacts.length, 1);
    assert.equal(memory.recentArtifacts[0].artifactId, body.artifact.artifactId);
    assert.equal(memory.recentArtifacts[0].url, body.artifact.url);
    assert.equal(memory.recentArtifacts[0].storageScope, 'thread');

    const contentResponse = await app.inject({
      method: 'GET',
      url: body.artifact.url,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(contentResponse.statusCode, 200);
    assert.match(contentResponse.body, /AgentRoom should use a shared artifact store/);

    const downloadResponse = await app.inject({
      method: 'GET',
      url: body.artifact.downloadUrl,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(downloadResponse.statusCode, 200);
    assert.match(downloadResponse.headers['content-disposition'], /attachment/);

    const downloadByPathResponse = await app.inject({
      method: 'GET',
      url: `/api/artifact-store/threads/${thread.id}/download-path?path=${encodeURIComponent(body.artifact.localPath)}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(downloadByPathResponse.statusCode, 200);
    assert.match(downloadByPathResponse.headers['content-disposition'], /attachment/);
    assert.match(downloadByPathResponse.body, /Please research AgentRoom/);

    const escapedPathResponse = await app.inject({
      method: 'GET',
      url: `/api/artifact-store/threads/${thread.id}/download-path?path=${encodeURIComponent('../secret.md')}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(escapedPathResponse.statusCode, 403);
  });

  test('registers markdown files written directly into the shared thread reports directory', async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), 'agentroom-artifacts-direct-'));
    const env = { CAT_CAFE_ARTIFACT_ROOT: artifactRoot, REDIS_STORAGE_KEY: 'opensource-6398' };
    const { artifactStoreRoutes } = await import('../dist/routes/artifact-store.js');
    const { resolveThreadArtifactPaths } = await import('../dist/utils/artifact-store-paths.js');
    const { registerMarkdownArtifactsFromThreadDirectory } = await import(
      '../dist/utils/thread-artifact-registration.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const app = Fastify();
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    await app.register(artifactStoreRoutes, {
      threadStore,
      messageStore,
      artifactRoot,
      env,
    });

    const thread = threadStore.create('user-1', 'Direct Report');
    const paths = resolveThreadArtifactPaths(thread.id, env);
    const reportPath = join(paths.reportsDir, 'gemini-report.md');
    await mkdir(paths.reportsDir, { recursive: true });
    await writeFile(reportPath, '# Gemini report\n\nShared artifact body.\n', 'utf-8');

    const registered = await registerMarkdownArtifactsFromThreadDirectory({
      threadStore,
      threadId: thread.id,
      userId: 'user-1',
      catId: 'gemini',
      env,
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0].absolutePath, reportPath);
    const memory = threadStore.getThreadMemory(thread.id);
    assert.equal(memory.recentArtifacts.length, 1);
    assert.equal(memory.recentArtifacts[0].localPath, reportPath);
    assert.equal(memory.recentArtifacts[0].storageScope, 'thread');
    assert.match(memory.recentArtifacts[0].url, /^\/api\/artifact-store\/threads\//);

    const contentResponse = await app.inject({
      method: 'GET',
      url: memory.recentArtifacts[0].url,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(contentResponse.statusCode, 200);
    assert.match(contentResponse.body, /Shared artifact body/);
  });
});
