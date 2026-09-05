import WebSocket from 'ws';
import { SandboxError } from './errors.js';

export class JupyterClient {
  constructor({ serverUrl, token, fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket }) {
    if (!serverUrl) throw new SandboxError('NOT_RUNNING', 'sandbox has no running server URL');
    this.serverUrl = serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
  }

  apiUrl(path) {
    return new URL(path.replace(/^\//, ''), this.serverUrl).toString();
  }

  async request(path, options = {}) {
    const url = this.apiUrl(path);
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...options,
        headers: { Authorization: `token ${this.token}`, ...(options.headers ?? {}) },
      });
    } catch (error) {
      throw new SandboxError('SERVER_UNREACHABLE', `${url}: ${error.message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SandboxError('AUTHENTICATION_FAILED', `${response.status} from ${url}`);
    }
    return response;
  }

  async ping() {
    const response = await this.request('api/');
    if (!response.ok) throw new SandboxError('SERVER_UNREACHABLE', `Jupyter API returned ${response.status}`);
    return response.json();
  }

  async get(remotePath, { content = true, format, type } = {}) {
    const query = new URLSearchParams({ content: content ? '1' : '0' });
    if (format) query.set('format', format);
    if (type) query.set('type', type);
    const response = await this.request(`api/contents/${encodeRemotePath(remotePath)}?${query}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await jupyterError(response, 'read', remotePath);
    return response.json();
  }

  async mkdir(remotePath) {
    if (!remotePath) return;
    const existing = await this.get(remotePath, { content: false });
    if (existing) {
      if (existing.type !== 'directory') throw new SandboxError('NOT_A_DIRECTORY', remotePath);
      return existing;
    }
    const parent = remotePath.split('/').slice(0, -1).join('/');
    if (parent) await this.mkdir(parent);
    const response = await this.request(`api/contents/${encodeRemotePath(remotePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'directory' }),
    });
    if (!response.ok && response.status !== 409) throw await jupyterError(response, 'create directory', remotePath);
    return response.ok ? response.json() : this.get(remotePath, { content: false });
  }

  async write(remotePath, data) {
    const parent = remotePath.split('/').slice(0, -1).join('/');
    if (parent) await this.mkdir(parent);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const response = await this.request(`api/contents/${encodeRemotePath(remotePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'file', format: 'base64', content: buffer.toString('base64') }),
    });
    if (!response.ok) throw await jupyterError(response, 'write', remotePath);
    return response.json();
  }

  async read(remotePath) {
    const model = await this.get(remotePath, { type: 'file', format: 'base64' });
    if (!model) throw new SandboxError('FILE_NOT_FOUND', remotePath);
    if (model.format === 'base64') return Buffer.from(model.content, 'base64');
    if (model.format === 'text') return Buffer.from(model.content, 'utf8');
    throw new SandboxError('INVALID_RESPONSE', `unexpected content format for ${remotePath}`);
  }

  async list(remotePath = '') {
    const model = await this.get(remotePath);
    if (!model) throw new SandboxError('FILE_NOT_FOUND', remotePath);
    if (model.type !== 'directory') throw new SandboxError('NOT_A_DIRECTORY', remotePath);
    return (model.content ?? []).map(({ name, path, type, size, last_modified }) => ({
      name, path, type, size, last_modified,
    }));
  }

  async remove(remotePath, { recursive = true } = {}) {
    if (recursive) {
      const model = await this.get(remotePath);
      if (!model) return;
      if (model.type === 'directory') {
        for (const child of model.content ?? []) {
          await this.remove(child.path, { recursive: true });
        }
      }
    }
    const response = await this.request(`api/contents/${encodeRemotePath(remotePath)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw await jupyterError(response, 'delete', remotePath);
  }

  async createTerminal() {
    const response = await this.request('api/terminals', { method: 'POST' });
    if (!response.ok) throw await jupyterError(response, 'create terminal', '');
    return (await response.json()).name;
  }

  async deleteTerminal(name) {
    await this.request(`api/terminals/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
  }

  async runTerminalCommand(name, command) {
    const url = this.apiUrl(`terminals/websocket/${encodeURIComponent(name)}`).replace(/^http/, 'ws');
    const ws = new this.WebSocketImpl(url, {
      headers: { Authorization: `token ${this.token}` },
      followRedirects: true,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SandboxError('SERVER_UNREACHABLE', 'terminal WebSocket timed out')), 30_000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (error) => { clearTimeout(timer); reject(new SandboxError('SERVER_UNREACHABLE', error.message)); });
    });
    ws.send(JSON.stringify(['stdin', `${command}\n`]));
    return ws;
  }
}

function encodeRemotePath(remotePath) {
  return remotePath.split('/').map(encodeURIComponent).join('/');
}

async function jupyterError(response, action, path) {
  const body = (await response.text().catch(() => '')).slice(0, 1000);
  return new SandboxError('JUPYTER_API_ERROR', `could not ${action}${path ? ` ${path}` : ''}: HTTP ${response.status}${body ? `: ${body}` : ''}`);
}
