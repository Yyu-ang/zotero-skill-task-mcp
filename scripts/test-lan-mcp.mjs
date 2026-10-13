// Regression tests for the dedicated LAN listener (no Zotero process required).
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import vm from 'node:vm';

const { outputFiles } = await build({
  entryPoints: [resolve('src/lanMcpListener.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
});
let listener;
let port;
let loopbackOnly;
let serverClosed = false;
const socket = {
  init(p, loopback) { port = p; loopbackOnly = loopback; },
  asyncListen(l) { listener = l; },
  close() { serverClosed = true; },
};
const Cc = {
  '@mozilla.org/network/server-socket;1': {
    createInstance: () => socket,
  },
  '@mozilla.org/binaryinputstream;1': {
    createInstance: () => ({
      setInputStream(stream) { this.input = stream; },
      readByteArray(n) { return [...this.input.read(n)]; },
    }),
  },
  '@mozilla.org/intl/converter-output-stream;1': {
    createInstance: () => ({
      init(output) { this.output = output; },
      writeString(s) { this.output.writeBytes(Buffer.from(s, 'utf8')); },
      flush() {},
    }),
  },
};
const module = { exports: {} };
vm.runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, Cc, Ci: {},
  TextDecoder, TextEncoder, Buffer, setTimeout,
});
const { LanMcpListener, LAN_MCP_PORT, parseRequestHeaders } = module.exports;

const parsed = parseRequestHeaders(
  'POST /skilltask/mcp HTTP/1.1\r\nHost: 192.168.31.156\r\nMCP-Protocol-Version: 2025-06-18'
);
assert.equal(parsed.method, 'POST');
assert.equal(parsed.headers['mcp-protocol-version'], '2025-06-18');
assert.equal(parsed.path, '/skilltask/mcp');

const calls = [];
const server = new LanMcpListener(async (data, headers) => {
  calls.push({ data, headers });
  return [200, 'application/json', JSON.stringify({
    jsonrpc: '2.0', id: data.id, result: { greeting: '中文响应' },
  })];
});
server.start();
assert.equal(port, LAN_MCP_PORT);
assert.equal(port, 23121);
assert.equal(loopbackOnly, false);
assert.equal(server.isRunning(), true);

async function request(method, path, data = null) {
  const rawBody = data === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data), 'utf8');
  const raw = Buffer.concat([
    Buffer.from([
      method + ' ' + path + ' HTTP/1.1',
      'Host: 192.168.31.156:23121',
      'Content-Type: application/json',
      'Content-Length: ' + rawBody.length,
      'MCP-Protocol-Version: 2025-06-18',
      '', '',
    ].join('\r\n'), 'ascii'),
    rawBody,
  ]);
  let readAt = 0;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const pieces = [];
  const output = {
    write(text) { pieces.push(Buffer.from(text, 'ascii')); },
    writeBytes(bytes) { pieces.push(bytes); },
    flush() {},
    close() { finish(); },
  };
  const input = {
    available() { return raw.length - readAt; },
    read(n) {
      const chunk = raw.subarray(readAt, readAt + n);
      readAt += chunk.length;
      return chunk;
    },
    close() {},
  };
  listener.onSocketAccepted(socket, {
    openInputStream() { return input; },
    openOutputStream() { return output; },
    close() {},
  });
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('LAN socket timeout')), 1500))]);
  return Buffer.concat(pieces).toString('utf8');
}

const input = { jsonrpc: '2.0', id: 9, method: 'initialize', params: { message: '中文请求' } };
const response = await request('POST', '/skilltask/mcp', input);
assert.match(response, /^HTTP\/1\.1 200 OK/);
assert.match(response, /Content-Type: application\/json/);
assert.equal(calls.length, 1);
assert.equal(calls[0].data.params.message, '中文请求');
assert.equal(calls[0].headers['mcp-protocol-version'], '2025-06-18');
assert.equal(JSON.parse(response.split('\r\n\r\n')[1]).result.greeting, '中文响应');
const expectedBytes = Buffer.byteLength(response.split('\r\n\r\n')[1], 'utf8');
assert.match(response, new RegExp('Content-Length: ' + expectedBytes + '\r\n'));

assert.match(await request('GET', '/skilltask/mcp'), /^HTTP\/1\.1 405 /);
assert.match(await request('POST', '/wrong', input), /^HTTP\/1\.1 404 /);
assert.equal(calls.length, 1, 'Non-MCP routes must not reach the handler');
server.stop();
assert.equal(server.isRunning(), false);
assert.equal(serverClosed, true);
console.log('LAN MCP listener regression tests passed.');
