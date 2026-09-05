import assert from 'node:assert/strict';
import test from 'node:test';
import { sshConfig, sshWebSocketUrl } from '../src/index.js';

test('SSH endpoint keeps the full named-server base path', () => {
  assert.equal(
    sshWebSocketUrl('https://hub.example/user/alice/agent/'),
    'wss://hub.example/user/alice/agent/sshd/'
  );
});

test('SSH config uses the CLI as ProxyCommand', () => {
  const config = sshConfig({ id: 'deadbeef', user: 'jovyan' });
  assert.match(config, /Host nfdi-deadbeef/);
  assert.match(config, /ProxyCommand nfdi-sandbox ssh-proxy deadbeef/);
});
