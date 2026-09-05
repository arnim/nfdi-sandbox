// Explicit opt-in integration runner; never invoked by `npm test`.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Jupyter4NFDIClient, SessionStore, sshWebSocketUrl } from '../src/index.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const stateDir = path.resolve(process.env.NFDI_E2E_STATE_DIR ?? path.join(root, 'work/e2e'));
const store = new SessionStore(path.join(stateDir, 'sessions'));
const containerFile = path.join(stateDir, 'container.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const boundedFetch = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
const clientFor = (token) => new Jupyter4NFDIClient({ token, fetchImpl: boundedFetch });

async function command(file, args, options = {}) {
  return execute(file, args, { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options });
}

async function until(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(1000);
  }
  throw new Error(`Timed out: ${description}`);
}

async function cleanup() {
  const failures = [];
  const files = await fs.readdir(store.directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const file of files.filter((file) => file.endsWith('.json'))) {
    const id = file.slice(0, -5);
    try {
      const session = await store.load(id);
      if (!session.e2e_owned) throw new Error('Refusing to delete a session not created by this runner');
      if (session.delete_url) {
        const client = clientFor(process.env.JUPYTER4NFDI_TOKEN);
        // Retry accepted asynchronous deletions and verify the configuration is gone.
        await until(async () => {
          await client.stop(session, { remove: true });
          return (await client.getStatus(session)).status === 'destroyed';
        }, 120_000, 'remote configuration deletion');
      }
      await store.remove(id);
      console.log(`Cleaned test session ${id}`);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    const { name } = JSON.parse(await fs.readFile(containerFile, 'utf8'));
    assert.match(name, /^nfdi-e2e-[a-f0-9]{16}$/);
    const { stdout } = await command('docker', ['ps', '-aq', '--filter', `name=^/${name}$`]);
    if (stdout.trim()) await command('docker', ['rm', '-f', name]);
    await fs.unlink(containerFile);
    console.log('Removed test container');
  } catch (error) {
    if (error.code !== 'ENOENT') failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'Test resource cleanup failed');
}

async function exercise(sandbox, { ssh = false, token }) {
  await until(async () => {
    try { await sandbox.jupyter().ping(); return true; } catch { return false; }
  }, 120_000, 'authenticated Jupyter API readiness');

  const result = await sandbox.exec('printf EXEC_OK; printf ERROR_OK >&2; exit 7');
  assert.equal(result.stdout, 'EXEC_OK');
  assert.equal(result.stderr, 'ERROR_OK');
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  const timeout = await sandbox.exec('sleep 30', { timeoutMs: 1000 });
  assert.equal(timeout.timedOut, true);
  assert.notEqual(timeout.exitCode, 0);
  console.log('PASS exec: stdout, stderr, exit code, and timeout');

  const remoteDir = `nfdi-e2e-${crypto.randomBytes(8).toString('hex')}`;
  const data = crypto.randomBytes(256 * 1024);
  try {
    await sandbox.files.write(`${remoteDir}/nested/binary.dat`, data);
    assert.deepEqual(await sandbox.files.read(`${remoteDir}/nested/binary.dat`), data);
    assert.ok((await sandbox.files.list(`${remoteDir}/nested`)).some((item) => item.name === 'binary.dat'));
    if (ssh) await exerciseSsh(sandbox, token, remoteDir, data);
  } finally {
    await sandbox.files.remove(remoteDir);
  }
  assert.equal(await sandbox.jupyter().get(remoteDir), null);
  assert.deepEqual(await sandbox.files.list('_nfdi_sandbox/jobs'), []);
  console.log('PASS files: binary round trip, listing, recursive deletion, and job cleanup');
}

async function rejectUnauthenticated(serverUrl) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(sshWebSocketUrl(serverUrl), { handshakeTimeout: 10_000 });
    ws.on('error', reject);
    ws.once('open', () => {
      ws.close();
      reject(new Error('SSH WebSocket accepted a request without a Hub token'));
    });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      // A redirect to login is also an authentication rejection, not a tunnel.
      if (![302, 303, 401, 403].includes(response.statusCode)) {
        reject(new Error(`Unexpected unauthenticated response: ${response.statusCode}`));
      } else resolve();
      ws.removeAllListeners('error');
      ws.on('error', () => {});
      ws.terminate();
    });
  });
}

async function exerciseSsh(sandbox, token, remoteDir, data) {
  await rejectUnauthenticated(sandbox.serverUrl);
  const keyDir = await fs.mkdtemp(path.join(stateDir, 'ssh-'));
  const identity = path.join(keyDir, 'id_ed25519');
  await command('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identity, '-q']);
  await sandbox.authorizeSshKey(await fs.readFile(`${identity}.pub`, 'utf8'));

  const user = await sandbox.exec('id -u; id -un');
  assert.equal(user.exitCode, 0);
  const [uid, username] = user.stdout.trim().split('\n');
  assert.notEqual(uid, '0', 'The sandbox must run as an unprivileged user');
  assert.match(username, /^[a-z_][a-z0-9_-]*$/);
  // Obtain the host key through authenticated HTTPS, then enforce it in OpenSSH.
  const hostKey = await sandbox.exec('cat ~/.ssh/jupyter_sshd_hostkey.pub');
  assert.equal(hostKey.exitCode, 0);
  const knownHosts = path.join(keyDir, 'known_hosts');
  await fs.writeFile(knownHosts, `nfdi-e2e ${hostKey.stdout.trim()}\n`, { mode: 0o600 });
  const proxy = [process.execPath, path.join(root, 'src/cli.js'), '--token-env', 'NFDI_E2E_SSH_TOKEN',
    '--store-dir', store.directory, 'ssh-proxy', sandbox.id].map(shellQuote).join(' ');
  const options = ['-F', '/dev/null', '-i', identity, '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`, '-o', `ProxyCommand=${proxy}`];
  const env = { ...process.env, NFDI_E2E_SSH_TOKEN: token };
  const target = `${username}@nfdi-e2e`;
  const { stdout } = await command('ssh', [...options, target, 'printf SSH_OK'], { env });
  assert.equal(stdout, 'SSH_OK');
  const pty = await command('ssh', [...options, '-tt', target, 'test -t 0 && printf PTY_OK'], { env });
  assert.match(pty.stdout, /PTY_OK/);

  const wrongIdentity = path.join(keyDir, 'wrong_key');
  await command('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', wrongIdentity, '-q']);
  const wrongOptions = options.map((value) => value === identity ? wrongIdentity : value);
  await assert.rejects(command('ssh', [...wrongOptions, target, 'true'], { env }),
    (error) => /Permission denied/.test(error.stderr));

  const upload = path.join(keyDir, 'upload.dat');
  const download = path.join(keyDir, 'download.dat');
  await fs.writeFile(upload, data);
  // Modern scp uses SFTP. Both directions exercise the real SSH byte stream.
  await command('scp', [...options, upload, `${target}:${remoteDir}/ssh.dat`], { env });
  await command('scp', [...options, `${target}:${remoteDir}/ssh.dat`, download], { env });
  assert.deepEqual(await fs.readFile(download), data);
  assert.deepEqual(await sandbox.files.read(`${remoteDir}/ssh.dat`), data);
  console.log('PASS OpenSSH: Hub auth rejection, key auth, host verification, PTY, wrong-key rejection, SFTP');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function local() {
  const name = `nfdi-e2e-${crypto.randomBytes(8).toString('hex')}`;
  const token = crypto.randomBytes(32).toString('hex');
  // Persist before starting so the independent cleanup step can remove it.
  await fs.writeFile(containerFile, JSON.stringify({ name }), { mode: 0o600 });
  await command('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::8888',
    '-e', 'JUPYTER_TOKEN', 'nfdi-sandbox:test', 'jupyter', 'server',
    '--ip=0.0.0.0', '--port=8888', '--no-browser', '--ServerApp.base_url=/user/ci/sandbox/'],
  { env: { ...process.env, JUPYTER_TOKEN: token } });
  const { stdout } = await command('docker', ['port', name, '8888/tcp']);
  const port = stdout.trim().split(':').at(-1);
  assert.match(port, /^\d+$/);
  const session = { id: name, server_url: `http://127.0.0.1:${port}/user/ci/sandbox/`, e2e_owned: true };
  await store.save(session);
  await exercise(clientFor(token).attach(session), { ssh: true, token });
}

async function remote() {
  const token = process.env.JUPYTER4NFDI_TOKEN;
  if (!token) throw new Error('Set the JUPYTER4NFDI_TOKEN Actions secret before running live tests');
  const source = process.env.NFDI_E2E_SOURCE ?? 'image';
  assert.ok(['image', 'repo2docker'].includes(source));
  const spec = source === 'image'
    ? { image: 'quay.io/yuvipanda/pangeo-jupyter-sshd-proxy:latest' }
    : { repo: 'binder-examples/requirements', ref: 'HEAD' };
  const client = clientFor(token);
  let lastStatus;
  const sandbox = await client.create({ ...spec, name: `nfdi-e2e-${crypto.randomBytes(8).toString('hex')}`,
    launchTimeoutMs: 30 * 60_000,
    onUpdate: async (session) => {
      await store.save({ ...session, e2e_owned: true });
      if (session.last_status !== lastStatus) {
        console.log(`${source}: ${session.last_status}`);
        lastStatus = session.last_status;
      }
    },
  });
  assert.equal((await sandbox.status()).status, 'running');
  await exercise(sandbox, { ssh: source === 'image', token });
  await sandbox.stop();
  await until(async () => (await sandbox.status()).status === 'stopped', 120_000, 'server stop');
  console.log(`PASS ${source}: create, status, stop`);
  // Final cleanup issues remove:true and verifies status returns destroyed.
}

const mode = process.argv[2];
try {
  assert.ok(['local', 'remote', 'cleanup'].includes(mode), 'Usage: e2e.js local|remote|cleanup');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (mode === 'cleanup') await cleanup();
  else {
    try {
      if (mode === 'local') await local();
      else await remote();
    } finally {
      await cleanup();
    }
  }
} catch (error) {
  // Provider exceptions can contain URLs/account names and spawn logs. Do not
  // publish those in public CI logs or upload the state/key directory as artifacts.
  console.error(`FAIL ${mode}: ${error.code ?? error.name}`);
  if (error instanceof assert.AssertionError) console.error(error.message);
  if (error instanceof AggregateError) console.error('Cleanup failed; rerun the cleanup command with the same state directory.');
  process.exitCode = 1;
}
