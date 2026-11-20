// OAuth protocol and consent boundaries, independent of a running Zotero instance.
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['src/oauthServer.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { OAuthServer, normalizeOAuthOrigin } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'https://client.example/callback';
const PUBLIC = 'https://tasks.example';
const RESOURCE = PUBLIC + '/skilltask/mcp';
const tests = [];
function test(name, body) { tests.push({ name, body }); }
function fixture(options = {}) {
  const state = { now: Date.UTC(2026, 0, 1), origin: PUBLIC, approvals: [] };
  const server = new OAuthServer({
    getPublicOrigin: () => state.origin, now: () => state.now, crypto: webcrypto,
    requestApproval: async (details) => { state.approvals.push(details); return true; },
    ...options,
  });
  function request(method, path, body = '', headers = {}, remoteAddress = '127.0.0.1') {
    return server.handle({ method, path, body, headers, remoteAddress });
  }
  async function register(metadata = {}, remoteAddress = '127.0.0.1') {
    return request('POST', '/oauth/register', JSON.stringify({ client_name: 'Test client', redirect_uris: [REDIRECT], ...metadata }),
      { 'content-type': 'application/json' }, remoteAddress);
  }
  async function client(metadata = {}) {
    const result = await register(metadata);
    assert.equal(result.status, 201);
    return JSON.parse(result.body).client_id;
  }
  function authorize(clientId, values = {}, headers = {}) {
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE,
      response_type: 'code', code_challenge_method: 'S256', code_challenge: CHALLENGE, scope: 'skilltask', state: 'state:abc/def', ...values });
    return request('GET', '/oauth/authorize?' + query, '', headers);
  }
  function form(path, values, headers = {}) {
    return request('POST', path, new URLSearchParams(values).toString(), { 'content-type': 'application/x-www-form-urlencoded', ...headers });
  }
  async function code(clientId) {
    const result = await authorize(clientId);
    assert.equal(result.status, 302);
    const url = new URL(result.headers.Location);
    assert.equal(url.searchParams.get('iss'), PUBLIC);
    assert.equal(url.searchParams.get('state'), 'state:abc/def');
    assert.ok(url.searchParams.get('code'));
    return url.searchParams.get('code');
  }
  function exchange(clientId, code, values = {}) {
    return form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, resource: RESOURCE,
      code, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...values });
  }
  async function tokens(clientId) {
    const result = await exchange(clientId, await code(clientId));
    assert.equal(result.status, 200);
    return JSON.parse(result.body);
  }
  function refresh(clientId, token, values = {}) {
    return form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token, resource: RESOURCE, ...values });
  }
  const authorized = (token) => server.authenticate({ authorization: 'Bearer ' + token });
  return { server, state, request, register, client, authorize, form, code, exchange, tokens, refresh, authorized };
}

test('requires an explicit canonical HTTPS origin', async () => {
  assert.equal(normalizeOAuthOrigin('https://tasks.example/'), PUBLIC);
  for (const value of ['http://tasks.example', 'https://tasks.example/path', 'https://u:p@tasks.example', 'https://tasks.example/?x=1', 'https://tasks.example/#fragment']) {
    assert.equal(normalizeOAuthOrigin(value), null);
  }
  const f = fixture(); f.state.origin = 'http://tasks.example';
  assert.equal((await f.request('GET', '/.well-known/oauth-authorization-server')).status, 503);
  assert.equal(await f.authorized('anything'), false);
});

test('metadata, challenge and resource derive only from configured origin', async () => {
  const f = fixture();
  const discovery = await f.request('GET', '/.well-known/oauth-authorization-server', '', { host: 'evil.example', 'x-forwarded-host': 'evil.example' });
  const metadata = JSON.parse(discovery.body);
  assert.equal(metadata.issuer, PUBLIC);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/skilltask/mcp']) {
    assert.equal(JSON.parse((await f.request('GET', path)).body).resource, RESOURCE);
  }
  assert.match(f.server.unauthorized().headers['WWW-Authenticate'], /tasks\.example\/\.well-known\/oauth-protected-resource\/skilltask\/mcp/);
  assert.equal(await f.request('GET', '/unrelated'), null);
});

test('missing or broken secure randomness fails closed', async () => {
  for (const crypto of [{}, { subtle: webcrypto.subtle, getRandomValues() { throw new Error('no entropy'); } }]) {
    const f = fixture({ crypto });
    assert.equal((await f.register()).status, 503);
    assert.equal(await f.authorized('x'.repeat(43)), false);
  }
});

test('DCR rejects unsafe callbacks and unsupported grants/auth methods', async () => {
  const f = fixture();
  for (const redirect of ['http://client.example/cb', 'javascript:alert(1)', 'file:///tmp/x', 'https://u:p@client.example/cb', 'https://client.example/cb#frag']) {
    assert.equal((await f.register({ redirect_uris: [redirect] })).status, 400);
  }
  assert.equal((await f.register({ token_endpoint_auth_method: 'client_secret_post' })).status, 400);
  assert.equal((await f.register({ grant_types: ['password'] })).status, 400);
  assert.equal((await f.register({ scope: 'admin' })).status, 400);
  assert.equal((await f.register({ redirect_uris: ['http://127.0.0.1:4321/callback'] })).status, 201);
  assert.equal((await f.register({ redirect_uris: ['http://[::1]:4321/callback'] })).status, 201);
});

test('complete code flow requires local consent and returns a bound bearer token', async () => {
  const f = fixture(); const id = await f.client(); const token = await f.tokens(id);
  assert.deepEqual(f.state.approvals, [{ clientName: 'Test client', redirectUri: REDIRECT, clientOrigin: 'https://client.example', scope: 'skilltask' }]);
  assert.equal(token.token_type, 'Bearer'); assert.equal(token.expires_in, 3600);
  assert.equal(token.scope, 'skilltask'); assert.equal(await f.authorized(token.access_token), true);
  assert.equal(await f.authorized(token.refresh_token), false);
  assert.equal(await f.authorized('x'.repeat(43)), false);
  assert.equal(await f.server.authenticate({ authorization: 'Bearer ' + token.access_token, Authorization: 'Bearer ' + token.access_token }), false);
});

test('remote consent metadata cannot insert lines or Unicode direction controls', async () => {
  const controls = ['\u0000', '\t', '\n', '\r', '\u007f', '\u0085', '\u009f', '\u061c', '\u200e', '\u200f',
    '\u2028', '\u2029', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069'];
  for (const control of controls) {
    const f = fixture();
    assert.equal((await f.register({ client_name: 'Client' + control + '权限：无需读取文献' })).status, 400);
    assert.equal((await f.register({ redirect_uris: ['https://attacker.example/' + control + 'fake-consent'] })).status, 400);
    assert.equal((await f.register({ redirect_uris: ['https://attacker.example/' + encodeURIComponent(control)] })).status, 400);
    assert.equal(f.state.approvals.length, 0);
  }
  const f = fixture();
  assert.equal((await f.register({ client_name: '\u202Etrusted', redirect_uris: ['https://attacker.example/\n权限：仅连接测试，无需读取文献\n'] })).status, 400);
});

test('redirects must already be safe serialized URIs; exact string matching is retained', async () => {
  const f = fixture();
  for (const uri of [' https://client.example/cb', 'https:client.example/cb', 'https:///client.example/cb',
    'https://client.example\\@evil.example/cb', 'https://%63lient.example/cb',
    'https://client.example/a/../cb', 'https://client.example/path with spaces']) {
    assert.equal((await f.register({ redirect_uris: [uri] })).status, 400);
  }
  const redirect = 'https://xn--fsqu00a.xn--0zwm56d/callback?path=%2f';
  const id = await f.client({ client_name: '研究客户端', redirect_uris: [redirect] });
  assert.equal((await f.authorize(id, { redirect_uri: redirect.replace('%2f', '%2F') })).status, 400);
  const result = await f.authorize(id, { redirect_uri: redirect });
  assert.equal(result.status, 302);
  assert.equal(f.state.approvals[0].redirectUri, redirect);
  assert.equal(f.state.approvals[0].clientOrigin, 'https://xn--fsqu00a.xn--0zwm56d');
  assert.equal(f.state.approvals[0].clientName, '研究客户端');
});

test('foreign Origin requests cannot trigger consent or registration', async () => {
  const f = fixture(); const id = await f.client();
  assert.equal((await f.authorize(id, {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal(f.state.approvals.length, 0);
  assert.equal((await f.request('POST', '/oauth/register', '{}', { origin: 'null', 'content-type': 'application/json' })).status, 403);
});

test('redirect, resource, scope and S256 must match before showing consent', async () => {
  const f = fixture(); const id = await f.client();
  for (const values of [{ redirect_uri: REDIRECT + '/other' }, { resource: 'https://evil.example/mcp' }, { resource: '' },
    { scope: 'admin' }, { code_challenge_method: 'plain' }, { response_type: 'token' }, { code_challenge: 'bad' }]) {
    const result = await f.authorize(id, values); assert.equal(result.status, 400); assert.equal(result.headers.Location, undefined);
  }
  assert.equal(f.state.approvals.length, 0);
});

test('duplicate query parameters and wrong method are rejected', async () => {
  const f = fixture(); const id = await f.client();
  const query = new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, resource: RESOURCE, response_type: 'code', code_challenge_method: 'S256', code_challenge: CHALLENGE, scope: 'skilltask' });
  query.append('redirect_uri', 'https://evil.example');
  assert.equal((await f.request('GET', '/oauth/authorize?' + query)).status, 400);
  assert.equal((await f.request('POST', '/oauth/authorize', query.toString())).status, 405);
  assert.equal(f.state.approvals.length, 0);
});

test('denied consent returns only an error and the original state', async () => {
  const f = fixture({ requestApproval: async () => false }); const id = await f.client();
  const denied = await f.authorize(id);
  const callback = new URL(denied.headers.Location);
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('state'), 'state:abc/def'); assert.equal(callback.searchParams.has('code'), false);
});

test('authorization codes are single use, including failed PKCE exchanges', async () => {
  const f = fixture(); const id = await f.client();
  const first = await f.code(id);
  assert.equal((await f.exchange(id, first, { code_verifier: 'w'.repeat(64) })).status, 400);
  assert.equal((await f.exchange(id, first)).status, 400);
  const second = await f.code(id);
  assert.equal((await f.exchange(id, second)).status, 200);
  assert.equal((await f.exchange(id, second)).status, 400);
});

test('codes are client and callback bound', async () => {
  const f = fixture(); const one = await f.client(); const two = await f.client();
  assert.equal((await f.exchange(two, await f.code(one))).status, 400);
  assert.equal((await f.exchange(one, await f.code(one), { redirect_uri: REDIRECT + '/other' })).status, 400);
});

test('wrong or missing token resource never issues a credential', async () => {
  const f = fixture(); const id = await f.client(); const code = await f.code(id);
  assert.equal((await f.exchange(id, code, { resource: 'https://evil.example/mcp' })).status, 400);
  assert.equal((await f.exchange(id, code, { resource: '' })).status, 400);
  assert.equal((await f.exchange(id, code)).status, 200);
});

test('authorization codes expire after five minutes; access tokens after one hour', async () => {
  const f = fixture(); const id = await f.client(); const code = await f.code(id);
  f.state.now += 5 * 60_000;
  assert.equal((await f.exchange(id, code)).status, 400);
  const token = await f.tokens(id);
  f.state.now += 3600_000;
  assert.equal(await f.authorized(token.access_token), false);
  assert.equal((await f.refresh(id, token.refresh_token)).status, 200);
});

test('refresh rotation detects replay and revokes the whole credential family', async () => {
  const f = fixture(); const id = await f.client(); const old = await f.tokens(id);
  const rotated = JSON.parse((await f.refresh(id, old.refresh_token)).body);
  assert.notEqual(rotated.refresh_token, old.refresh_token);
  assert.equal(await f.authorized(rotated.access_token), true);
  assert.equal((await f.refresh(id, old.refresh_token)).status, 400);
  assert.equal(await f.authorized(old.access_token), false);
  assert.equal(await f.authorized(rotated.access_token), false);
  assert.equal((await f.refresh(id, rotated.refresh_token)).status, 400);
});

test('refresh credentials remain client-bound and expire after thirty days', async () => {
  const f = fixture(); const first = await f.client(); const second = await f.client(); const token = await f.tokens(first);
  assert.equal((await f.refresh(second, token.refresh_token)).status, 400);
  assert.equal(await f.authorized(token.access_token), true);
  f.state.now += 30 * 24 * 3600_000;
  assert.notEqual((await f.refresh(first, token.refresh_token)).status, 200);
  assert.equal(await f.authorized(token.access_token), false);
});

test('simultaneous reuse cannot resurrect a revoked refresh family', async () => {
  const f = fixture(); const id = await f.client(); const token = await f.tokens(id);
  const responses = await Promise.all([f.refresh(id, token.refresh_token), f.refresh(id, token.refresh_token)]);
  assert.ok(responses.some((r) => r.status === 400));
  assert.equal(await f.authorized(token.access_token), false);
  for (const result of responses) if (result.status === 200) assert.equal(await f.authorized(JSON.parse(result.body).access_token), false);
});

test('revocation invalidates both access and refresh tokens without disclosing unknown tokens', async () => {
  const f = fixture(); const id = await f.client(); const token = await f.tokens(id);
  assert.equal((await f.form('/oauth/revoke', { client_id: id, token: token.access_token })).status, 200);
  assert.equal(await f.authorized(token.access_token), false);
  assert.equal((await f.refresh(id, token.refresh_token)).status, 400);
  assert.equal((await f.form('/oauth/revoke', { client_id: id, token: 'x'.repeat(43) })).status, 200);
});

test('auth-code-only clients do not receive a refresh grant', async () => {
  const f = fixture(); const id = await f.client({ grant_types: ['authorization_code'] });
  assert.equal((await f.tokens(id)).refresh_token, undefined);
  assert.equal((await f.refresh(id, 'x'.repeat(43))).status, 400);
});

test('tokens do not survive restart, issuer change, or explicit revokeAll', async () => {
  const f = fixture(); const id = await f.client(); const token = await f.tokens(id);
  assert.equal(await fixture().authorized(token.access_token), false);
  f.state.origin = 'https://new.example';
  assert.equal(await f.authorized(token.access_token), false);
  f.state.origin = PUBLIC;
  assert.equal(await f.authorized(token.access_token), false);
  const nextId = await f.client(); const next = await f.tokens(nextId); f.server.revokeAll();
  assert.equal(await f.authorized(next.access_token), false);
});

test('revoking while consent is pending prevents late approval issuing a code', async () => {
  let approve;
  const f = fixture({ requestApproval: () => new Promise((resolve) => { approve = resolve; }) });
  const id = await f.client(); const pending = f.authorize(id);
  await Promise.resolve(); assert.equal(typeof approve, 'function');
  f.server.revokeAll(); approve(true);
  const result = await pending; assert.equal(result.status, 400); assert.equal(result.headers.Location, undefined);
});

test('only one local consent can be pending; timeout cannot start a second dialog', async () => {
  let approve;
  const f = fixture({ requestApproval: () => new Promise((resolve) => { approve = resolve; }), approvalTimeoutMs: 5 });
  const id = await f.client(); const pending = f.authorize(id); await Promise.resolve();
  assert.equal((await f.authorize(id)).status, 429);
  const timeout = await pending;
  assert.equal(new URL(timeout.headers.Location).searchParams.get('error'), 'access_denied');
  assert.equal((await f.authorize(id)).status, 429);
  approve(true); await Promise.resolve(); await Promise.resolve();
});

test('registration rate and memory capacity are bounded', async () => {
  const rate = fixture();
  for (let i = 0; i < 16; i++) assert.equal((await rate.register()).status, 201);
  assert.equal((await rate.register()).status, 429);
  rate.state.now += 60_000;
  assert.equal((await rate.register()).status, 201);
  const capacity = fixture();
  for (let i = 0; i < 128; i++) assert.equal((await capacity.register({}, '192.0.2.' + i)).status, 201);
  assert.equal((await capacity.register({}, '192.0.2.254')).status, 503);
});

test('oversized requests and duplicate form parameters are refused', async () => {
  const f = fixture(); const id = await f.client();
  assert.equal((await f.request('POST', '/oauth/register', 'x'.repeat(8193))).status, 413);
  const body = new URLSearchParams({ client_id: id, grant_type: 'authorization_code', resource: RESOURCE }).toString() + '&client_id=other';
  assert.equal((await f.request('POST', '/oauth/token', body, { 'content-type': 'application/x-www-form-urlencoded' })).status, 400);
});

for (const { name, body } of tests) {
  try { await body(); }
  catch (error) { console.error('FAIL:', name); throw error; }
}
console.log(`OAuth tests passed (${tests.length} cases).`);
