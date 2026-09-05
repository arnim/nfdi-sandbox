#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { Jupyter4NFDIClient, DEFAULT_HUB_URL } from './jupyter4nfdi.js';
import { SessionStore } from './store.js';
import { runOpenSsh, runStdioTunnel, sshConfig } from './ssh.js';

const program = new Command()
  .name('nfdi-sandbox')
  .description('Create and use agent sandboxes on Jupyter4NFDI')
  .version('0.1.0')
  .option('--token-env <name>', 'environment variable containing the API token', 'JUPYTER4NFDI_TOKEN')
  .option('--hub-url <url>', 'JupyterHub base URL', DEFAULT_HUB_URL)
  .option('--store-dir <path>', 'local sandbox metadata directory');

program.command('create')
  .description('create a sandbox from a custom image or repository')
  .option('--image <reference>', 'Jupyter-compatible container image')
  .option('--repo <repository>', 'GitHub OWNER/REPO or URL for Repo2Docker')
  .option('--ref <git-ref>', 'repository branch, tag, or commit', 'HEAD')
  .option('--repo-type <type>', 'Jupyter4NFDI repository type', 'gh')
  .option('--name <name>', 'Jupyter4NFDI server configuration name')
  .option('--system <system>', 'Jupyter4NFDI execution system')
  .option('--flavor <flavor>', 'Jupyter4NFDI resource flavor')
  .option('--launch-timeout <seconds>', 'maximum startup wait', parsePositiveNumber, 1800)
  .option('--no-wait', 'return while provisioning is still pending')
  .option('--ssh-key <path>', 'authorize this local OpenSSH public key after startup')
  .option('--json', 'print machine-readable output')
  .action(async (options) => {
    const client = makeClient();
    const store = makeStore();
    let lastStatus;
    const sandbox = await client.create({
      image: options.image,
      repo: options.repo,
      ref: options.ref,
      repoType: options.repoType,
      name: options.name,
      system: options.system,
      flavor: options.flavor,
      wait: options.wait,
      launchTimeoutMs: options.launchTimeout * 1000,
      onUpdate: async (session) => {
        await store.save(session);
        if (!options.json && session.last_status !== lastStatus) {
          console.error(`Jupyter4NFDI: ${session.last_status}`);
          lastStatus = session.last_status;
        }
      },
    });
    await store.save(sandbox.session);
    if (options.sshKey) {
      if (!options.wait) throw new Error('--ssh-key requires startup waiting; omit --no-wait');
      await sandbox.authorizeSshKey(await fs.readFile(expandHome(options.sshKey), 'utf8'));
      await store.save(sandbox.session);
    }
    if (options.json) return printJson(sandbox.session);
    console.log(`Created sandbox ${sandbox.id} (${sandbox.session.last_status}).`);
    if (sandbox.serverUrl) console.log(`Jupyter: ${sandbox.serverUrl}`);
    if (options.sshKey) console.log(`SSH: nfdi-sandbox ssh ${sandbox.id}`);
  });

program.command('status')
  .description('show sandbox status')
  .argument('<id>')
  .option('--json')
  .action(async (id, options) => {
    const { sandbox, store } = await loadSandbox(id);
    const state = await sandbox.status();
    await store.save(sandbox.session);
    if (options.json) return printJson(state);
    console.log(`${state.id}: ${state.status}${state.message ? ` — ${state.message}` : ''}`);
    if (state.serverUrl && state.status === 'running') console.log(`Jupyter: ${state.serverUrl}`);
  });

program.command('exec')
  .description('execute a shell command and wait for its result')
  .argument('<id>')
  .argument('<command...>')
  .option('--cwd <path>', 'remote working directory')
  .option('--timeout <seconds>', 'execution timeout', parsePositiveNumber, 600)
  .option('--json')
  .action(async (id, commandParts, options) => {
    const { sandbox, store } = await loadSandbox(id);
    const result = await sandbox.exec(commandParts.join(' '), { cwd: options.cwd, timeoutMs: options.timeout * 1000 });
    await store.save(sandbox.session);
    if (options.json) printJson(result);
    else {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.exitCode === 0 ? 0 : (result.timedOut ? 124 : result.exitCode);
  });

const files = program.command('files').description('read and write files through the Jupyter Contents API');
files.command('put')
  .argument('<id>')
  .argument('<local-path>')
  .argument('<remote-path>')
  .action(async (id, localPath, remotePath) => {
    const { sandbox } = await loadSandbox(id);
    await sandbox.files.write(remotePath, await fs.readFile(expandHome(localPath)));
    console.log(`Uploaded ${localPath} -> ${remotePath}`);
  });
files.command('get')
  .argument('<id>')
  .argument('<remote-path>')
  .argument('<local-path>')
  .action(async (id, remotePath, localPath) => {
    const { sandbox } = await loadSandbox(id);
    const target = expandHome(localPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await sandbox.files.read(remotePath));
    console.log(`Downloaded ${remotePath} -> ${localPath}`);
  });
files.command('ls')
  .argument('<id>')
  .argument('[remote-path]', '', '')
  .option('--json')
  .action(async (id, remotePath, options) => {
    const { sandbox } = await loadSandbox(id);
    const items = await sandbox.files.list(remotePath);
    if (options.json) printJson(items);
    else for (const item of items) console.log(`${item.type.padEnd(9)} ${String(item.size ?? '').padStart(10)}  ${item.path}`);
  });
files.command('rm')
  .argument('<id>')
  .argument('<remote-path>')
  .action(async (id, remotePath) => {
    const { sandbox } = await loadSandbox(id);
    await sandbox.files.remove(remotePath);
    console.log(`Removed ${remotePath}`);
  });

program.command('stop')
  .description('stop compute but retain the Jupyter4NFDI server configuration')
  .argument('<id>')
  .option('--timeout <seconds>', 'maximum wait for confirmed stop', parsePositiveNumber, 120)
  .action(async (id, options) => {
    const { sandbox, store } = await loadSandbox(id);
    await sandbox.stop({ timeoutMs: options.timeout * 1000 });
    await store.save(sandbox.session);
    console.log(`Stopped ${id}.`);
  });

program.command('destroy')
  .description('stop compute and remove the Jupyter4NFDI server configuration')
  .argument('<id>')
  .option('--timeout <seconds>', 'maximum wait for verified configuration removal', parsePositiveNumber, 120)
  .action(async (id, options) => {
    const { sandbox, store } = await loadSandbox(id);
    await sandbox.destroy({ timeoutMs: options.timeout * 1000 });
    await store.remove(id);
    console.log(`Destroyed ${id} and removed its local metadata.`);
  });

program.command('ssh-authorize')
  .description('install a local OpenSSH public key in the sandbox')
  .argument('<id>')
  .argument('[public-key]', 'public key file', '~/.ssh/id_ed25519.pub')
  .action(async (id, publicKey) => {
    const { sandbox } = await loadSandbox(id);
    await sandbox.authorizeSshKey(await fs.readFile(expandHome(publicKey), 'utf8'));
    console.log(`Authorized ${publicKey} in ${id}.`);
  });

program.command('ssh-config')
  .description('print an OpenSSH config entry')
  .argument('<id>')
  .option('--user <name>', 'remote Unix user', 'jovyan')
  .action(async (id, options) => {
    await makeStore().load(id);
    process.stdout.write(sshConfig({ id, user: options.user }));
  });

program.command('ssh-proxy', { hidden: true })
  .description('bridge stdin/stdout to the authenticated raw-socket WebSocket')
  .argument('<id>')
  .action(async (id) => {
    const session = await makeStore().load(id);
    await runStdioTunnel({ serverUrl: session.server_url, token: getToken() });
  });

program.command('ssh')
  .description('open a real OpenSSH session through JupyterHub HTTPS/WebSocket')
  .argument('<id>')
  .argument('[remote-command...]')
  .option('--user <name>', 'remote Unix user', 'jovyan')
  .option('--identity <path>', 'private key file')
  .action(async (id, remoteCommand, options) => {
    await makeStore().load(id);
    const executable = fileURLToPath(import.meta.url);
    const global = program.opts();
    const proxyArgs = ['--token-env', global.tokenEnv];
    if (global.storeDir) proxyArgs.push('--store-dir', global.storeDir);
    const code = await runOpenSsh({
      id,
      user: options.user,
      identity: options.identity,
      executable,
      proxyArgs,
      args: remoteCommand,
    });
    process.exitCode = code;
  });

program.showHelpAfterError();
program.parseAsync().catch((error) => {
  console.error(`${error.code ? `${error.code}: ` : ''}${error.message}`);
  process.exitCode = 1;
});

function getToken() {
  const envName = program.opts().tokenEnv;
  const token = process.env[envName];
  if (!token) throw new Error(`set ${envName} to a Jupyter4NFDI API token`);
  return token;
}

function makeClient() {
  return new Jupyter4NFDIClient({ token: getToken(), hubUrl: program.opts().hubUrl });
}

function makeStore() {
  return new SessionStore(program.opts().storeDir);
}

async function loadSandbox(id) {
  const store = makeStore();
  const session = await store.load(id);
  const client = new Jupyter4NFDIClient({ token: getToken(), hubUrl: session.hub_url ?? program.opts().hubUrl });
  return { sandbox: client.attach(session, { onUpdate: (state) => store.save(state) }), store };
}

function parsePositiveNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`expected a positive number, got ${value}`);
  return number;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function expandHome(value) {
  return value.startsWith('~/') ? path.join(process.env.HOME, value.slice(2)) : value;
}
