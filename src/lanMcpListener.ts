/** Bounded HTTP/1 transport used by the LAN and OAuth entry points. */
declare const Cc: any;
declare const Ci: any;
declare const TextDecoder: any;
declare const TextEncoder: any;

export const LAN_MCP_PORT = 23123;
export const OAUTH_MCP_PORT = 23124;
export const LAN_MCP_PATH = '/skilltask/mcp';

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

export type HttpHandler = (request: HttpRequest) => Promise<HttpResponse>;
export type HttpPreflight = (request: HttpRequest) => Promise<HttpResponse | null>;

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CONNECTIONS = 16;
const MAX_BUFFERED_BODY_BYTES = 512 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;
const HTTP_REASON: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 302: 'Found',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 411: 'Length Required',
  413: 'Payload Too Large', 415: 'Unsupported Media Type', 429: 'Too Many Requests',
  500: 'Internal Server Error', 503: 'Service Unavailable',
};

export function httpError(status: number, message: string): HttpResponse {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }) };
}

/** Accept only origin-form requests and unambiguous, single-valued headers. */
export function parseRequestHeaders(headerText: string): {
  method: string; path: string; headers: Record<string, string>;
} {
  const lines = headerText.split('\r\n');
  const match = /^(GET|POST|OPTIONS|DELETE|HEAD) (\/[^\s\u0000-\u001f]*) HTTP\/1\.[01]$/.exec(lines.shift() ?? '');
  if (!match || match[2].startsWith('//') || match[2].includes('#')) throw new Error('Invalid request line');
  const headers: Record<string, string> = Object.create(null);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('Invalid header');
    const rawKey = line.slice(0, colon);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawKey)) throw new Error('Invalid header name');
    const key = rawKey.toLowerCase();
    const rawValue = line.slice(colon + 1);
    if (key in headers || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(rawValue)) throw new Error('Invalid header value');
    const value = rawValue.replace(/^[ \t]+|[ \t]+$/g, '');
    headers[key] = value;
  }
  if (!headers.host || headers['transfer-encoding'] !== undefined) throw new Error('Ambiguous framing');
  return { method: match[1], path: match[2], headers };
}

/** The accepted transport, never a forwarded header, is the peer authority. */
export function transportPeerAddress(transport: any): string {
  try {
    const address = transport.getScriptablePeerAddr?.()?.address;
    if (typeof address === 'string' && address) return address;
  } catch { /* Zotero's older Gecko exposes host instead. */ }
  try { return typeof transport.host === 'string' ? transport.host : ''; } catch { return ''; }
}

export class HttpSocketListener {
  private socket: any = null;
  private active = false;
  private generation = 0;
  private bufferedBytes = 0;
  private readonly transports = new Set<any>();

  constructor(private readonly options: {
    port: number;
    loopbackOnly?: boolean;
    handle: HttpHandler;
    preflight?: HttpPreflight;
    acceptPeer?: (address: string) => boolean;
    maxBodyBytes?: () => number;
    onStopped?: () => void;
  }) {}

  isRunning(): boolean { return this.active; }

  start(): void {
    if (this.socket) return;
    const socket = Cc['@mozilla.org/network/server-socket;1'].createInstance(Ci.nsIServerSocket);
    try {
      socket.init(this.options.port, this.options.loopbackOnly ?? false, -1);
      this.socket = socket;
      this.active = true;
      const generation = this.generation;
      socket.asyncListen({
        onSocketAccepted: (acceptedSocket: any, transport: any) => {
          if (acceptedSocket === this.socket && generation === this.generation) this.accept(transport);
          else { try { transport.close(0); } catch {} }
        },
        onStopListening: (stoppedSocket: any) => {
          if (this.socket === stoppedSocket) {
            this.stop();
            this.options.onStopped?.();
          }
        },
      });
    } catch (error) {
      this.socket = null;
      this.active = false;
      try { socket.close(); } catch {}
      throw error;
    }
  }

  accept(transport: any): void {
    const peer = transportPeerAddress(transport);
    if (!this.active || !peer || this.transports.size >= MAX_CONNECTIONS ||
        (this.options.acceptPeer && !this.options.acceptPeer(peer))) {
      try { transport.close(0); } catch {}
      return;
    }
    this.transports.add(transport);
    const generation = this.generation;
    void this.serve(transport, peer, generation).finally(() => this.transports.delete(transport));
  }

  stop(): void {
    this.active = false;
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch {}
    for (const transport of this.transports) {
      try { transport.close(0); } catch {}
    }
    this.transports.clear();
  }

  private async serve(transport: any, remoteAddress: string, generation: number): Promise<void> {
    let input: any = null;
    let output: any = null;
    let reserved = 0;
    const current = () => this.active && this.generation === generation;
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    let lastDataAt = Date.now();
    const timedOut = () => Date.now() >= deadline || Date.now() - lastDataAt >= IDLE_TIMEOUT_MS;
    try {
      input = transport.openInputStream(0, 0, 0);
      output = transport.openOutputStream(0, 0, 0);
      const binary = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
      binary.setInputStream(input);
      const headerBytes: number[] = [];
      let headerEnd = -1;
      while (headerEnd < 0 && current()) {
        if (timedOut()) { this.writeResponse(output, httpError(408, 'Request timeout')); return; }
        const available = this.available(input);
        if (!available) { await this.pause(); continue; }
        lastDataAt = Date.now();
        const from = Math.max(0, headerBytes.length - 3);
        headerBytes.push(...binary.readByteArray(Math.min(available, 4096)));
        for (let i = from; i + 3 < headerBytes.length; i++) {
          if (headerBytes[i] === 13 && headerBytes[i + 1] === 10 && headerBytes[i + 2] === 13 && headerBytes[i + 3] === 10) {
            headerEnd = i; break;
          }
        }
        if ((headerEnd < 0 ? headerBytes.length : headerEnd + 4) > MAX_HEADER_BYTES) {
          this.writeResponse(output, httpError(413, 'Headers too large')); return;
        }
      }
      if (!current()) return;
      let parsed: ReturnType<typeof parseRequestHeaders>;
      try {
        parsed = parseRequestHeaders(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(headerBytes.slice(0, headerEnd))));
      } catch {
        this.writeResponse(output, httpError(400, 'Invalid headers')); return;
      }
      const request: HttpRequest = { ...parsed, body: '', remoteAddress };
      // Authentication and route policy run before body allocation or reading.
      const rejection = await this.options.preflight?.(request);
      if (!current()) return;
      if (rejection) { this.writeResponse(output, rejection); return; }
      const length = parsed.headers['content-length'];
      if (length === undefined && parsed.method === 'POST') {
        this.writeResponse(output, httpError(411, 'Content-Length required')); return;
      }
      if (length !== undefined && !/^\d+$/.test(length)) {
        this.writeResponse(output, httpError(400, 'Invalid Content-Length')); return;
      }
      const size = Number(length ?? 0);
      const configuredLimit = this.options.maxBodyBytes?.() ?? 16 * 1024 * 1024;
      const maxBodyBytes = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
        ? Math.min(configuredLimit, MAX_BUFFERED_BODY_BYTES) : 16 * 1024 * 1024;
      if (!Number.isSafeInteger(size) || size > maxBodyBytes) {
        this.writeResponse(output, httpError(413, 'Request too large')); return;
      }
      if ((parsed.method === 'GET' || parsed.method === 'HEAD' || parsed.method === 'OPTIONS') && size > 0) {
        this.writeResponse(output, httpError(400, 'Unexpected request body')); return;
      }
      if (this.bufferedBytes + size > MAX_BUFFERED_BODY_BYTES) {
        this.writeResponse(output, httpError(503, 'Request capacity exceeded')); return;
      }
      const initial = headerBytes.slice(headerEnd + 4);
      if (initial.length > size) {
        this.writeResponse(output, httpError(400, 'Request body overrun')); return;
      }
      this.bufferedBytes += size;
      reserved = size;
      const body = new Uint8Array(size);
      body.set(initial);
      let offset = initial.length;
      while (offset < size && current()) {
        if (timedOut()) { this.writeResponse(output, httpError(408, 'Request timeout')); return; }
        const available = this.available(input);
        if (!available) { await this.pause(); continue; }
        lastDataAt = Date.now();
        const chunk = binary.readByteArray(Math.min(available, size - offset, 64 * 1024));
        if (!chunk.length) throw new Error('Closed stream');
        body.set(chunk, offset);
        offset += chunk.length;
      }
      if (!current()) return;
      try { request.body = new TextDecoder('utf-8', { fatal: true }).decode(body); }
      catch { this.writeResponse(output, httpError(400, 'Invalid UTF-8')); return; }
      const response = await this.options.handle(request);
      if (current()) this.writeResponse(output, response);
    } catch {
      if (current() && output) {
        try { this.writeResponse(output, httpError(500, 'HTTP listener failure')); } catch {}
      }
    } finally {
      this.bufferedBytes -= reserved;
      try { output?.close(); } catch {}
      try { input?.close(); } catch {}
      try { transport.close(0); } catch {}
    }
  }

  private available(input: any): number { try { return input.available(); } catch { return 0; } }
  private pause(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 10)); }

  private writeResponse(output: any, response: HttpResponse): void {
    const body = String(response.body ?? '');
    const bodyLength = new TextEncoder().encode(body).length;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...response.headers,
    };
    const lines = [`HTTP/1.1 ${response.status} ${HTTP_REASON[response.status] ?? 'Response'}`];
    for (const [key, value] of Object.entries(headers)) {
      if (/^(content-length|connection)$/i.test(key)) continue;
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n\u0000]/.test(value)) throw new Error('Invalid response header');
      lines.push(`${key}: ${value}`);
    }
    lines.push(`Content-Length: ${bodyLength}`, 'Connection: close', '', '');
    const headerText = lines.join('\r\n');
    output.write(headerText, headerText.length);
    if (bodyLength) {
      const converter = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
      converter.init(output, 'UTF-8', 0, 0);
      converter.writeString(body);
      converter.flush();
    }
    try { output.flush(); } catch {}
  }
}
