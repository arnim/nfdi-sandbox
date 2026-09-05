import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { runStdioTunnel } from '../src/index.js';

test('stdio tunnel transports an opaque TCP byte stream in both directions', async () => {
  const tcp = net.createServer((socket) => socket.pipe(socket));
  await listen(tcp);
  const tcpPort = tcp.address().port;
  const httpServer = http.createServer();
  await listen(httpServer);
  const wsPort = httpServer.address().port;
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => {
    const socket = net.connect(tcpPort, '127.0.0.1');
    ws.on('message', (data) => socket.write(data));
    socket.on('data', (data) => ws.send(data));
    socket.on('close', () => ws.close());
    ws.on('close', () => socket.destroy());
  });

  const input = new PassThrough();
  const output = new PassThrough();
  let received = Buffer.alloc(0);
  output.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
  const tunnel = runStdioTunnel({ serverUrl: `http://127.0.0.1:${wsPort}/`, token: 'test', input, output });
  input.write(Buffer.from([0, 1, 2, 255, 10, 13]));
  await waitFor(() => received.length === 6);
  assert.deepEqual(received, Buffer.from([0, 1, 2, 255, 10, 13]));
  input.end();
  await tunnel;
  wss.close();
  await close(httpServer);
  await close(tcp);
});

function listen(server) {
  return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
