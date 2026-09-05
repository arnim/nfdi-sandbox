import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';
import { JupyterClient } from '../src/index.js';
import { REMOVE_TREE } from '../src/remove.js';

const execute = promisify(execFile);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nfdi-remove-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  await fs.mkdir(root);
  const client = new JupyterClient({ serverUrl: 'https://example.test/user/a/', token: 'secret' });
  let terminalDeleted = false;
  // Exercise the exact inline Python task and its result protocol, with local
  // filesystem-backed Contents writes. No Jupyter or Docker installation needed.
  client.write = (name, data) => fs.writeFile(path.join(root, name), data);
  client.createTerminal = async () => '1';
  client.deleteTerminal = async () => { terminalDeleted = true; };
  client.runTerminalCommand = async (_name, command, { onMessage }) => {
    assert.ok(command.length < 1024, 'bootstrap must fit within the PTY input limit');
    const { stdout } = await execute('/bin/sh', ['-c', command], {
      cwd: dir, // Deliberately NOT the Contents root.
      env: { ...process.env, JUPYTER_SERVER_ROOT: root },
      timeout: 10_000,
    });
    // Include echoed command input, and split output across arbitrary frames.
    onMessage(Buffer.from(JSON.stringify(['stdout', command])));
    for (let i = 0; i < stdout.length; i += 7) {
      onMessage(Buffer.from(JSON.stringify(['stdout', stdout.slice(i, i + 7)])));
    }
    const ws = new EventEmitter();
    ws.close = () => {};
    return ws;
  };
  client.request = async (url, options) => {
    assert.equal(options.method, 'DELETE');
    assert.match(url, /^api\/contents\/_nfdi_delete_probe_[a-f0-9]+$/);
    await fs.rm(path.join(root, url.split('/').at(-1)), { force: true });
    return new Response(null, { status: 204 });
  };
  client.get = () => { throw new Error('Deletion must not walk Contents models'); };
  return { dir, root, client, assertClean: async () => {
    assert.equal(terminalDeleted, true);
    assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith('_nfdi_delete_probe_')));
  } };
}

const exists = (file) => fs.lstat(file).then(() => true, () => false);

test('recursive removal unlinks directory symlinks without deleting targets', async (t) => {
  const { dir, root, client, assertClean } = await fixture(t);
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'important.txt'), 'outside');
  await fs.mkdir(path.join(root, 'victim'));
  await fs.writeFile(path.join(root, 'victim/important.txt'), 'sibling');
  await fs.mkdir(path.join(root, 'repo/.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'repo/.git/config'), 'hidden');
  await fs.symlink('../victim', path.join(root, 'repo/sibling-link'));
  await fs.symlink(outside, path.join(root, 'repo/outside-link'));
  await fs.symlink('.', path.join(root, 'repo/cycle'));
  await fs.symlink('missing', path.join(root, 'repo/dangling'));
  await client.remove('repo');
  assert.equal(await exists(path.join(root, 'repo')), false);
  assert.equal(await fs.readFile(path.join(root, 'victim/important.txt'), 'utf8'), 'sibling');
  assert.equal(await fs.readFile(path.join(outside, 'important.txt'), 'utf8'), 'outside');
  await assertClean();
});

test('removing a symlink itself leaves its target unchanged', async (t) => {
  const { root, client, assertClean } = await fixture(t);
  await fs.mkdir(path.join(root, 'victim'));
  await fs.writeFile(path.join(root, 'victim/important.txt'), 'keep');
  await fs.symlink('victim', path.join(root, 'link'));
  await client.remove('link');
  assert.equal(await exists(path.join(root, 'link')), false);
  assert.equal(await fs.readFile(path.join(root, 'victim/important.txt'), 'utf8'), 'keep');
  await assertClean();
});

test('symlink ancestors are refused rather than traversed', async (t) => {
  const { root, client, assertClean } = await fixture(t);
  await fs.mkdir(path.join(root, 'victim'));
  await fs.writeFile(path.join(root, 'victim/important.txt'), 'keep');
  await fs.symlink('victim', path.join(root, 'link'));
  await assert.rejects(client.remove('link/important.txt'), { code: 'DELETE_FAILED' });
  assert.equal(await fs.readFile(path.join(root, 'victim/important.txt'), 'utf8'), 'keep');
  await assertClean();
});

test('missing paths are idempotent and unusual filenames are treated literally', async (t) => {
  const { root, client, assertClean } = await fixture(t);
  const name = 'quotes\' " $() 雪\nfile';
  await fs.writeFile(path.join(root, name), 'remove');
  await client.remove(name);
  await client.remove('missing/child');
  assert.equal(await exists(path.join(root, name)), false);
  await assertClean();
});

test('root, absolute and traversal paths fail before any remote operation', async () => {
  const client = new JupyterClient({ serverUrl: 'https://example.test/', token: 'secret',
    fetchImpl: () => { throw new Error('must not make a request'); } });
  for (const remotePath of ['', '/', '.', '..', '../victim', 'repo/../victim', '/tmp/a', 'a//b', 'a/./b', 'a/', 'a\0b']) {
    await assert.rejects(client.remove(remotePath), { code: 'INVALID_ARGUMENT' });
  }
});

test('root mismatch fails closed and cleans up the proof file', async (t) => {
  const { root, client, assertClean } = await fixture(t);
  await fs.writeFile(path.join(root, 'important.txt'), 'keep');
  client.write = (name) => fs.writeFile(path.join(root, name), 'wrong root proof');
  await assert.rejects(client.remove('important.txt'), { code: 'DELETE_FAILED' });
  assert.equal(await fs.readFile(path.join(root, 'important.txt'), 'utf8'), 'keep');
  await assertClean();
});

test('a directory replaced by a symlink between listing and open is not followed', async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'repo/child'), { recursive: true });
  await fs.mkdir(path.join(root, 'victim'));
  await fs.writeFile(path.join(root, 'victim/important.txt'), 'keep');
  await fs.writeFile(path.join(root, 'probe'), 'proof');
  const race = String.raw`
real_open = os.open
swapped = False
def swapping_open(name, flags, *, dir_fd=None):
    global swapped
    if name == "child" and not swapped:
        swapped = True
        os.rename("repo/child", "original-child")
        os.symlink("../victim", "repo/child")
    return real_open(name, flags, dir_fd=dir_fd)
os.open = swapping_open
remove_tree("repo", "probe", hashlib.sha256(b"proof").hexdigest())
`;
  await execute('python3', ['-c', REMOVE_TREE + race], {
    cwd: root, env: { ...process.env, JUPYTER_SERVER_ROOT: root }, timeout: 10_000,
  });
  assert.equal(await fs.readFile(path.join(root, 'victim/important.txt'), 'utf8'), 'keep');
  assert.equal(await exists(path.join(root, 'repo')), false);
});

test('terminal creation failure still removes the root proof file', async (t) => {
  const { root, client } = await fixture(t);
  client.createTerminal = async () => { throw new Error('terminals disabled'); };
  await assert.rejects(client.remove('anything'), /terminals disabled/);
  assert.deepEqual(await fs.readdir(root), []);
});
