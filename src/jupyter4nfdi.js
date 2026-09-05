import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SandboxError } from './errors.js';
import { Sandbox } from './sandbox.js';

export const DEFAULT_HUB_URL = 'https://hub.nfdi-jupyter.de';

export class Jupyter4NFDIClient {
  constructor({ token, hubUrl = DEFAULT_HUB_URL, fetchImpl = globalThis.fetch } = {}) {
    if (!token) throw new SandboxError('AUTHENTICATION_FAILED', 'a Jupyter4NFDI API token is required');
    this.token = token;
    this.hubUrl = hubUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async create(options = {}) {
    const payload = createPayload(options);
    const response = await this.request(`${this.hubUrl}/hub/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (![200, 202].includes(response.status)) {
      throw await responseError(response, 'PROVISIONING_FAILED', 'start server');
    }

    const state = await response.json();
    const session = {
      id: options.id ?? crypto.randomBytes(4).toString('hex'),
      hub_url: this.hubUrl,
      created_at: new Date().toISOString(),
      source: payload.option === 'custom'
        ? { type: 'image', image: payload.custom.customimage }
        : { type: 'repo2docker', ...payload.repo2docker },
      request: payload,
      status_url: absoluteUrl(this.hubUrl, state.status_url),
      delete_url: absoluteUrl(this.hubUrl, state.delete_url),
      server_url: state.next_url ? absoluteUrl(this.hubUrl, state.next_url) : undefined,
      last_status: state.status ?? (response.status === 200 ? 'running' : 'pending'),
    };
    if (!session.status_url || !session.delete_url) {
      throw new SandboxError('INVALID_RESPONSE', 'Jupyter4NFDI start response omitted lifecycle URLs', state);
    }

    const sandbox = new Sandbox(this, session, { onUpdate: options.onUpdate });
    await sandbox.notifyUpdate();
    if (options.wait !== false && session.last_status !== 'running') {
      await sandbox.waitUntilRunning({ timeoutMs: options.launchTimeoutMs });
    }
    return sandbox;
  }

  attach(session, { onUpdate } = {}) {
    return new Sandbox(this, structuredClone(session), { onUpdate });
  }

  async getStatus(session) {
    const response = await this.request(session.status_url);
    if (response.status === 404) return { status: 'destroyed' };
    if (!response.ok) throw await responseError(response, 'STATUS_FAILED', 'get server status');
    return response.json();
  }

  async stop(session, { remove = false, timeoutMs = 120_000, pollMs = 1000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
      throw new SandboxError('INVALID_ARGUMENT', 'timeoutMs must be a positive integer and pollMs must be positive');
    }
    const { userUrl, serverName } = lifecycleTarget(session.delete_url);
    const signal = AbortSignal.timeout(timeoutMs);
    const action = remove ? 'destroy server' : 'stop server';
    try {
      const response = await this.request(session.delete_url, {
        method: 'DELETE',
        headers: remove ? { 'Content-Type': 'application/json' } : undefined,
        body: remove ? JSON.stringify({ remove: true }) : undefined,
        signal,
      });
      if (!response.ok && response.status !== 404) {
        throw await responseError(response, remove ? 'DESTROY_FAILED' : 'STOP_FAILED', action);
      }
      // Even 204/404 is checked against the authoritative model. The custom
      // start-status endpoint may keep reporting "stopped" after removal.
      // Do not repeatedly DELETE an in-flight stop: that can schedule duplicate
      // removal callbacks in the Hub. A failed operation can be retried safely
      // using the retained session record.
      while (true) {
        signal.throwIfAborted();
        const modelResponse = await this.request(userUrl, { signal });
        if (!modelResponse.ok) throw await responseError(modelResponse, 'STATUS_FAILED', 'verify server lifecycle');
        const model = await modelResponse.json();
        signal.throwIfAborted();
        if (!model?.servers || typeof model.servers !== 'object' || Array.isArray(model.servers)) {
          throw new SandboxError('INVALID_RESPONSE', 'Hub user model omitted its server configuration map');
        }
        if (!Object.hasOwn(model.servers, serverName)) return;
        const server = model.servers[serverName];
        if (!remove && server?.ready === false && server.pending === null) return;
        await sleep(pollMs, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) {
        throw new SandboxError(remove ? 'DESTROY_TIMEOUT' : 'STOP_TIMEOUT', `could not confirm ${action} within ${timeoutMs}ms; retain the session and retry`);
      }
      throw error;
    }
  }

  async request(url, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...options,
        headers: { Authorization: `token ${this.token}`, ...(options.headers ?? {}) },
      });
    } catch (error) {
      throw new SandboxError('NETWORK_ERROR', `${url}: ${error.message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SandboxError('AUTHENTICATION_FAILED', `${response.status} from ${url}`);
    }
    return response;
  }
}

export function createPayload({ image, repo, ref = 'HEAD', repoType = 'gh', name, system, flavor } = {}) {
  if (Boolean(image) === Boolean(repo)) {
    throw new SandboxError('INVALID_ARGUMENT', 'provide exactly one of image or repo');
  }
  const payload = image
    ? { option: 'custom', custom: { customimage: image } }
    : {
        option: 'repo2docker',
        repo2docker: { repotype: repoType, repourl: normalizeRepo(repo, repoType), reporef: ref },
      };
  if (name) payload.name = name;
  if (system) payload.system = system;
  if (flavor) payload.flavor = flavor;
  return payload;
}

function normalizeRepo(repo, repoType) {
  if (repoType !== 'gh') return repo;
  const match = repo.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/]+\/[^/#]+?)(?:\.git)?(?:#.*)?$/);
  if (!match) throw new SandboxError('INVALID_ARGUMENT', `not a GitHub repository: ${repo}`);
  return match[1].replace(/\.git$/, '');
}

function lifecycleTarget(deleteUrl) {
  let url;
  try { url = new URL(deleteUrl); } catch {
    throw new SandboxError('INVALID_RESPONSE', 'expected an absolute named-server lifecycle URL');
  }
  const match = url.pathname.match(/^(.*\/users\/[^/]+)\/servers\/([^/]+)\/?$/);
  if (!match) throw new SandboxError('INVALID_RESPONSE', 'expected a named-server lifecycle URL');
  url.pathname = match[1];
  url.search = '?include_stopped_servers=1';
  url.hash = '';
  return { userUrl: url.toString(), serverName: decodeURIComponent(match[2]) };
}

function absoluteUrl(base, value) {
  return value ? new URL(value, `${base}/`).toString() : undefined;
}

async function responseError(response, code, action) {
  const body = (await response.text().catch(() => '')).slice(0, 1000);
  return new SandboxError(code, `could not ${action}: HTTP ${response.status}${body ? `: ${body}` : ''}`);
}
