/** OAuth authorization code + S256 PKCE. Every grant requires local Zotero consent. */
export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  remoteAddress?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface OAuthApproval {
  clientName: string;
  redirectUri: string;
  /** Canonical ASCII origin to display separately from client-supplied text. */
  clientOrigin?: string;
  scope: string;
}

export interface OAuthDependencies {
  getPublicOrigin: () => string;
  requestApproval: (request: OAuthApproval) => Promise<boolean>;
  now?: () => number;
  crypto?: Pick<Crypto, 'getRandomValues' | 'subtle'>;
  approvalTimeoutMs?: number;
}

type Client = { name: string; redirects: string[]; grants: string[]; expires: number };
type Grant = { clientId: string; redirect: string; challenge: string; resource: string; expires: number };
type Credential = { clientId: string; resource: string; family: string; expires: number; used?: boolean };
const SCOPE = 'skilltask';
const MINUTE = 60_000;
const CODE_TTL = 5 * MINUTE;
const ACCESS_TTL = 60 * MINUTE;
const REFRESH_TTL = 30 * 24 * 60 * MINUTE;
const MAX_BODY = 8192;
const MAX_CLIENTS = 128;
const MAX_CODES = 128;
const MAX_TOKENS = 512;
const MAX_REFRESH = 2048;
const MAX_FAMILIES = 256;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
// Never let remote metadata insert lines or change text direction in local consent.
const UNSAFE_CONSENT_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

/** The public issuer is operator configured, never derived from request headers. */
export function normalizeOAuthOrigin(value: string): string | null {
  try {
    if (UNSAFE_CONSENT_TEXT.test(value) || value !== value.trim() || value.includes('\\')) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function header(headers: Record<string, string>, name: string): string {
  const keys = Object.keys(headers).filter((key) => key.toLowerCase() === name);
  return keys.length === 1 ? headers[keys[0]].trim() : '';
}

function response(status: number, value: unknown, extra: Record<string, string> = {}): HttpResponse {
  return { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...extra,
  }, body: JSON.stringify(value) };
}

function error(status: number, reason: string, extra: Record<string, string> = {}): HttpResponse {
  return response(status, { error: reason }, extra);
}

function base64url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    output += alphabet[(chunk >>> 18) & 63] + alphabet[(chunk >>> 12) & 63];
    if (i + 1 < bytes.length) output += alphabet[(chunk >>> 6) & 63];
    if (i + 2 < bytes.length) output += alphabet[chunk & 63];
  }
  return output;
}

function uniqueParameters(form: URLSearchParams): boolean {
  const keys = new Set<string>();
  for (const [key] of form) {
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 2048 || UNSAFE_CONSENT_TEXT.test(uri) || /\s|\\/.test(uri)) return false;
  try {
    const url = new URL(uri);
    // Require an already serialized URI: WHATWG parsing must not silently repair
    // separators, discard characters, decode a disguised host, or rewrite its path.
    // Keep that validated original string for OAuth's exact redirect matching.
    if (url.href !== uri || UNSAFE_CONSENT_TEXT.test(decodeURIComponent(uri))) return false;
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    return !url.username && !url.password && !url.hash && Boolean(url.hostname) &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
  } catch { return false; }
}

export class OAuthServer {
  private origin: string | null = null;
  private generation = 0;
  private approvalPending = false;
  private readonly clients = new Map<string, Client>();
  private readonly codes = new Map<string, Grant>();
  // Only digests of credentials are retained. All authorization state is process-local.
  private readonly access = new Map<string, Credential>();
  private readonly refresh = new Map<string, Credential>();
  private readonly families = new Map<string, number>();
  private readonly rates = new Map<string, { count: number; until: number }>();

  constructor(private readonly deps: OAuthDependencies) {}

  private now(): number { return (this.deps.now || Date.now)(); }

  private crypto(): Pick<Crypto, 'getRandomValues' | 'subtle'> {
    const crypto = this.deps.crypto || globalThis.crypto;
    if (!crypto?.getRandomValues || !crypto.subtle?.digest) throw new Error('Secure crypto unavailable');
    return crypto;
  }

  private random(): string {
    const bytes = new Uint8Array(32);
    this.crypto().getRandomValues(bytes);
    return base64url(bytes);
  }

  private async digest(value: string): Promise<string> {
    return base64url(new Uint8Array(await this.crypto().subtle.digest('SHA-256', new TextEncoder().encode(value))));
  }

  revokeAll(): void {
    this.generation++;
    this.clients.clear(); this.codes.clear(); this.access.clear(); this.refresh.clear(); this.families.clear();
    // An already displayed consent dialog still owns the single consent slot.
  }

  private syncOrigin(): string | null {
    let next: string | null;
    try { next = normalizeOAuthOrigin(this.deps.getPublicOrigin()); } catch { next = null; }
    if (next !== this.origin) { this.revokeAll(); this.origin = next; }
    return next;
  }

  private current(generation: number): boolean {
    return Boolean(this.syncOrigin()) && generation === this.generation;
  }

  isConfigured(): boolean {
    try { this.crypto(); return Boolean(this.syncOrigin()); } catch { return false; }
  }

  private resource(origin: string): string { return `${origin}/skilltask/mcp`; }

  private revokeFamily(family: string): void {
    this.families.delete(family);
    for (const [key, token] of this.access) if (token.family === family) this.access.delete(key);
    for (const [key, token] of this.refresh) if (token.family === family) this.refresh.delete(key);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.codes) if (value.expires <= now) this.codes.delete(key);
    for (const [key, value] of this.access) if (value.expires <= now) this.access.delete(key);
    for (const [key, value] of this.refresh) if (value.expires <= now) this.refresh.delete(key);
    for (const [key, expires] of this.families) if (expires <= now) this.revokeFamily(key);
    for (const [key, value] of this.clients) if (value.expires <= now) this.clients.delete(key);
    for (const [key, value] of this.rates) if (value.until <= now) this.rates.delete(key);
  }

  private limit(request: HttpRequest, path: string): boolean {
    this.prune();
    const key = `${request.remoteAddress || 'unknown'}:${path}`;
    const previous = this.rates.get(key);
    const maximum = path === '/oauth/authorize' ? 10 : path === '/oauth/register' ? 16 : 120;
    if (previous) return ++previous.count <= maximum;
    if (this.rates.size >= 1024) return false;
    this.rates.set(key, { count: 1, until: this.now() + MINUTE });
    return true;
  }

  unauthorized(): HttpResponse {
    const origin = this.syncOrigin();
    return error(401, 'invalid_token', { 'WWW-Authenticate': 'Bearer realm="skilltask"' +
      (origin ? `, resource_metadata="${origin}/.well-known/oauth-protected-resource/skilltask/mcp", scope="${SCOPE}"` : '') });
  }

  async authenticate(headers: Record<string, string>): Promise<boolean> {
    try {
      const origin = this.syncOrigin();
      if (!origin) return false;
      const generation = this.generation;
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header(headers, 'authorization'));
      if (!match) return false;
      this.prune();
      const digest = await this.digest(`access:${match[1]}`);
      if (!this.current(generation)) return false;
      const token = this.access.get(digest);
      return Boolean(token && token.expires > this.now() && token.resource === this.resource(origin) &&
        this.clients.has(token.clientId) && this.families.has(token.family));
    } catch { return false; }
  }

  async handle(request: HttpRequest): Promise<HttpResponse | null> {
    // No forwarded header is an authorization input.
    if (!request.path.startsWith('/') || request.path.startsWith('//') || request.path.includes('\\')) return null;
    let url: URL;
    try { url = new URL(request.path, 'https://invalid.example'); } catch { return error(400, 'invalid_request'); }
    const path = url.pathname;
    const metadata = path === '/.well-known/oauth-authorization-server' ||
      path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/skilltask/mcp';
    if (!metadata && !['/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke'].includes(path)) return null;
    try {
      const origin = this.syncOrigin();
      if (!origin) return error(503, 'oauth_configuration_required');
      this.crypto();
      const generation = this.generation;
      const resource = this.resource(origin);
      if (url.hash || request.path.length > MAX_BODY || new TextEncoder().encode(request.body).length > MAX_BODY) {
        return error(413, 'request_too_large');
      }
      const requestOrigin = header(request.headers, 'origin');
      if (requestOrigin && requestOrigin !== origin) return error(403, 'cross_origin_request');
      if (!this.limit(request, path)) return error(429, 'rate_limit_exceeded', { 'Retry-After': '60' });
      const expectedMethod = metadata || path === '/oauth/authorize' ? 'GET' : 'POST';
      if (request.method !== expectedMethod) return error(405, 'method_not_allowed', { Allow: expectedMethod });
      if (metadata) {
        if (path !== '/.well-known/oauth-authorization-server') {
          return response(200, { resource, authorization_servers: [origin], bearer_methods_supported: ['header'], scopes_supported: [SCOPE] });
        }
        return response(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], scopes_supported: [SCOPE],
          authorization_response_iss_parameter_supported: true,
          token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (path === '/oauth/register') return this.register(request);
      if (path === '/oauth/authorize') return await this.authorize(url.searchParams, resource, generation);
      if (header(request.headers, 'content-type').split(';')[0].toLowerCase() !== 'application/x-www-form-urlencoded') {
        return error(415, 'invalid_request');
      }
      const form = new URLSearchParams(request.body);
      if (!uniqueParameters(form) || header(request.headers, 'authorization') || form.has('client_secret')) return error(400, 'invalid_request');
      const clientId = form.get('client_id') || '';
      if (!this.clients.has(clientId)) return error(401, 'invalid_client');
      if (path === '/oauth/revoke') return await this.revoke(form, clientId, generation);
      if (form.get('resource') !== resource || (form.has('scope') && form.get('scope') !== SCOPE)) return error(400, 'invalid_target');
      return await this.exchange(form, clientId, resource, generation);
    } catch { return error(503, 'temporarily_unavailable'); }
  }

  private register(request: HttpRequest): HttpResponse {
    if (header(request.headers, 'content-type').split(';')[0].toLowerCase() !== 'application/json') return error(415, 'invalid_client_metadata');
    let metadata: any;
    try { metadata = JSON.parse(request.body); } catch { return error(400, 'invalid_client_metadata'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length < 1 || metadata.redirect_uris.length > 10 ||
        !metadata.redirect_uris.every(validRedirect) || new Set(metadata.redirect_uris).size !== metadata.redirect_uris.length ||
        (metadata.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== 'none') ||
        (metadata.scope !== undefined && metadata.scope !== SCOPE) ||
        (metadata.client_name !== undefined && (typeof metadata.client_name !== 'string' || metadata.client_name.length > 100 || UNSAFE_CONSENT_TEXT.test(metadata.client_name))) ||
        (metadata.response_types !== undefined && (JSON.stringify(metadata.response_types) !== '["code"]')) ||
        (metadata.grant_types !== undefined && (!Array.isArray(metadata.grant_types) ||
          !metadata.grant_types.includes('authorization_code') ||
          metadata.grant_types.some((grant: unknown) => grant !== 'authorization_code' && grant !== 'refresh_token')))) {
      return error(400, 'invalid_client_metadata');
    }
    if (this.clients.size >= MAX_CLIENTS) return error(503, 'registration_limit');
    const clientId = this.random();
    const grants = metadata.grant_types || ['authorization_code', 'refresh_token'];
    this.clients.set(clientId, { name: metadata.client_name?.trim() || clientId,
      redirects: [...metadata.redirect_uris], grants: [...grants], expires: this.now() + 60 * MINUTE });
    return response(201, { client_id: clientId, client_id_issued_at: Math.floor(this.now() / 1000),
      redirect_uris: metadata.redirect_uris, token_endpoint_auth_method: 'none',
      response_types: ['code'], grant_types: grants, scope: SCOPE });
  }

  private async authorize(form: URLSearchParams, resource: string, generation: number): Promise<HttpResponse> {
    const clientId = form.get('client_id') || '';
    const client = this.clients.get(clientId);
    const redirect = form.get('redirect_uri') || '';
    const challenge = form.get('code_challenge') || '';
    const state = form.get('state');
    if (!uniqueParameters(form) || !client || !client.redirects.includes(redirect) ||
        form.get('response_type') !== 'code' || form.get('code_challenge_method') !== 'S256' || !SECRET.test(challenge) ||
        form.get('resource') !== resource || form.get('scope') !== SCOPE || (state !== null && state.length > 1024)) {
      return error(400, 'invalid_request');
    }
    if (this.approvalPending) return error(429, 'authorization_pending', { 'Retry-After': '5' });
    if (this.codes.size >= MAX_CODES) return error(503, 'authorization_limit');
    this.approvalPending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let approved = false;
    try {
      approved = await Promise.race([
        Promise.resolve().then(() => this.deps.requestApproval({ clientName: client.name, redirectUri: redirect,
          clientOrigin: new URL(redirect).origin, scope: SCOPE }))
          .catch(() => false).finally(() => { this.approvalPending = false; }),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.deps.approvalTimeoutMs || 60_000); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!this.current(generation) || this.clients.get(clientId) !== client) return error(400, 'authorization_expired');
    const callback = new URL(redirect);
    callback.searchParams.set('iss', this.origin!);
    if (state !== null) callback.searchParams.set('state', state);
    if (!approved) callback.searchParams.set('error', 'access_denied');
    else {
      const code = this.random();
      this.codes.set(code, { clientId, redirect, challenge, resource, expires: this.now() + CODE_TTL });
      callback.searchParams.set('code', code);
    }
    return response(302, {}, { Location: callback.toString() });
  }

  private async exchange(form: URLSearchParams, clientId: string, resource: string, generation: number): Promise<HttpResponse> {
    if (form.get('grant_type') === 'authorization_code') {
      const code = form.get('code') || '';
      const grant = this.codes.get(code);
      this.codes.delete(code); // Consume before awaiting crypto, including failed exchanges.
      const verifier = form.get('code_verifier') || '';
      if (!grant || grant.expires <= this.now() || grant.clientId !== clientId || grant.resource !== resource ||
          grant.redirect !== form.get('redirect_uri') || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return error(400, 'invalid_grant');
      if (await this.digest(verifier) !== grant.challenge || !this.current(generation)) return error(400, 'invalid_grant');
      if (this.families.size >= MAX_FAMILIES) return error(503, 'authorization_limit');
      const family = this.random();
      this.families.set(family, this.now() + REFRESH_TTL);
      return await this.issue(clientId, resource, family, generation);
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (!this.clients.get(clientId)?.grants.includes('refresh_token')) return error(400, 'unauthorized_client');
      const secret = form.get('refresh_token') || '';
      if (!SECRET.test(secret)) return error(400, 'invalid_grant');
      const key = await this.digest(`refresh:${secret}`);
      if (!this.current(generation)) return error(400, 'invalid_grant');
      const token = this.refresh.get(key);
      if (!token || token.clientId !== clientId || token.resource !== resource || token.expires <= this.now()) return error(400, 'invalid_grant');
      if (token.used) { this.revokeFamily(token.family); return error(400, 'invalid_grant'); }
      token.used = true; // Retain until expiry to detect reuse and revoke its complete family.
      return await this.issue(clientId, resource, token.family, generation);
    }
    return error(400, 'unsupported_grant_type');
  }

  private async issue(clientId: string, resource: string, family: string, generation: number): Promise<HttpResponse> {
    this.prune();
    if (this.access.size >= MAX_TOKENS || this.refresh.size >= MAX_REFRESH) return error(503, 'authorization_limit');
    const access = this.random();
    const refresh = this.random();
    const [accessKey, refreshKey] = await Promise.all([this.digest(`access:${access}`), this.digest(`refresh:${refresh}`)]);
    const familyExpiry = this.families.get(family);
    if (!this.current(generation) || !familyExpiry || familyExpiry <= this.now() || !this.clients.has(clientId)) return error(400, 'invalid_grant');
    // Re-check capacities after asynchronous digest work.
    if (this.access.size >= MAX_TOKENS || this.refresh.size >= MAX_REFRESH) return error(503, 'authorization_limit');
    const expires = Math.min(this.now() + ACCESS_TTL, familyExpiry);
    this.access.set(accessKey, { clientId, resource, family, expires });
    const mayRefresh = this.clients.get(clientId)!.grants.includes('refresh_token');
    this.clients.get(clientId)!.expires = Math.max(this.clients.get(clientId)!.expires, familyExpiry);
    if (mayRefresh) this.refresh.set(refreshKey, { clientId, resource, family, expires: familyExpiry });
    return response(200, { access_token: access, ...(mayRefresh ? { refresh_token: refresh } : {}), token_type: 'Bearer',
      expires_in: Math.floor((expires - this.now()) / 1000), scope: SCOPE });
  }

  private async revoke(form: URLSearchParams, clientId: string, generation: number): Promise<HttpResponse> {
    const secret = form.get('token') || '';
    if (!SECRET.test(secret)) return response(200, {});
    const [accessKey, refreshKey] = await Promise.all([this.digest(`access:${secret}`), this.digest(`refresh:${secret}`)]);
    if (!this.current(generation)) return response(200, {});
    const token = this.refresh.get(refreshKey) || this.access.get(accessKey);
    if (token?.clientId === clientId) this.revokeFamily(token.family);
    return response(200, {}); // RFC 7009: do not reveal whether the token existed.
  }
}
