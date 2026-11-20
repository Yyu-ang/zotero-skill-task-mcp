/** Independent MCP sockets: 23123 for local/LAN access, 23124 for OAuth. */
import {
  HttpSocketListener, httpError, LAN_MCP_PATH, LAN_MCP_PORT, OAUTH_MCP_PORT,
  type HttpHandler, type HttpPreflight, type HttpRequest, type HttpResponse,
} from './lanMcpListener';

function ipv4(address: string): number[] | null {
  const pieces = address.split('.');
  if (pieces.length !== 4 || pieces.some(p => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) return null;
  return pieces.map(Number);
}

function ipv6(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  // A local scope identifier can be present on an accepted link-local transport.
  normalized = normalized.replace(/%[a-z0-9_.-]+$/i, '');
  if (normalized.includes('.')) {
    const at = normalized.lastIndexOf(':');
    const tail = ipv4(normalized.slice(at + 1));
    if (!tail) return null;
    normalized = normalized.slice(0, at + 1) + ((tail[0] << 8) | tail[1]).toString(16) + ':' + ((tail[2] << 8) | tail[3]).toString(16);
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(word => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  return [...left.map(x => parseInt(x, 16)), ...Array(8 - left.length - right.length).fill(0), ...right.map(x => parseInt(x, 16))];
}

function mappedIPv4(words: number[]): number[] | null {
  return words.slice(0, 5).every(x => x === 0) && words[5] === 0xffff
    ? [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255] : null;
}

export function isLoopbackAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return v4[0] === 127;
  const v6 = ipv6(address);
  if (!v6) return false;
  const mapped = mappedIPv4(v6);
  return mapped ? mapped[0] === 127 : v6.slice(0, 7).every(x => x === 0) && v6[7] === 1;
}

function isPrivateIPv4(address: number[]): boolean {
  return address[0] === 10 ||
    (address[0] === 172 && address[1] >= 16 && address[1] <= 31) ||
    (address[0] === 192 && address[1] === 168) ||
    (address[0] === 169 && address[1] === 254);
}

/** RFC1918 and link-local IPv4, IPv6 ULA/link-local, plus loopback. */
export function isLanAddress(address: string): boolean {
  if (isLoopbackAddress(address)) return true;
  const v4 = ipv4(address);
  if (v4) return isPrivateIPv4(v4);
  const v6 = ipv6(address);
  if (!v6) return false;
  const mapped = mappedIPv4(v6);
  return mapped ? isPrivateIPv4(mapped) : (v6[0] & 0xfe00) === 0xfc00 || (v6[0] & 0xffc0) === 0xfe80;
}

function validLocalHost(host: string): boolean {
  return /^(?:localhost|127\.0\.0\.1|\[::1\]):23123$/i.test(host);
}

function validLanHost(host: string): boolean {
  const match = /^(\[[0-9a-fA-F:]+\]|[0-9.]+):23123$/.exec(host);
  return !!match && isLanAddress(match[1]) && !isLoopbackAddress(match[1]);
}

/** The unauthenticated entry point accepts only MCP from its selected scope. */
export async function lanRequestPolicy(request: HttpRequest, allowRemote = true): Promise<HttpResponse | null> {
  const peer = request.remoteAddress ?? '';
  const local = isLoopbackAddress(peer);
  if (!local && (!allowRemote || !isLanAddress(peer))) return httpError(403, 'Client is outside the allowed network');
  if (local ? !validLocalHost(request.headers.host ?? '') : !validLanHost(request.headers.host ?? '')) {
    return httpError(403, 'Use the literal local or LAN address and port 23123');
  }
  if (request.headers.origin !== undefined) return httpError(403, 'Browser-origin requests are not allowed on the local/LAN endpoint');
  if (request.path !== LAN_MCP_PATH) return httpError(404, 'Not found');
  if (request.method !== 'POST') return { ...httpError(405, 'Use POST'), headers: { 'Content-Type': 'application/json', Allow: 'POST' } };
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return httpError(415, 'Content-Type must be application/json');
  return null;
}

export interface NetworkConfiguration {
  enabled: boolean;
  allowRemote: boolean;
  oauthEnabled: boolean;
}

export interface NetworkState {
  localAccessible: boolean;
  localPort: number | null;
  lanAccessible: boolean;
  lanPort: number | null;
  oauthAccessible: boolean;
  oauthPort: number | null;
  mode: 'loopback' | 'lan' | 'internet' | 'stopped';
  error: string | null;
}

export class NetworkAccess {
  private lan: HttpSocketListener | null = null;
  private oauth: HttpSocketListener | null = null;
  private localRemote = false;
  private enabled = false;
  private lastError: string | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    handleLan: HttpHandler;
    handleOAuth: HttpHandler;
    preflightOAuth?: HttpPreflight;
    maxBodyBytes?: () => number;
  }) {}

  configure(config: NetworkConfiguration): Promise<void> {
    const captured = { ...config };
    const work = this.pending.catch(() => {}).then(() => this.applyConfiguration(captured));
    this.pending = work;
    return work;
  }

  stop(): Promise<void> { return this.configure({ enabled: false, allowRemote: false, oauthEnabled: false }); }

  getState(): NetworkState {
    const localAccessible = this.enabled && !!this.lan?.isRunning();
    const lanAccessible = localAccessible && this.localRemote;
    const oauthAccessible = lanAccessible && !!this.oauth?.isRunning();
    // The OAuth endpoint is never left live without its paired base listener.
    if (!lanAccessible && this.oauth?.isRunning()) this.oauth.stop();
    return {
      localAccessible, localPort: localAccessible ? LAN_MCP_PORT : null,
      lanAccessible, lanPort: lanAccessible ? LAN_MCP_PORT : null,
      oauthAccessible, oauthPort: oauthAccessible ? OAUTH_MCP_PORT : null,
      mode: !localAccessible ? 'stopped' : oauthAccessible ? 'internet' : lanAccessible ? 'lan' : 'loopback',
      error: this.lastError,
    };
  }

  private stopListeners(): void {
    this.oauth?.stop();
    this.lan?.stop();
    this.localRemote = false;
  }

  private listenerStopped = (): void => {
    this.stopListeners();
    this.lastError = 'An MCP listener stopped unexpectedly; both plugin entry points were closed';
  };

  private startLocal(allowRemote: boolean): void {
    this.lan = new HttpSocketListener({
      port: LAN_MCP_PORT, loopbackOnly: !allowRemote, handle: this.options.handleLan,
      preflight: request => lanRequestPolicy(request, allowRemote),
      acceptPeer: allowRemote ? isLanAddress : isLoopbackAddress,
      maxBodyBytes: this.options.maxBodyBytes, onStopped: this.listenerStopped,
    });
    this.lan.start();
    this.localRemote = allowRemote;
  }

  private async applyConfiguration(config: NetworkConfiguration): Promise<void> {
    this.lastError = null;
    this.enabled = config.enabled;
    // Closing before rebinding prevents requests from retaining an old policy.
    this.stopListeners();
    if (!config.enabled) return;
    try {
      this.startLocal(config.allowRemote);
      if (config.allowRemote && config.oauthEnabled) {
        this.oauth = new HttpSocketListener({
          port: OAUTH_MCP_PORT, loopbackOnly: false, handle: this.options.handleOAuth,
          // No caller may accidentally create an unauthenticated second port.
          preflight: this.options.preflightOAuth ?? (async () => httpError(503, 'OAuth access policy is unavailable')),
          maxBodyBytes: this.options.maxBodyBytes, onStopped: this.listenerStopped,
        });
        this.oauth.start();
      }
    } catch (error) {
      this.stopListeners();
      this.lastError = error instanceof Error ? error.message : String(error);
      if (config.allowRemote) {
        try { this.startLocal(false); }
        catch (restoreError) {
          this.lastError += '; loopback fallback failed: ' + (restoreError instanceof Error ? restoreError.message : String(restoreError));
        }
      }
      throw new Error(this.lastError);
    }
  }
}
