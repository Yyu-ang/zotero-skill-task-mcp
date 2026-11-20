/** Access-scope and independent socket lifecycle tests, without Zotero internals. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import vm from 'node:vm';

const { outputFiles } = await build({ entryPoints: [resolve('src/networkAccess.ts')], bundle: true, platform: 'node', format: 'cjs', write: false });
function setup({ failOAuth = false, failRemote = false, failLocal = false } = {}) {
  const calls = [];
  const sockets = [];
  const Cc = {
    '@mozilla.org/network/server-socket;1': { createInstance: () => {
      const socket = { init(port, loopback) {
        calls.push(['bind', port, loopback]);
        if (failOAuth && port === 23124) throw new Error('OAuth port occupied');
        if (failRemote && port === 23123 && !loopback) throw new Error('Remote bind failed');
        if (failLocal && port === 23123 && loopback) throw new Error('Local port occupied');
        this.port = port; this.loopback = loopback;
      }, asyncListen(listener) { this.listener = listener; }, close() { this.closed = true; } };
      sockets.push(socket); return socket;
    } },
    '@mozilla.org/binaryinputstream;1': { createInstance: () => ({ setInputStream(value) { this.input = value; }, readByteArray(n) { return [...this.input.read(n)]; } }) },
    '@mozilla.org/intl/converter-output-stream;1': { createInstance: () => ({ init(value) { this.output = value; }, writeString(value) { this.output.writeBytes(Buffer.from(value, 'utf8')); }, flush() {} }) },
  };
  const module = { exports: {} };
  // Any attempted use of the Zotero Connector is a regression: it owns different ports.
  const Zotero = new Proxy({}, { get() { throw new Error('Connector access is forbidden'); } });
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, Cc, Ci: {}, TextEncoder, TextDecoder, setTimeout, Zotero });
  const exports = module.exports;
  const network = new exports.NetworkAccess({
    handleLan: async () => { calls.push(['base-handler']); return { status: 200, headers: {}, body: '{}' }; },
    handleOAuth: async () => { calls.push(['oauth-handler']); return { status: 200, headers: {}, body: '{}' }; },
    preflightOAuth: async () => ({ status: 401, headers: {}, body: '{}' }),
  });
  return { network, exports, calls, sockets };
}
const { exports } = setup();
test('IP classification rejects public, hostname, malformed and disguised numeric addresses', () => {
  for (const address of ['127.0.0.1', '127.20.0.1', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(exports.isLoopbackAddress(address), true, address);
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.2', '169.254.1.2', 'fc00::1', 'fd22::1', 'fe80::1%eth0', '::ffff:192.168.1.2', '::ffff:c0a8:102']) assert.equal(exports.isLanAddress(address), true, address);
  for (const address of ['', 'localhost', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.2', '100.64.1.2', '0.0.0.0', '192.168.1.999', '010.0.0.1', '0x7f000001', '2130706433', '2001:db8::1', 'ff02::1', '::', '::ffff:8.8.8.8', 'fe80:::1']) assert.equal(exports.isLanAddress(address), false, address);
});

test('base policy follows the selected scope and rejects hostile Host/Origin/route values', async () => {
  const request = { method: 'POST', path: '/skilltask/mcp', headers: { host: '192.168.1.2:23123', 'content-type': 'application/json' }, body: '{}', remoteAddress: '192.168.1.3' };
  assert.equal(await exports.lanRequestPolicy(request, true), null);
  assert.equal((await exports.lanRequestPolicy(request, false)).status, 403);
  for (const host of ['localhost:23123', '127.0.0.1:23123', '[::1]:23123']) {
    const local = { ...request, remoteAddress: '127.0.0.1', headers: { ...request.headers, host } };
    assert.equal(await exports.lanRequestPolicy(local, false), null, host);
    assert.equal(await exports.lanRequestPolicy(local, true), null, host);
  }
  for (const host of ['evil.example:23123', '192.168.1.2.evil.example:23123', '127.0.0.1:23123', '192.168.1.2:23124', '8.8.8.8:23123']) assert.equal((await exports.lanRequestPolicy({ ...request, headers: { ...request.headers, host } })).status, 403, host);
  assert.equal((await exports.lanRequestPolicy({ ...request, headers: { ...request.headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await exports.lanRequestPolicy({ ...request, remoteAddress: '198.51.100.3', headers: { ...request.headers, 'x-forwarded-for': '192.168.1.3' } })).status, 403);
  assert.equal((await exports.lanRequestPolicy({ ...request, path: '/connector/ping' })).status, 404);
  assert.equal((await exports.lanRequestPolicy({ ...request, path: '/oauth/token' })).status, 404);
  assert.equal((await exports.lanRequestPolicy({ ...request, method: 'GET' })).status, 405);
  assert.equal((await exports.lanRequestPolicy({ ...request, headers: { ...request.headers, 'content-type': 'text/plain' } })).status, 415);
});

test('four switch combinations bind the exact independent ports and loopback flags', async () => {
  for (const [allowRemote, oauthEnabled, mode] of [[false, false, 'loopback'], [false, true, 'loopback'], [true, false, 'lan'], [true, true, 'internet']]) {
    const s = setup();
    await s.network.configure({ enabled: true, allowRemote, oauthEnabled });
    const state = s.network.getState();
    assert.equal(state.mode, mode);
    assert.equal(state.localAccessible, true);
    assert.equal(state.localPort, 23123);
    assert.equal(state.lanAccessible, allowRemote);
    assert.equal(state.oauthAccessible, allowRemote && oauthEnabled);
    assert.deepEqual(s.calls, allowRemote && oauthEnabled
      ? [['bind', 23123, false], ['bind', 23124, false]]
      : [['bind', 23123, !allowRemote]]);
    await s.network.stop();
    assert.equal(s.network.getState().mode, 'stopped');
    assert.equal(s.network.getState().localAccessible, false);
    assert.equal(s.network.getState().localPort, null);
    assert.equal(s.sockets.every(socket => socket.closed), true);
  }
});

test('base socket refuses public or unknown peers regardless of forwarded headers', async () => {
  const s = setup();
  await s.network.configure({ enabled: true, allowRemote: true, oauthEnabled: false });
  for (const peer of ['203.0.113.1', '', 'evil.example']) {
    let closed = false;
    s.sockets[0].listener.onSocketAccepted(s.sockets[0], { host: peer, close() { closed = true; }, openInputStream() { throw new Error('Must reject before parsing'); } });
    assert.equal(closed, true);
  }
  await s.network.stop();
});

test('disabling remote closes both old sockets and opens only loopback', async () => {
  const s = setup();
  await s.network.configure({ enabled: true, allowRemote: true, oauthEnabled: true });
  const [baseSocket, oauthSocket] = s.sockets;
  let transportClosed = false;
  baseSocket.listener.onSocketAccepted(baseSocket, { host: '192.168.1.2', openInputStream() { return { available() { return 0; }, close() {} }; }, openOutputStream() { return { close() {} }; }, close() { transportClosed = true; } });
  await s.network.configure({ enabled: true, allowRemote: false, oauthEnabled: true });
  assert.equal(baseSocket.closed, true);
  assert.equal(oauthSocket.closed, true);
  assert.equal(transportClosed, true);
  assert.equal(s.network.getState().mode, 'loopback');
  assert.deepEqual(s.calls.at(-1), ['bind', 23123, true]);
  await s.network.stop();
});

test('an occupied OAuth port closes the LAN socket and falls back to loopback', async () => {
  const s = setup({ failOAuth: true });
  await assert.rejects(s.network.configure({ enabled: true, allowRemote: true, oauthEnabled: true }), /OAuth port occupied/);
  assert.equal(s.network.getState().mode, 'loopback');
  assert.equal(s.network.getState().lanAccessible, false);
  assert.equal(s.network.getState().oauthAccessible, false);
  assert.equal(s.sockets[0].closed, true);
  assert.deepEqual(s.calls.at(-1), ['bind', 23123, true]);
  await s.network.stop();
});

test('failed remote bind falls back to loopback without reporting an active LAN', async () => {
  const s = setup({ failRemote: true });
  await assert.rejects(s.network.configure({ enabled: true, allowRemote: true, oauthEnabled: false }), /Remote bind failed/);
  assert.equal(s.network.getState().mode, 'loopback');
  assert.equal(s.network.getState().localAccessible, true);
  assert.equal(s.network.getState().lanAccessible, false);
  await s.network.stop();
});

test('an occupied base port reports no URL and a later retry can recover', async () => {
  const s = setup({ failLocal: true });
  await assert.rejects(s.network.configure({ enabled: true, allowRemote: false, oauthEnabled: true }), /Local port occupied/);
  assert.equal(s.network.getState().mode, 'stopped');
  assert.equal(s.network.getState().localAccessible, false);
  assert.equal(s.network.getState().localPort, null);
  await s.network.configure({ enabled: true, allowRemote: true, oauthEnabled: false });
  assert.equal(s.network.getState().mode, 'lan');
  await s.network.stop();
});

test('unexpected loss of either listener closes its paired socket immediately', async () => {
  for (const failedIndex of [0, 1]) {
    const s = setup();
    await s.network.configure({ enabled: true, allowRemote: true, oauthEnabled: true });
    const failed = s.sockets[failedIndex];
    failed.listener.onStopListening(failed);
    assert.equal(s.sockets.every(socket => socket.closed), true);
    assert.equal(s.network.getState().mode, 'stopped');
    assert.match(s.network.getState().error, /unexpectedly/);
    await s.network.configure({ enabled: true, allowRemote: false, oauthEnabled: false });
    assert.equal(s.network.getState().mode, 'loopback');
    await s.network.stop();
  }
});

test('rapid switches serialize and stale socket events cannot stop the final mode', async () => {
  const s = setup();
  await Promise.all([
    s.network.configure({ enabled: true, allowRemote: true, oauthEnabled: true }),
    s.network.configure({ enabled: true, allowRemote: false, oauthEnabled: false }),
    s.network.configure({ enabled: true, allowRemote: true, oauthEnabled: false }),
  ]);
  assert.equal(s.network.getState().mode, 'lan');
  assert.equal(s.sockets.slice(0, -1).every(socket => socket.closed), true);
  for (const old of s.sockets.slice(0, -1)) old.listener.onStopListening(old);
  assert.equal(s.network.getState().mode, 'lan');
  await s.network.stop();
});
