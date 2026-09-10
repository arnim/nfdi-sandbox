import assert from 'node:assert/strict';
import test from 'node:test';
import { Jupyter4NFDIClient, createPayload } from '../src/index.js';

test('custom image payload matches the Jupyter4NFDI API', () => {
  assert.deepEqual(createPayload({ image: 'ghcr.io/acme/sandbox:v1', name: 'agent' }), {
    option: 'custom',
    custom: { customimage: 'ghcr.io/acme/sandbox:v1' },
    name: 'agent',
  });
});

test('Repo2Docker payload normalizes GitHub URLs', () => {
  assert.deepEqual(createPayload({ repo: 'https://github.com/acme/research.git', ref: 'abc123' }), {
    option: 'repo2docker',
    repo2docker: { repotype: 'gh', repourl: 'acme/research', reporef: 'abc123' },
  });
});

test('create accepts 200 running and preserves lifecycle URLs', async () => {
  const calls = [];
  const client = new Jupyter4NFDIClient({
    token: 'secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        status: 'running',
        next_url: '/user/alice/agent/',
        status_url: '/hub/api/start/alice/agent',
        delete_url: '/hub/api/users/alice/servers/agent',
      });
    },
  });
  const sandbox = await client.create({ image: 'image:v1' });
  assert.equal(sandbox.session.last_status, 'running');
  assert.equal(sandbox.serverUrl, 'https://hub.nfdi-jupyter.de/user/alice/agent/');
  assert.equal('token' in sandbox.session, false);
  assert.equal(calls[0].options.headers.Authorization, 'token secret');
});

// ---- waitUntilRunning: Jupyter4NFDI reports "stopped" while building ------

// Repo2Docker build output as the Hub streams it: a ring buffer of ~500 lines.
const buildLogs = (step, length = 500) => Array.from({ length }, (_, k) => `#${step} build output ${step * length + k}\n`);
const stopped = (logs, exit_code = 0) => ({ status: 'stopped', exit_code, logs });
const PENDING = { status: 'pending' };
const RUNNING = { status: 'running', next_url: '/user/alice/repo/' };
// The first poll still shows the previous server of the same name.
const STALE_OK = stopped(['[I ServerApp] Shutting down'], 0);
const STALE_FAILED = stopped([...buildLogs(17), "post_api preparation failed: Error during build: Command '['docker', 'buildx', 'build']'"], -1);
const FAIL_LINE = "post_api preparation failed: Error during build: Command '['docker', 'buildx', 'build']' returned non-zero exit status 1.";

/** Sandbox attached to a fake Hub that replays `states` (the last one repeats). */
function fakeHubSandbox(states) {
  let polls = 0;
  const client = new Jupyter4NFDIClient({
    token: 'secret',
    fetchImpl: async () => Response.json(states[Math.min(polls++, states.length - 1)]),
  });
  const sandbox = client.attach({
    id: 'build',
    hub_url: 'https://hub.nfdi-jupyter.de',
    status_url: 'https://hub.nfdi-jupyter.de/status',
    delete_url: 'https://hub.nfdi-jupyter.de/delete',
    last_status: 'pending',
  });
  return { sandbox, polls: () => polls };
}

const fast = { timeoutMs: 5_000, pollMs: 1, stallMs: 500 };

test('wait treats stopped with changing build logs as building, not failed', async () => {
  // 40 polls of "stopped" while the image builds: far more than the former
  // 30 s grace period allowed (with pollMs 1 this would have been ~30k polls).
  const build = Array.from({ length: 40 }, (_, k) => stopped(buildLogs(k + 1)));
  const { sandbox, polls } = fakeHubSandbox([STALE_OK, ...build, PENDING, PENDING, RUNNING]);
  await sandbox.waitUntilRunning(fast);
  assert.equal(sandbox.session.last_status, 'running');
  assert.equal(sandbox.serverUrl, 'https://hub.nfdi-jupyter.de/user/alice/repo/');
  assert.equal(polls(), 44);
});

test('wait fails fast on the build-failure log marker', async () => {
  const { sandbox, polls } = fakeHubSandbox([STALE_OK, stopped(buildLogs(1)), stopped(buildLogs(2)), stopped([...buildLogs(17), FAIL_LINE], -1)]);
  await assert.rejects(sandbox.waitUntilRunning(fast), (error) => {
    assert.equal(error.code, 'PROVISIONING_FAILED');
    assert.match(error.message, /^image build failed/);
    assert.match(error.message, /post_api preparation failed/);
    return true;
  });
  assert.equal(polls(), 4);
});

test('wait ignores a stale failure snapshot from the previous server', async () => {
  const { sandbox } = fakeHubSandbox([STALE_FAILED, stopped(buildLogs(1)), stopped(buildLogs(2)), PENDING, RUNNING]);
  await sandbox.waitUntilRunning(fast);
  assert.equal(sandbox.session.last_status, 'running');
});

test('wait fails when stopped and the build logs stall', async () => {
  const { sandbox, polls } = fakeHubSandbox([STALE_OK, stopped(buildLogs(1)), stopped(buildLogs(2))]);
  const started = Date.now();
  await assert.rejects(sandbox.waitUntilRunning({ ...fast, stallMs: 200 }), (error) => {
    assert.equal(error.code, 'PROVISIONING_FAILED');
    assert.match(error.message, /^no build progress for \d+s/);
    assert.match(error.message, /#2 build output/);
    return true;
  });
  assert.ok(Date.now() - started >= 200, 'waited for the stall window');
  assert.ok(polls() > 5, 'kept polling while stalled');
});

test('wait treats stopped after pending as a dead spawn', async () => {
  const { sandbox, polls } = fakeHubSandbox([stopped(buildLogs(1)), PENDING, { status: 'stopped', exit_code: 1, logs: ['pod crashed'] }]);
  await assert.rejects(sandbox.waitUntilRunning(fast), (error) => {
    assert.equal(error.code, 'PROVISIONING_FAILED');
    assert.match(error.message, /^server stopped after spawn\npod crashed$/);
    return true;
  });
  assert.equal(polls(), 3);
});

test('wait treats failed and destroyed as terminal', async () => {
  for (const status of ['failed', 'destroyed']) {
    const { sandbox } = fakeHubSandbox([stopped(buildLogs(1)), { status, message: 'quota exceeded' }]);
    await assert.rejects(sandbox.waitUntilRunning(fast), (error) => {
      assert.equal(error.code, 'PROVISIONING_FAILED');
      assert.equal(error.message, `server entered ${status}: quota exceeded`);
      return true;
    });
  }
});

test('wait still honours the overall timeout during a never-ending build', async () => {
  let step = 0;
  const client = new Jupyter4NFDIClient({ token: 'secret', fetchImpl: async () => Response.json(stopped(buildLogs(++step))) });
  const sandbox = client.attach({ id: 'slow', hub_url: 'https://hub.example', status_url: 'https://hub.example/status', delete_url: 'https://hub.example/delete' });
  await assert.rejects(sandbox.waitUntilRunning({ timeoutMs: 100, pollMs: 1, stallMs: 10_000 }), (error) => {
    assert.equal(error.code, 'PROVISIONING_TIMEOUT');
    return true;
  });
});

test('stop and destroy have different API semantics', async () => {
  const calls = [];
  const client = new Jupyter4NFDIClient({
    token: 'secret',
    fetchImpl: async (url, options = {}) => {
      if (options.method !== 'DELETE') return Response.json({ servers: {} });
      calls.push({ url, options });
      return new Response(null, { status: 204 });
    },
  });
  const sandbox = client.attach({
    id: 'abc',
    hub_url: 'https://hub.example',
    status_url: 'https://hub.example/status',
    delete_url: 'https://hub.example/hub/api/users/alice/servers/agent',
  });
  await sandbox.stop();
  await sandbox.destroy();
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(JSON.parse(calls[1].options.body), { remove: true });
});
