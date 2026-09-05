import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { SandboxError } from './errors.js';

export function sshWebSocketUrl(serverUrl, endpoint = 'sshd/') {
  const url = new URL(endpoint, serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function runStdioTunnel({ serverUrl, token, endpoint = 'sshd/', input = process.stdin, output = process.stdout, WebSocketImpl = WebSocket }) {
  if (!serverUrl) throw new SandboxError('NOT_RUNNING', 'sandbox has no running server URL');
  if (!token) throw new SandboxError('AUTHENTICATION_FAILED', 'a Jupyter4NFDI API token is required');
  const ws = new WebSocketImpl(sshWebSocketUrl(serverUrl, endpoint), {
    headers: { Authorization: `token ${token}` },
    followRedirects: true,
    perMessageDeflate: false,
  });
  ws.binaryType = 'nodebuffer';
  input.pause?.();

  return new Promise((resolve, reject) => {
    let opened = false;
    const onInput = (chunk) => {
      if (ws.readyState !== WebSocketImpl.OPEN) return;
      input.pause?.();
      ws.send(chunk, { binary: true }, (error) => {
        if (error) reject(new SandboxError('SSH_TUNNEL_FAILED', error.message));
        else input.resume?.();
      });
    };
    const cleanup = () => {
      input.off?.('data', onInput);
      input.pause?.();
    };
    ws.once('open', () => {
      opened = true;
      input.on('data', onInput);
      input.once?.('end', () => ws.close());
      input.resume?.();
    });
    ws.on('message', (data) => output.write(Buffer.from(data)));
    ws.once('error', (error) => {
      cleanup();
      reject(new SandboxError('SSH_TUNNEL_FAILED', error.message));
    });
    ws.once('close', (code, reason) => {
      cleanup();
      if (!opened || (code !== 1000 && code !== 1005)) {
        reject(new SandboxError('SSH_TUNNEL_FAILED', `WebSocket closed (${code})${reason?.length ? `: ${reason}` : ''}`));
      } else resolve();
    });
  });
}

export function sshConfig({ id, user = 'jovyan', executable = 'nfdi-sandbox' }) {
  return `Host nfdi-${id}\n    HostName hub.nfdi-jupyter.de\n    User ${user}\n    ProxyCommand ${executable} ssh-proxy ${id}\n    IdentitiesOnly yes\n`;
}

export async function runOpenSsh({ id, user = 'jovyan', identity, executable = 'nfdi-sandbox', proxyArgs = [], args = [] }) {
  const proxyCommand = [executable, ...proxyArgs, 'ssh-proxy', id].map(shellQuote).join(' ');
  const sshArgs = ['-o', `ProxyCommand=${proxyCommand}`, '-o', 'IdentitiesOnly=yes'];
  if (identity) sshArgs.push('-i', identity);
  sshArgs.push(`${user}@nfdi-${id}`, ...args);
  const child = spawn('ssh', sshArgs, { stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error(`ssh terminated by ${signal}`)) : resolve(code ?? 1));
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
