/**
 * Dedicated LAN MCP listener. Zotero's Connector listener remains loopback-only.
 * Pattern follows cookjohn/zotero-mcp's nsIServerSocket implementation.
 *
 * HTTP framing operates on bytes (not JS string length) to preserve UTF-8
 * payloads and avoid truncating Chinese text / base64 file submissions.
 */
declare const Cc: any;
declare const Ci: any;
declare const TextDecoder: any;
declare const TextEncoder: any;

export const LAN_MCP_PORT = 23121;
export const LAN_MCP_PATH = '/skilltask/mcp';

type McpResponse = [number, string, string];
export type McpHandler = (
  payload: unknown,
  headers: Record<string, string>
) => Promise<McpResponse>;

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 256 * 1024 * 1024; // 200 MB default deliverable + JSON/base64 overhead
const IDLE_POLLS = 1500; // 15 seconds, reset after each incoming chunk
const HTTP_REASON: Record<number, string> = {
  200: 'OK',
  202: 'Accepted',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  411: 'Length Required',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function findHeaderEnd(bytes: number[]): number {
  for (let i = Math.max(0, bytes.length - 4 - 8192); i + 3 < bytes.length; i++) {
    if (
      bytes[i] === 13 && bytes[i + 1] === 10 &&
      bytes[i + 2] === 13 && bytes[i + 3] === 10
    ) return i;
  }
  return -1;
}

export function parseRequestHeaders(headerText: string): {
  method: string;
  path: string;
  headers: Record<string, string>;
} {
  const lines = headerText.split('\r\n');
  const match = /^(GET|POST) ([^ ]+) HTTP\/1\.[01]$/.exec(lines.shift() ?? '');
  if (!match) throw new Error('Invalid HTTP request line');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('Invalid HTTP header');
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key in headers) throw new Error('Duplicate HTTP header: ' + key);
    headers[key] = line.slice(colon + 1).trim();
  }
  return { method: match[1], path: match[2], headers };
}

export class LanMcpListener {
  private serverSocket: any = null;
  private readonly transports = new Set<any>();
  private running = false;

  constructor(private readonly handleMcp: McpHandler) {}

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.serverSocket) return;
    const socket = Cc['@mozilla.org/network/server-socket;1']
      .createInstance(Ci.nsIServerSocket);
    try {
      // false = all interfaces (0.0.0.0), independent from Zotero Connector.
      socket.init(LAN_MCP_PORT, false, -1);
      socket.asyncListen(this.listener);
      this.serverSocket = socket;
      this.running = true;
    } catch (err) {
      try { socket.close(); } catch {}
      throw err;
    }
  }

  stop(): void {
    this.running = false;
    const socket = this.serverSocket;
    this.serverSocket = null;
    if (socket) {
      try { socket.close(); } catch {}
    }
    for (const transport of this.transports) {
      try { transport.close(0); } catch {}
    }
    this.transports.clear();
  }

  private listener = {
    onSocketAccepted: (_server: any, transport: any) => {
      this.transports.add(transport);
      void this.serve(transport).finally(() => {
        this.transports.delete(transport);
      });
    },
    onStopListening: (_server: any, _status: any) => {
      this.running = false;
      this.serverSocket = null;
    },
  };

  private async serve(transport: any): Promise<void> {
    let input: any = null;
    let output: any = null;
    try {
      input = transport.openInputStream(0, 0, 0);
      output = transport.openOutputStream(0, 0, 0);
      const binary = Cc['@mozilla.org/binaryinputstream;1']
        .createInstance(Ci.nsIBinaryInputStream);
      binary.setInputStream(input);

      // Header buffer is small; body is read separately after Content-Length.
      const headerBytes: number[] = [];
      let headerEnd = -1;
      let idle = 0;
      while (headerEnd < 0) {
        const available = this.available(input);
        if (!available) {
          if (++idle > IDLE_POLLS) return;
          await this.sleep();
          continue;
        }
        idle = 0;
        const chunk = binary.readByteArray(Math.min(available, 4096));
        headerBytes.push(...chunk);
        if (headerBytes.length > MAX_HEADER_BYTES) {
          this.writeResponse(output, 413, 'application/json', '{"error":"Headers too large"}');
          return;
        }
        headerEnd = findHeaderEnd(headerBytes);
      }

      let parsed: ReturnType<typeof parseRequestHeaders>;
      try {
        parsed = parseRequestHeaders(
          new TextDecoder('utf-8').decode(
            new Uint8Array(headerBytes.slice(0, headerEnd))
          )
        );
      } catch {
        this.writeResponse(output, 400, 'application/json', '{"error":"Invalid headers"}');
        return;
      }
      const { method, path, headers } = parsed;
      if (path !== LAN_MCP_PATH) {
        this.writeResponse(output, 404, 'application/json', '{"error":"Not found"}');
        return;
      }
      if (method !== 'POST') {
        this.writeResponse(output, 405, 'application/json', '{"error":"Use POST"}', { Allow: 'POST' });
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '')) {
        this.writeResponse(output, 415, 'application/json', '{"error":"Content-Type must be application/json"}');
        return;
      }
      // Do not accept ambiguous framing or chunked transfer encoding.
      if (headers['transfer-encoding']) {
        this.writeResponse(output, 400, 'application/json', '{"error":"Transfer-Encoding unsupported"}');
        return;
      }
      const lengthValue = headers['content-length'];
      if (lengthValue === undefined) {
        this.writeResponse(output, 411, 'application/json', '{"error":"Content-Length required"}');
        return;
      }
      if (!/^\d+$/.test(lengthValue)) {
        this.writeResponse(output, 400, 'application/json', '{"error":"Invalid Content-Length"}');
        return;
      }
      const size = Number(lengthValue);
      if (!Number.isSafeInteger(size) || size > MAX_BODY_BYTES) {
        this.writeResponse(output, 413, 'application/json', '{"error":"Request too large"}');
        return;
      }
      const initial = headerBytes.slice(headerEnd + 4);
      if (initial.length > size) {
        this.writeResponse(output, 400, 'application/json', '{"error":"Request body overrun"}');
        return;
      }
      const body = new Uint8Array(size);
      body.set(initial);
      let offset = initial.length;
      idle = 0;
      while (offset < size) {
        const available = this.available(input);
        if (!available) {
          if (++idle > IDLE_POLLS) {
            this.writeResponse(output, 400, 'application/json', '{"error":"Request body timeout"}');
            return;
          }
          await this.sleep();
          continue;
        }
        idle = 0;
        const chunk = binary.readByteArray(Math.min(available, size - offset, 64 * 1024));
        if (!chunk.length) throw new Error('Socket closed while reading');
        body.set(chunk, offset);
        offset += chunk.length;
      }

      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder('utf-8').decode(body));
      } catch {
        this.writeResponse(output, 400, 'application/json', '{"error":"Invalid JSON"}');
        return;
      }

      const [status, mimeType, responseBody] = await this.handleMcp(data, headers);
      if (this.running) this.writeResponse(output, status, mimeType, responseBody);
    } catch (err) {
      if (this.running && output) {
        try {
          this.writeResponse(output, 500, 'application/json',
            JSON.stringify({ error: 'MCP listener failure' }));
        } catch {}
      }
    } finally {
      try { output?.close(); } catch {}
      try { input?.close(); } catch {}
      try { transport.close(0); } catch {}
    }
  }

  private available(input: any): number {
    try { return input.available(); } catch { return 0; }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
  }

  private writeResponse(
    output: any, status: number, mimeType: string, body: string,
    extraHeaders: Record<string, string> = {}
  ): void {
    const bodyLength = new TextEncoder().encode(body).length;
    const headers = [
      'HTTP/1.1 ' + status + ' ' + (HTTP_REASON[status] ?? 'Response'),
      'Content-Type: ' + mimeType,
      'Content-Length: ' + bodyLength,
      'Connection: close',
      'Cache-Control: no-store',
      ...Object.entries(extraHeaders).map(([k, v]) => k + ': ' + v),
      '', '',
    ].join('\r\n');
    output.write(headers, headers.length);
    if (bodyLength) {
      const converter = Cc['@mozilla.org/intl/converter-output-stream;1']
        .createInstance(Ci.nsIConverterOutputStream);
      converter.init(output, 'UTF-8', 0, 0);
      converter.writeString(body);
      converter.flush();
    }
    try { output.flush(); } catch {}
  }
}
