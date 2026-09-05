import crypto from 'node:crypto';
import { SandboxError } from './errors.js';
import { JupyterClient } from './jupyter.js';

const JOB_ROOT = '_nfdi_sandbox/jobs';

export class Sandbox {
  constructor(client, session, { onUpdate = async () => {} } = {}) {
    this.client = client;
    this.session = session;
    this.onUpdate = onUpdate;
    this.files = new SandboxFiles(this);
  }

  get id() { return this.session.id; }
  get serverUrl() { return this.session.server_url; }

  jupyter() {
    return new JupyterClient({
      serverUrl: this.session.server_url,
      token: this.client.token,
      fetchImpl: this.client.fetchImpl,
    });
  }

  async notifyUpdate() {
    await this.onUpdate?.(structuredClone(this.session));
  }

  async status() {
    const state = await this.client.getStatus(this.session);
    this.session.last_status = state.status;
    if (state.next_url) this.session.server_url = new URL(state.next_url, `${this.session.hub_url}/`).toString();
    await this.notifyUpdate();
    return {
      id: this.id,
      status: state.status,
      serverUrl: this.session.server_url,
      message: state.message ?? state.detail,
      logs: state.logs,
      raw: state,
    };
  }

  async waitUntilRunning({ timeoutMs = 30 * 60_000, pollMs = 5_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    // Jupyter4NFDI can briefly answer "stopped" on the first status poll even
    // after the start request returned "pending". Only a polled pending state
    // proves that the Hub has registered the spawn.
    let seenPending = false;
    const graceUntil = Date.now() + 30_000;
    while (Date.now() <= deadline) {
      const state = await this.status();
      if (state.status === 'running') return this;
      if (state.status === 'pending') seenPending = true;
      if (state.status === 'failed' || state.status === 'destroyed' ||
          (state.status === 'stopped' && (seenPending || Date.now() > graceUntil))) {
        const tail = Array.isArray(state.logs) ? `\n${state.logs.slice(-10).join('\n')}` : '';
        throw new SandboxError('PROVISIONING_FAILED', `server entered ${state.status}${state.message ? `: ${state.message}` : ''}${tail}`);
      }
      await sleep(pollMs);
    }
    throw new SandboxError('PROVISIONING_TIMEOUT', `server did not start within ${timeoutMs}ms`);
  }

  async stop(options = {}) {
    this.session.last_status = 'stopping';
    await this.notifyUpdate();
    await this.client.stop(this.session, { ...options, remove: false });
    this.session.last_status = 'stopped';
    await this.notifyUpdate();
  }

  async destroy(options = {}) {
    this.session.last_status = 'destroying';
    await this.notifyUpdate();
    await this.client.stop(this.session, { ...options, remove: true });
    this.session.last_status = 'destroyed';
    await this.notifyUpdate();
  }

  async exec(command, { cwd, env, timeoutMs = 10 * 60_000, keepJob = false } = {}) {
    if (!command || typeof command !== 'string') throw new SandboxError('INVALID_ARGUMENT', 'command must be a non-empty string');
    if (!this.serverUrl) await this.waitUntilRunning();
    const jupyter = this.jupyter();
    const jobDir = `${JOB_ROOT}/${crypto.randomBytes(8).toString('hex')}`;
    const request = { command, cwd: cwd ?? null, env: env ?? {}, timeout_seconds: timeoutMs / 1000 };
    await jupyter.write(`${jobDir}/request.json`, JSON.stringify(request));
    await jupyter.write(`${jobDir}/runner.py`, EXEC_RUNNER);
    const terminal = await jupyter.createTerminal();
    let ws;
    const started = Date.now();
    try {
      ws = await jupyter.runTerminalCommand(terminal, `python3 ${jobDir}/runner.py`);
      const result = await pollJson(jupyter, `${jobDir}/result.json`, Date.now() + timeoutMs + 30_000);
      return {
        command,
        stdout: Buffer.from(result.stdout_base64, 'base64').toString('utf8'),
        stderr: Buffer.from(result.stderr_base64, 'base64').toString('utf8'),
        exitCode: result.exit_code,
        timedOut: result.timed_out,
        durationMs: result.duration_ms ?? Date.now() - started,
      };
    } finally {
      try { ws?.close(); } catch {}
      await jupyter.deleteTerminal(terminal);
      if (!keepJob) await jupyter.remove(jobDir).catch(() => {});
    }
  }

  async authorizeSshKey(publicKey) {
    const key = publicKey.trim();
    if (!/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+|sk-ssh-|sk-ecdsa-)/.test(key) || key.includes('\n')) {
      throw new SandboxError('INVALID_ARGUMENT', 'expected one OpenSSH public key');
    }
    const encoded = Buffer.from(key).toString('base64');
    const code = [
      'import base64, os, pathlib',
      'd = pathlib.Path.home() / ".ssh"',
      'd.mkdir(mode=0o700, exist_ok=True)',
      'p = d / "authorized_keys"',
      `k = base64.b64decode("${encoded}").decode()`,
      'keys = p.read_text().splitlines() if p.exists() else []',
      'p.write_text("\\n".join(keys + ([] if k in keys else [k])) + "\\n")',
      'os.chmod(d, 0o700)',
      'os.chmod(p, 0o600)',
    ].join('; ');
    const result = await this.exec(`python3 -c '${code}'`, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new SandboxError('SSH_SETUP_FAILED', result.stderr || 'could not install SSH key');
  }
}

class SandboxFiles {
  constructor(sandbox) { this.sandbox = sandbox; }
  read(path) { return this.sandbox.jupyter().read(path); }
  write(path, data) { return this.sandbox.jupyter().write(path, data); }
  list(path = '') { return this.sandbox.jupyter().list(path); }
  mkdir(path) { return this.sandbox.jupyter().mkdir(path); }
  remove(path) { return this.sandbox.jupyter().remove(path); }
}

async function pollJson(jupyter, path, deadline) {
  while (Date.now() <= deadline) {
    const model = await jupyter.get(path, { type: 'file', format: 'text' });
    if (model) return JSON.parse(model.content);
    await sleep(500);
  }
  throw new SandboxError('EXECUTION_TIMEOUT', `timed out waiting for ${path}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EXEC_RUNNER = String.raw`import base64
import json
import os
import pathlib
import signal
import subprocess
import time

here = pathlib.Path(__file__).resolve().parent
request = json.loads((here / "request.json").read_text())
env = os.environ.copy()
env.update({str(k): str(v) for k, v in request.get("env", {}).items()})
started = time.monotonic()
timed_out = False
process = subprocess.Popen(
    request["command"],
    shell=True,
    executable="/bin/sh",
    cwd=request.get("cwd") or None,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
)
try:
    stdout, stderr = process.communicate(timeout=request["timeout_seconds"])
except subprocess.TimeoutExpired:
    timed_out = True
    os.killpg(process.pid, signal.SIGKILL)
    stdout, stderr = process.communicate()
result = {
    "exit_code": process.returncode,
    "timed_out": timed_out,
    "duration_ms": round((time.monotonic() - started) * 1000),
    "stdout_base64": base64.b64encode(stdout).decode(),
    "stderr_base64": base64.b64encode(stderr).decode(),
}
tmp = here / "result.json.tmp"
tmp.write_text(json.dumps(result))
os.replace(tmp, here / "result.json")
`;
