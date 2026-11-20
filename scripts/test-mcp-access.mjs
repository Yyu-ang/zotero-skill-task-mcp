/** Test actual MCP/OAuth integration and saved settings, not only the pure engines. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto, createHash } from 'node:crypto';
import { build } from 'esbuild';
import vm from 'node:vm';

const { outputFiles } = await build({ entryPoints: ['src/mcpServer.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const prefix = 'extensions.zotero-skill-task.mcp.';
function setup(initial = {}) {
  const prefs = new Map(Object.entries(initial).map(([key, value]) => [prefix + key, value]));
  const bindings = [];
  let approved = true;
  let promptText = '';
  const writes = [];
  const Cc = { '@mozilla.org/network/server-socket;1': { createInstance: () => ({
    init(port, loopback) { this.port = port; bindings.push({ port, loopback }); },
    asyncListen(listener) { this.listener = listener; }, close() { this.closed = true; },
  }) } };
  const Zotero = {
    Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
    getMainWindow: () => ({}), debug() {}, logError() {},
  };
  Object.defineProperty(Zotero, 'Server', { get() { throw new Error('Plugin must not touch Zotero Connector'); } });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, Zotero, Cc,
    Ci: { nsIPromptService: { BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_TITLE_IS_STRING: 127, BUTTON_TITLE_CANCEL: 2, BUTTON_POS_1_DEFAULT: 16777216 } },
    Services: { prompt: { confirmEx(_window, _title, message) { promptText = message; return approved ? 0 : 1; } } },
    crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, setTimeout, clearTimeout,
    IOUtils: { write: async (path, bytes) => { writes.push({ path, bytes }); } },
  });
  const server = new module.exports.McpServer({ skillGroups: {}, tasks: {}, generator: {}, version: 'test' });
  return { server, prefs, bindings, writes, getPrompt: () => promptText, deny: () => { approved = false; } };
}

const origin = 'https://mcp.example.com';
const resource = origin + '/skilltask/mcp';
const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
function request(path, method = 'GET', body = '', extra = {}) {
  return { path, method, body, remoteAddress: '127.0.0.1', headers: {
    host: '127.0.0.1:23124', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...extra,
  } };
}
async function enable(s) {
  await s.server.setNetworkOptions({ allowRemote: true, oauthEnabled: true, oauthPublicOrigin: origin });
}
async function token(s) {
  const registration = await s.server.handleOAuthHttp(request('/oauth/register', 'POST', JSON.stringify({ client_name: 'Test client', redirect_uris: ['http://127.0.0.1:34567/callback'] })));
  assert.equal(registration.status, 201);
  const client = JSON.parse(registration.body).client_id;
  const verifier = 'v'.repeat(43);
  const authorize = new URLSearchParams({ client_id: client, redirect_uri: 'http://127.0.0.1:34567/callback', response_type: 'code', scope: 'skilltask', resource,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'test-state' });
  const consent = await s.server.handleOAuthHttp(request('/oauth/authorize?' + authorize));
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.Location).searchParams.get('code');
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: client, code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:34567/callback', resource }).toString();
  const response = await s.server.handleOAuthHttp(request('/oauth/token', 'POST', body, { 'content-type': 'application/x-www-form-urlencoded' }));
  assert.equal(response.status, 200);
  return JSON.parse(response.body).access_token;
}

test('old token preferences do not authorize remote access or create a third endpoint', async () => {
  const s = setup({ tokenEnabled: true, token: 'legacy-secret' });
  await s.server.register();
  assert.deepEqual(s.bindings, [{ port: 23123, loopback: true }]);
  assert.equal(s.server.getStatus().url, 'http://127.0.0.1:23123/skilltask/mcp');
  assert.equal(s.server.getStatus().allowRemote, false);
  assert.equal(s.server.getStatus().oauthEnabled, false);
  const response = await s.server.handleRequest({ data: initialize, headers: {} });
  assert.equal(response[0], 200, 'Local/LAN use never requires a legacy token');
  await s.server.unregister();
});

test('OAuth alone remains local and invalid public origins never open remote ports', async () => {
  const s = setup();
  await s.server.setNetworkOptions({ allowRemote: false, oauthEnabled: true, oauthPublicOrigin: '' });
  assert.equal(s.server.getStatus().mode, 'loopback');
  await assert.rejects(s.server.setNetworkOptions({ allowRemote: true, oauthEnabled: true, oauthPublicOrigin: 'http://bad.example' }), /HTTPS/);
  assert.equal(s.server.getStatus().mode, 'loopback');
  assert.equal(s.prefs.has(prefix + 'oauthPublicOrigin') && s.prefs.get(prefix + 'oauthPublicOrigin') === null, false);
  const bad = setup({ allowRemote: true, oauthEnabled: true, oauthPublicOrigin: 'broken' });
  await bad.server.register();
  assert.equal(bad.server.getStatus().mode, 'loopback');
  assert.ok(bad.server.getStatus().networkError);
  assert.equal(bad.bindings.some(binding => binding.port === 23124), false);
  await s.server.unregister(); await bad.server.unregister();
});

test('all OAuth socket sources require auth and forwarded headers cannot downgrade it', async () => {
  const s = setup(); await enable(s);
  for (const peer of ['127.0.0.1', '192.168.1.5', '198.51.100.7']) {
    const req = request('/skilltask/mcp', 'POST', initialize, { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost:23123' });
    req.remoteAddress = peer;
    const response = await s.server.handleOAuthHttp(req);
    assert.equal(response.status, 401);
    assert.match(response.headers['WWW-Authenticate'], /oauth-protected-resource\/skilltask\/mcp/);
  }
  const host = await s.server.preflightOAuth(request('/.well-known/oauth-authorization-server', 'GET', '', { host: 'evil.example' }));
  assert.equal(host.status, 400);
  const crossOrigin = await s.server.preflightOAuth(request('/oauth/authorize', 'GET', '', { origin: 'https://evil.example' }));
  assert.equal(crossOrigin.status, 403);
  await s.server.unregister();
});

test('unknown routes and oversized OAuth bodies are rejected before body allocation', async () => {
  const s = setup(); await enable(s);
  for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke']) {
    const response = await s.server.preflightOAuth(request(path, 'POST', '', { 'content-length': '536870912' }));
    assert.equal(response.status, 413, path);
  }
  assert.equal((await s.server.preflightOAuth(request('/anything', 'POST', '', { 'content-length': '536870912' }))).status, 404);
  assert.equal((await s.server.preflightOAuth(request('/skilltask/mcp', 'POST', '', { 'content-length': '536870912' }))).status, 401);
  assert.equal((await s.server.preflightOAuth(request('/oauth/register', 'GET'))).status, 405);
  await s.server.unregister();
});

test('native consent, token exchange, MCP use and revocation work through the real adapter', async () => {
  const s = setup(); await enable(s);
  const credential = await token(s);
  assert.match(s.getPrompt(), /客户端自报名称/);
  assert.match(s.getPrompt(), /回调域名：http:\/\/127\.0\.0\.1:34567/);
  assert.match(s.getPrompt(), /创建或修改技能组/);
  const req = request('/skilltask/mcp', 'POST', initialize, { authorization: 'Bearer ' + credential });
  assert.equal((await s.server.handleOAuthHttp(req)).status, 200);
  s.server.revokeOAuthAuthorizations();
  assert.equal((await s.server.handleOAuthHttp(req)).status, 401);
  await s.server.setNetworkOptions({ allowRemote: false, oauthEnabled: true, oauthPublicOrigin: origin });
  assert.equal(s.server.getStatus().mode, 'loopback');
  assert.equal((await s.server.handleOAuthHttp(req)).status, 503);
  await s.server.setEnabled(false);
  assert.equal(s.server.getStatus().mode, 'stopped');
  assert.equal(s.server.getStatus().url, null);
});

test('revocation between authorization check and dispatch cannot reach MCP', async () => {
  const s = setup(); await enable(s);
  const credential = await token(s);
  const original = s.server.preflightOAuth.bind(s.server);
  s.server.preflightOAuth = async req => {
    const response = await original(req);
    s.server.revokeOAuthAuthorizations();
    return response;
  };
  const response = await s.server.handleOAuthHttp(request('/skilltask/mcp', 'POST', initialize, { authorization: 'Bearer ' + credential }));
  assert.equal(response.status, 401);
  await s.server.unregister();
});

test('a stale panel or queued setting callback cannot reopen an unloaded plugin', async () => {
  const s = setup(); await enable(s);
  const before = s.bindings.length;
  const queued = s.server.setEnabled(true);
  const shutdown = s.server.unregister();
  await assert.rejects(queued, /已停用/);
  await shutdown;
  await assert.rejects(s.server.setEnabled(true), /已停用/);
  await assert.rejects(s.server.register(), /已停用/);
  await assert.rejects(s.server.setNetworkOptions({ allowRemote: true, oauthEnabled: true, oauthPublicOrigin: origin }), /已停用/);
  assert.equal(s.server.getStatus().mode, 'stopped');
  assert.equal(s.server.getStatus().url, null);
  assert.equal(s.bindings.length, before);
});

test('attachment revisions resolve the explicit parent library and reject unrelated attachments', async () => {
  const s = setup();
  const parent = { id: 42, libraryID: 7 };
  const attachment = { parentID: 42, libraryID: 7, isAttachment: () => true, getFilePathAsync: async () => '/library/file.txt' };
  s.server.resolveItemByKey = (_key, libraryID) => { assert.equal(libraryID, 7); return attachment; };
  assert.equal(await s.server.replaceAttachmentBytes('ATTACH01', new Uint8Array([65]), parent), true);
  assert.equal(s.writes.length, 1);
  attachment.parentID = 43;
  assert.equal(await s.server.replaceAttachmentBytes('ATTACH01', new Uint8Array([66]), parent), false);
  attachment.parentID = 42; attachment.libraryID = 8;
  assert.equal(await s.server.replaceAttachmentBytes('ATTACH01', new Uint8Array([67]), parent), false);
  assert.equal(s.writes.length, 1);
});

test('an invalid unsaved public URL cannot prevent closing remote access', async () => {
  const s = setup(); await enable(s);
  await s.server.setNetworkOptions({ allowRemote: false, oauthEnabled: true, oauthPublicOrigin: 'mistyped address' });
  assert.equal(s.server.getStatus().mode, 'loopback');
  assert.equal(s.server.getStatus().oauthAccessible, false);
  assert.equal(s.server.getStatus().oauthPublicOrigin, origin);
  await s.server.unregister();
});
