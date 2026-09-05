import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Jupyter4NFDIClient, SessionStore } from '../src/index.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const session = {
  id: 'test', hub_url: 'https://hub.example', last_status: 'running',
  status_url: 'https://hub.example/hub/api/start/alice/agent',
  delete_url: 'https://hub.example/hub/api/users/alice/servers/agent',
};
const stopped = { ready: false, pending: null };

for (const deleteStatus of [202, 204, 404]) {
  test(`destroy verifies absence even after DELETE returns ${deleteStatus}`, async () => {
    const calls = [];
    const updates = [];
    const models = [
      { servers: { agent: { ready: false, pending: 'stop' } } },
      { servers: { agent: stopped } }, // Stopped is NOT destroyed.
      { servers: { other: stopped } },
    ];
    const client = new Jupyter4NFDIClient({ token: 'secret', fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.ok(options.signal instanceof AbortSignal);
      if (options.method === 'DELETE') return new Response(null, { status: deleteStatus });
      assert.equal(url, 'https://hub.example/hub/api/users/alice?include_stopped_servers=1');
      assert.deepEqual(updates, ['destroying']);
      return Response.json(models.shift());
    } });
    const sandbox = client.attach(session, { onUpdate: (s) => updates.push(s.last_status) });
    await sandbox.destroy({ pollMs: 1, timeoutMs: 1000 });
    assert.equal(models.length, 0);
    assert.deepEqual(updates, ['destroying', 'destroyed']);
    assert.equal(calls.filter(({ options }) => options.method === 'DELETE').length, 1);
    assert.deepEqual(JSON.parse(calls[0].options.body), { remove: true });
  });
}

test('stop remains stopping until the authoritative model is no longer pending', async () => {
  const updates = [];
  const states = [{ ready: true, pending: null }, { ready: false, pending: 'stop' }, stopped];
  const client = new Jupyter4NFDIClient({ token: 'secret', fetchImpl: async (_url, options) => {
    if (options.method === 'DELETE') {
      assert.equal(options.body, undefined);
      return new Response(null, { status: 202 });
    }
    assert.deepEqual(updates, ['stopping']);
    return Response.json({ servers: { agent: states.shift() } });
  } });
  const sandbox = client.attach(session, { onUpdate: (s) => updates.push(s.last_status) });
  await sandbox.stop({ pollMs: 1, timeoutMs: 1000 });
  assert.equal(states.length, 0);
  assert.deepEqual(updates, ['stopping', 'stopped']);
});

test('destroy timeout leaves lifecycle URLs and destroying state available for retry', async () => {
  const client = new Jupyter4NFDIClient({ token: 'secret', fetchImpl: async (_url, options) =>
    options.method === 'DELETE' ? new Response(null, { status: 202 }) : Response.json({ servers: { agent: stopped } }),
  });
  const updates = [];
  const sandbox = client.attach(session, { onUpdate: (s) => updates.push(s) });
  await assert.rejects(sandbox.destroy({ pollMs: 1, timeoutMs: 20 }), { code: 'DESTROY_TIMEOUT' });
  assert.equal(sandbox.session.last_status, 'destroying');
  assert.equal(sandbox.session.delete_url, session.delete_url);
  assert.deepEqual(updates.map((s) => s.last_status), ['destroying']);
});

for (const model of [null, {}, { servers: [] }, { servers: null }]) {
  test(`malformed Hub model is not proof of removal: ${JSON.stringify(model)}`, async () => {
    const client = new Jupyter4NFDIClient({ token: 'secret', fetchImpl: async (_url, options) =>
      options.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(model),
    });
    const sandbox = client.attach(session);
    await assert.rejects(sandbox.destroy(), { code: 'INVALID_RESPONSE' });
    assert.equal(sandbox.session.last_status, 'destroying');
  });
}

test('verification authorization failures do not mark the sandbox destroyed', async () => {
  const client = new Jupyter4NFDIClient({ token: 'secret', fetchImpl: async (_url, options) =>
    new Response(null, { status: options.method === 'DELETE' ? 202 : 403 }),
  });
  const sandbox = client.attach(session);
  await assert.rejects(sandbox.destroy(), { code: 'AUTHENTICATION_FAILED' });
  assert.equal(sandbox.session.last_status, 'destroying');
});

test('verification handles encoded server names and a Hub base prefix', async () => {
  const client = new Jupyter4NFDIClient({ token: 'secret', fetchImpl: async (url, options) => {
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    assert.equal(url, 'https://hub.example/prefix/hub/api/users/alice?include_stopped_servers=1');
    return Response.json({ servers: { 'agent name': stopped } });
  } });
  // If the encoded name were not decoded, this would incorrectly return success.
  await assert.rejects(client.stop({ ...session, delete_url: 'https://hub.example/prefix/hub/api/users/alice/servers/agent%20name/' },
    { remove: true, timeoutMs: 20, pollMs: 1 }), { code: 'DESTROY_TIMEOUT' });
});

async function cliFixture(t, handleModel) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nfdi-lifecycle-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SessionStore(directory);
  let getCount = 0;
  const server = http.createServer(async (request, response) => {
    request.resume();
    try {
      assert.equal(request.headers.authorization, 'token local-test-only');
      if (request.method === 'DELETE') {
        response.writeHead(202).end();
      } else {
        assert.equal(request.url, '/hub/api/users/alice?include_stopped_servers=1');
        getCount++;
        await handleModel(response, store, getCount);
      }
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = { ...session, hub_url: base, delete_url: `${base}/hub/api/users/alice/servers/agent` };
  await store.save(saved);
  return { store, saved, getCount: () => getCount, run: (timeout = '2') => execute(process.execPath,
    [cli, '--store-dir', directory, 'destroy', session.id, '--timeout', timeout],
    { timeout: 5000, env: { ...process.env, JUPYTER4NFDI_TOKEN: 'local-test-only' } }),
  };
}

test('CLI keeps durable metadata until a GET confirms configuration removal', async (t) => {
  let retainedDuringVerification = false;
  const { store, run } = await cliFixture(t, async (response, store) => {
    const state = await store.load(session.id);
    retainedDuringVerification = state.last_status === 'destroying' && Boolean(state.delete_url);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ servers: {} }));
  });
  const { stdout } = await run();
  assert.equal(retainedDuringVerification, true);
  assert.match(stdout, /Destroyed test/);
  await assert.rejects(store.load(session.id), { code: 'NOT_FOUND' });
});

test('CLI timeout preserves the record, and retry can finish deletion', async (t) => {
  let removed = false;
  const { store, run, saved } = await cliFixture(t, async (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ servers: removed ? {} : { agent: stopped } }));
  });
  await assert.rejects(run('0.15'), (error) => {
    assert.match(error.stderr, /DESTROY_TIMEOUT/);
    assert.doesNotMatch(error.stdout, /Destroyed/);
    return true;
  });
  assert.deepEqual(await store.load(session.id), { ...saved, last_status: 'destroying' });
  removed = true;
  await run();
  await assert.rejects(store.load(session.id), { code: 'NOT_FOUND' });
});

test('a stalled verification response is aborted without deleting the session record', async (t) => {
  const { store, run, getCount } = await cliFixture(t, async () => { /* deliberately no response */ });
  await assert.rejects(run('0.15'), (error) => /DESTROY_TIMEOUT/.test(error.stderr));
  assert.equal(getCount(), 1);
  assert.equal((await store.load(session.id)).last_status, 'destroying');
});

test('verification HTTP failure leaves CLI metadata intact', async (t) => {
  const { store, run } = await cliFixture(t, async (response) => response.writeHead(503).end('try again'));
  await assert.rejects(run(), (error) => /STATUS_FAILED/.test(error.stderr));
  assert.equal((await store.load(session.id)).last_status, 'destroying');
});
