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

test('wait tolerates the initial transient stopped state', async () => {
  const states = [
    { status: 'stopped' },
    { status: 'pending' },
    { status: 'running', next_url: '/user/alice/repo/' },
  ];
  const client = new Jupyter4NFDIClient({
    token: 'secret',
    fetchImpl: async () => Response.json(states.shift()),
  });
  const sandbox = client.attach({
    id: 'race',
    hub_url: 'https://hub.nfdi-jupyter.de',
    status_url: 'https://hub.nfdi-jupyter.de/status',
    delete_url: 'https://hub.nfdi-jupyter.de/delete',
    last_status: 'pending',
  });
  await sandbox.waitUntilRunning({ timeoutMs: 1000, pollMs: 1 });
  assert.equal(sandbox.session.last_status, 'running');
});

test('stop and destroy have different API semantics', async () => {
  const calls = [];
  const client = new Jupyter4NFDIClient({
    token: 'secret',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(null, { status: 204 });
    },
  });
  const sandbox = client.attach({
    id: 'abc',
    hub_url: 'https://hub.example',
    status_url: 'https://hub.example/status',
    delete_url: 'https://hub.example/delete',
  });
  await sandbox.stop();
  await sandbox.destroy();
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(JSON.parse(calls[1].options.body), { remove: true });
});
