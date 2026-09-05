import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { SandboxError } from './errors.js';

export class SessionStore {
  constructor(directory = defaultStoreDirectory()) {
    this.directory = directory;
  }

  pathFor(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new SandboxError('INVALID_ARGUMENT', `invalid sandbox id: ${id}`);
    return path.join(this.directory, `${id}.json`);
  }

  async save(session) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.pathFor(session.id);
    const temporary = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => {});
  }

  async load(id) {
    try {
      return JSON.parse(await fs.readFile(this.pathFor(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new SandboxError('NOT_FOUND', `unknown sandbox: ${id}`);
      throw error;
    }
  }

  async remove(id) {
    await fs.rm(this.pathFor(id), { force: true });
  }
}

function defaultStoreDirectory() {
  if (process.env.NFDI_SANDBOX_HOME) return process.env.NFDI_SANDBOX_HOME;
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'nfdi-sandbox');
}
