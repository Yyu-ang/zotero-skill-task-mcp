/** HTTP transport tests exercise wire bytes, early authorization, and closure. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import vm from 'node:vm';

const { outputFiles } = await build({ entryPoints: [resolve('src/lanMcpListener.ts')], bundle: true, platform: 'node', format: 'cjs', write: false });
let listener;
let socket;
const bindings = [];
const Cc = {
  '@mozilla.org/network/server-socket;1': { createInstance: () => socket = {
    init(port, loopback) { this.port = port; bindings.push({ port, loopback }); },
    asyncListen(value) { listener = value; }, close() { this.closed = true; },
  } },
  '@mozilla.org/binaryinputstream;1': { createInstance: () => ({ setInputStream(value) { this.input = value; }, readByteArray(n) { return [...this.input.read(n)]; } }) },
  '@mozilla.org/intl/converter-output-stream;1': { createInstance: () => ({ init(value) { this.output = value; }, writeString(value) { this.output.writeBytes(Buffer.from(value, 'utf8')); }, flush() {} }) },
};
const module = { exports: {} };
vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, Cc, Ci: {}, TextDecoder, TextEncoder, Buffer, setTimeout });
const { HttpSocketListener, parseRequestHeaders, httpError, LAN_MCP_PORT, OAUTH_MCP_PORT } = module.exports;
assert.equal(LAN_MCP_PORT, 23123);
assert.equal(OAUTH_MCP_PORT, 23124);
const parsed = parseRequestHeaders('POST /skilltask/mcp HTTP/1.1\r\nHost: 192.168.1.2:23123\r\nMCP-Protocol-Version: 2025-06-18');
assert.equal(parsed.headers['mcp-protocol-version'], '2025-06-18');
for (const raw of [
  'POST /x HTTP/1.1\r\nHost: a\r\nHost: b',
  'POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\ncontent-length: 2',
  'POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked',
  'POST /x HTTP/1.1\r\nHost: a\r\n Content-Length: 2',
  'POST https://evil.example/x HTTP/1.1\r\nHost: a',
  'POST //evil.example/x HTTP/1.1\r\nHost: a',
  'POST /x HTTP/1.1\r\nX: 1',
  'POST /x HTTP/1.1\r\nHost: a\r\nX: invalid\v',
]) assert.throws(() => parseRequestHeaders(raw));

let auth = true;
let preflightGate = null;
const calls = [];
const server = new HttpSocketListener({ port: OAUTH_MCP_PORT,
  preflight: async () => {
    if (preflightGate) await preflightGate;
    return auth ? null : httpError(401, 'unauthorized');
  },
  maxBodyBytes: () => 4096,
  handle: async request => {
    calls.push(request);
    return { status: 200, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="test"' }, body: JSON.stringify({ greeting: '中文响应', input: request.body }) };
  },
});
server.start();
assert.deepEqual(bindings, [{ port: 23124, loopback: false }]);
assert.equal(server.isRunning(), true);

async function send(raw, { peer = '198.51.100.10', chunks = 4096 } = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  let at = 0;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const pieces = [];
  const input = { available() { return Math.min(chunks, bytes.length - at); }, read(n) { const chunk = bytes.subarray(at, at + n); at += chunk.length; return chunk; }, close() {} };
  const output = { write(text) { pieces.push(Buffer.from(text, 'ascii')); }, writeBytes(b) { pieces.push(b); }, flush() {}, close() { finish(); } };
  const transport = { host: peer, openInputStream() { return input; }, openOutputStream() { return output; }, close() { finish(); } };
  listener.onSocketAccepted(socket, transport);
  let timer;
  await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('socket timeout')), 1500); })]).finally(() => clearTimeout(timer));
  return Buffer.concat(pieces).toString('utf8');
}
function wire(body, headers = {}, method = 'POST') {
  const bytes = Buffer.from(body, 'utf8');
  return `${method} /skilltask/mcp HTTP/1.1\r\nHost: mcp.example:23124\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\n${Object.entries(headers).map(([k,v]) => `${k}: ${v}\r\n`).join('')}\r\n${body}`;
}
const response = await send(wire('{"message":"中文请求"}'), { chunks: 7 });
assert.match(response, /^HTTP\/1\.1 200 /);
assert.equal(calls.length, 1);
assert.equal(calls[0].body, '{"message":"中文请求"}');
assert.equal(calls[0].remoteAddress, '198.51.100.10');
const body = response.split('\r\n\r\n')[1];
assert.match(response, new RegExp('Content-Length: ' + Buffer.byteLength(body) + '\r\n'));
assert.equal(JSON.parse(body).greeting, '中文响应');
assert.match(await send(wire('x'.repeat(4097))), /^HTTP\/1\.1 413 /);
assert.match(await send('POST /skilltask/mcp HTTP/1.1\r\nHost: mcp.example\r\n\r\n'), /^HTTP\/1\.1 411 /);
assert.match(await send('POST /skilltask/mcp HTTP/1.1\r\nHost: mcp.example\r\nContent-Length: 0\r\n\r\nx'), /^HTTP\/1\.1 400 /);
assert.match(await send(wire('body', {}, 'GET')), /^HTTP\/1\.1 400 /);
const badUtf8 = Buffer.concat([Buffer.from('POST /skilltask/mcp HTTP/1.1\r\nHost: mcp.example\r\nContent-Length: 1\r\n\r\n'), Buffer.from([0xff])]);
assert.match(await send(badUtf8), /^HTTP\/1\.1 400 /);
auth = false;
assert.match(await send('POST /skilltask/mcp HTTP/1.1\r\nHost: mcp.example\r\nContent-Length: 536870912\r\n\r\n'), /^HTTP\/1\.1 401 /);
assert.equal(calls.length, 1, 'An unauthorized request never reaches the body handler');
assert.equal(await send(wire('{}'), { peer: '' }), '', 'Missing transport peer must fail closed');
const oldListener = listener;
const oldSocket = socket;
server.stop();
assert.equal(server.isRunning(), false);
assert.equal(socket.closed, true);
server.start();
let staleClosed = false;
oldListener.onSocketAccepted(oldSocket, { host: '198.51.100.10', close() { staleClosed = true; } });
assert.equal(staleClosed, true, 'Late accepts from an old socket must not inherit the new listener policy');
oldListener.onStopListening(oldSocket);
assert.equal(server.isRunning(), true, 'A late stopped-socket callback cannot stop the replacement');
auth = true;
let releasePreflight;
preflightGate = new Promise(resolve => { releasePreflight = resolve; });
const pendingRequest = send(wire('{}'));
await Promise.resolve();
server.stop();
server.start();
releasePreflight();
preflightGate = null;
await pendingRequest;
await Promise.resolve();
assert.equal(calls.length, 1, 'A request admitted before stop/restart must not enter the new generation after authorization resolves');
server.stop();
console.log('HTTP transport: framing, UTF-8, limits, early authorization and lifecycle passed.');
