import assert from 'node:assert/strict';
import test from 'node:test';
import { JupyterClient } from '../src/index.js';

test('directory removal recursively deletes children before their parents', async () => {
  const deleted = [];
  const models = {
    root: { type: 'directory', content: [{ path: 'root/file', type: 'file' }, { path: 'root/sub', type: 'directory' }] },
    'root/file': { type: 'file' },
    'root/sub': { type: 'directory', content: [{ path: 'root/sub/nested', type: 'file' }] },
    'root/sub/nested': { type: 'file' },
  };
  const client = new JupyterClient({ serverUrl: 'https://example.test/user/a/', token: 'secret' });
  client.get = async (path) => models[path] ?? null;
  client.request = async (path, options) => {
    assert.equal(options.method, 'DELETE');
    deleted.push(decodeURIComponent(path.replace('api/contents/', '')));
    return new Response(null, { status: 204 });
  };
  await client.remove('root');
  assert.deepEqual(deleted, ['root/file', 'root/sub/nested', 'root/sub', 'root']);
});
