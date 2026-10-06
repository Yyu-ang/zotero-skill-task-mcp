/**
 * src/mcpServer.ts — 模块 D：MCP 服务（FR-06 / FR-07 / FR-08 + 需求 §8 安全）
 *
 * 按 docs/TECH_VALIDATION_MCP_HTTP.md 方案 A 实现：
 * 复用 Zotero 进程内 Connector Server，注册端点 /skilltask/mcp，
 * 同一 HTTP 端点双栈支持 MCP 2025-11-25（legacy stateless）与 2026-07-28（modern stateless）；
 * 不提供 SSE/服务端主动消息。
 *
 * 安全（需求 §8）：
 * - 默认启用：pref `extensions.zotero-skill-task.mcp.enabled` 默认为 true；
 *   用户关闭后 handler 层强制返回 503。
 * - Bearer 鉴权：token 存 pref `extensions.zotero-skill-task.mcp.token`，
 *   逐字节常量时间比较，缺失/错误返回 401。日志绝不输出 token。
 * - 只返回技能组配置允许的材料（metadata / abstract / notes / pdf 开关）。
 * - 提交的笔记 HTML 在写入前做清理（按数据处理，不执行脚本）。
 *
 * 客户端注意事项（技术文档 §2.4 / §3）：
 * - MCP 客户端请求不要带 `Origin` 头；
 * - `User-Agent` 不要以 `Mozilla/` 开头；
 * 否则会被 Zotero 内建的 CSRF guard 在到达本端点之前直接丢弃。
 *
 * 技术文档 §3 坑 #2：Zotero 9+ 要求端点 `init` 必须是 async，
 * 同步 init 返回数组会导致请求永远挂起。
 */

import type {
  ClaimResult,
  IMcpServer,
  ISkillGroupStore,
  ITaskStore,
  ITaskGenerator,
  MaterialPackage,
  SkillDeliverable,
  SkillGroup,
  SubmitResult,
  Task,
} from './types';
import { DATA_DIR_NAME } from './types';
import { resolveEarliestPdfPath } from './taskGenerator';
import { prefs, getLeaseMs } from './prefs';
import { LIMITS, error as logError, log, truncateForDisplay } from './utils';
import { traced } from './utils/trace';
import {
  eraseAttachments,
  findChildAttachmentsByFilename,
} from './attachments';
import {
  DELIVERABLES_DIR_NAME,
  base64ToBytes,
  normalizeDeliverable,
  validateSubmitParams,
  type ValidatedSubmission,
} from './deliverables';

// Firefox chrome 特权环境里运行时可用，但 zotero-types 未声明，这里补声明
declare const DOMParser: any;
declare const TextEncoder: any;

/** MCP 端点路径（技术文档 §2.1 方案 A） */
const MCP_PATH = '/skilltask/mcp';
const MCP_HOST = '127.0.0.1';
/** MCP 服务开关（addon/prefs.js 中默认 true） */
const PREF_MCP_ENABLED = 'extensions.zotero-skill-task.mcp.enabled';
/** Bearer token 存储键（由 ensureToken 生成/持久化） */
const PREF_MCP_TOKEN = 'extensions.zotero-skill-task.mcp.token';
/** 访问凭据开关（默认关闭；用户可显式启用） */
const PREF_MCP_TOKEN_ENABLED = 'extensions.zotero-skill-task.mcp.tokenEnabled';
/** 双协议：旧客户端继续 initialize；新客户端按请求携带 2026 envelope。 */
const MCP_LEGACY_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
const MCP_LEGACY_PROTOCOL_VERSION = MCP_LEGACY_PROTOCOL_VERSIONS[0];
/** Streamable HTTP 中缺少版本头时按 2025-03-26 解释（该版本引入此 header）。 */
const MCP_LEGACY_HEADER_DEFAULT_VERSION = '2025-03-26';
const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28';

function supportsStructuredOutput(protocolVersion: string): boolean {
  return (
    protocolVersion === MCP_MODERN_PROTOCOL_VERSION ||
    protocolVersion === '2025-11-25' ||
    protocolVersion === '2025-06-18'
  );
}
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** JSON-RPC 错误码 */
const ERR_PARSE = -32700;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

/** 32 字节随机 hex（token 用） */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 常量时间字符串比较（逐字节异或累加，不提前返回）。
 * 长度不同也逐字节参与比较，避免泄露长度信息。
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length === bb.length ? 0 : 1;
  const maxLen = Math.max(ab.length, bb.length);
  for (let i = 0; i < maxLen; i++) {
    const x = i < ab.length ? ab[i] : 0;
    const y = i < bb.length ? bb[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

/** 从请求头提取 Bearer token（大小写不敏感的 header 键都尝试） */
function extractBearer(headers: any): string {
  if (!headers) return '';
  const raw =
    headers['authorization'] ?? headers['Authorization'] ?? '';
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/** Zotero Server 的 header 容器在不同版本可能是 plain object / Map-like。 */
function getHeader(headers: any, name: string): string {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') {
      const v = headers.get(name);
      if (v !== undefined && v !== null) return String(v);
    }
  } catch {
    // fall through
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const v = headers[key];
      return v === undefined || v === null ? '' : String(v);
    }
  }
  return '';
}

function modernEnvelope(rpc: any): Record<string, unknown> | null {
  const meta = rpc?.params?._meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : null;
}

function negotiateLegacyProtocolVersion(params: any): string {
  const offered: string[] = [];
  if (Array.isArray(params?.protocolVersions)) {
    offered.push(...params.protocolVersions.filter((v: unknown) => typeof v === 'string'));
  }
  if (Array.isArray(params?.supportedProtocolVersions)) {
    offered.push(
      ...params.supportedProtocolVersions.filter((v: unknown) => typeof v === 'string')
    );
  }
  if (typeof params?.protocolVersion === 'string') {
    offered.unshift(params.protocolVersion);
  }
  for (const version of offered) {
    if ((MCP_LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return version;
    }
  }
  return MCP_LEGACY_PROTOCOL_VERSION;
}


/** 取 Zotero 全局对象（Node 测试环境下可能不存在） */
function zoteroGlobal(): any {
  try {
    return (globalThis as any).Zotero ?? undefined;
  } catch {
    return undefined;
  }
}

/** 容错取值：fn 抛错或返回 undefined 时用 fallback */
function tryGet<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 剥 HTML 得纯文本（已有笔记的 text 字段用） */
function stripHtml(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(
      String(html ?? ''),
      'text/html'
    );
    return (doc.body?.textContent ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 清理笔记 HTML（需求 §8 写回安全：AI 返回内容按数据处理，不执行脚本）。
 * - 删除危险元素：script / style / iframe / object / embed / link / meta / base /
 *   form / input / button / select / textarea
 * - 剥除所有 on* 事件属性（大小写不敏感）
 * - 剥除 javascript: 伪协议 URL（href / src / action 等）
 * 返回清理后的 body innerHTML；清理后无可见文本返回空字符串。
 */
function sanitizeNoteHtml(html: unknown): string {
  if (typeof html !== 'string' || !html.trim()) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc || !doc.body) return '';
  const dangerous =
    'script,style,iframe,object,embed,link,meta,base,form,input,button,select,textarea';
  const bad: any[] = Array.from(doc.querySelectorAll(dangerous));
  for (const el of bad) el.remove();
  const els: any[] = Array.from(
    doc.body.getElementsByTagName('*')
  );
  for (const el of els) {
    const attrs = el.attributes;
    for (let i = attrs.length - 1; i >= 0; i--) {
      const name = attrs[i].name as string;
      const value = attrs[i].value as string;
      if (/^on/i.test(name)) {
        el.removeAttribute(name);
        continue;
      }
      if (/^(href|src|action|xlink:href|background)$/i.test(name)) {
        if (/^\s*javascript:/i.test(value)) {
          el.removeAttribute(name);
        }
      }
    }
  }
  const cleaned = (doc.body.innerHTML ?? '').trim();
  // 清理后无可见文本视为无效提交
  if (!cleaned || !stripHtml(cleaned)) return '';
  return cleaned;
}

/** 作者列表格式化为可读字符串 */
function formatCreators(parent: any): string {
  const creators = tryGet(
    () => (parent.getCreators ? parent.getCreators() : []),
    [] as any[]
  );
  const list = Array.isArray(creators) ? creators : [];
  return list
    .map((c: any) =>
      c?.name
        ? String(c.name)
        : [c?.lastName, c?.firstName].filter(Boolean).join(', ')
    )
    .filter(Boolean)
    .join('; ');
}

/** 收集父条目的已有子笔记（标题 + 文本，不含附件） */
function collectChildNotes(
  parent: any
): Array<{ key: string; title: string; text: string }> {
  const Z = zoteroGlobal();
  const ids: number[] = tryGet(
    () => (parent.getNotes ? parent.getNotes() : []),
    [] as number[]
  );
  const out: Array<{ key: string; title: string; text: string }> = [];
  for (const id of ids) {
    try {
      const n = Z.Items.get(id);
      // 防御：条目缺失 / key 非法 / 非笔记一律跳过
      if (!n || n === false) continue;
      if (typeof n.key !== 'string' || !n.key) continue;
      if (n.isNote && !n.isNote()) continue;
      out.push({
        key: n.key,
        title: String(
          tryGet(() => (n.getNoteTitle ? n.getNoteTitle() : ''), '') ?? ''
        ),
        text: stripHtml(
          String(tryGet(() => (n.getNote ? n.getNote() : ''), '') ?? '')
        ),
      });
    } catch {
      // 单条笔记异常跳过，不影响整体材料包
    }
  }
  return out;
}

/** 探测 Connector Server 端口（取不到为 null，绝不写回 pref） */
function detectServerPort(): number | null {
  const Z = zoteroGlobal();
  // 优先读取 Zotero.Server 实际监听端口，而不是只看配置 pref。
  // server.js 暴露的 port getter 返回 HttpServer.identity.primaryPort。
  try {
    const actual = Number(Z?.Server?.port);
    if (Number.isInteger(actual) && actual > 0 && actual <= 65535) {
      return actual;
    }
  } catch {
    // Server 尚未初始化时 port getter 会抛错，继续读配置值。
  }
  try {
    // httpServer.port 是 Zotero 自身 pref，不能传 global=true；
    // 否则会错误读取名为 "httpServer.port" 的绝对 pref。
    const configured = Number(Z?.Prefs?.get?.('httpServer.port'));
    return Number.isInteger(configured) && configured > 0 && configured <= 65535
      ? configured
      : null;
  } catch {
    return null;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** MCP 服务：Zotero.Server 端点 + JSON-RPC 分发 + 领取/提交业务 */
export class McpServer implements IMcpServer {
  private skillGroups: ISkillGroupStore;
  private tasks: ITaskStore;
  private generator: ITaskGenerator;
  private version: string;
  /** 端点是否已注册到 Zotero.Server（注册/注销幂等的依据） */
  private registered = false;

  constructor(deps: {
    skillGroups: ISkillGroupStore;
    tasks: ITaskStore;
    generator: ITaskGenerator;
    version: string;
  }) {
    this.skillGroups = deps.skillGroups;
    this.tasks = deps.tasks;
    this.generator = deps.generator;
    this.version = deps.version;
  }

  // ──────────── IMcpServer ────────────

  /**
   * 注册端点到 Zotero.Server.Endpoints。
   * 幂等：重复调用直接返回，不重复注册。
   */
  register(): void {
    if (this.registered) {
      return;
    }
    const Z = zoteroGlobal();
    if (!Z?.Server?.Endpoints) {
      logError('McpServer.register: Zotero.Server.Endpoints 不可用');
      return;
    }
    const self = this;
    function McpEndpoint(this: any) {
      // 构造器：Zotero 端点注册约定
    }
    McpEndpoint.prototype = {
      supportedMethods: ['POST'],
      supportedDataTypes: ['application/json'],
      permitBookmarklet: false,
      // 技术文档 §3 坑 #2：init 必须是 async，否则请求挂起
      init: async function (requestData: any) {
        return self.handleRequest(requestData);
      },
    };
    Z.Server.Endpoints[MCP_PATH] = McpEndpoint;
    this.registered = true;
    log('MCP endpoint registered:', MCP_PATH);
  }

  /**
   * 注销端点（幂等）。不持有 socket，删除注册即无残留监听。
   */
  unregister(): void {
    this.registered = false;
    try {
      const Z = zoteroGlobal();
      if (Z?.Server?.Endpoints) {
        delete Z.Server.Endpoints[MCP_PATH];
        log('MCP endpoint unregistered:', MCP_PATH);
      }
    } catch {
      // ignore
    }
  }

  isEnabled(): boolean {
    return !!prefs.get(PREF_MCP_ENABLED, true);
  }

  /**
   * 启停 MCP 服务（幂等）：
   * - 启用：写 pref + 注册端点（已注册则跳过，不重复注册）
   * - 停用：写 pref + 注销端点（无残留监听；handler 层的 503 门禁同时保留作纵深防御）
   * 注册/注销失败抛中文错（面板侧展示）。
   */
  setEnabled(v: boolean): void {
    const changed = this.isEnabled() !== v;
    try {
      prefs.set(PREF_MCP_ENABLED, v);
    } catch (e) {
      throw new Error(`MCP 服务开关保存失败：${errMsg(e)}`);
    }
    try {
      if (v) {
        // 默认启用访问凭据时，启服务前确保 token 已经存在。
        if (this.isTokenEnabled()) this.ensureToken();
        this.register();
      } else {
        this.unregister();
      }
    } catch (e) {
      throw new Error(`MCP 服务${v ? '启用' : '停用'}失败：${errMsg(e)}`);
    }
    if (changed) {
      log(`MCP service ${v ? 'enabled' : 'disabled'}`);
    }
  }

  /**
   * 返回现有 token；没有则生成（32 字节随机 hex）并持久化。
   * 持久化失败抛中文错（面板侧展示），不静默返回不可用的 token。
   */
  ensureToken(): string {
    const existing = prefs.get(PREF_MCP_TOKEN, '');
    if (typeof existing === 'string' && existing.length >= 32) {
      return existing;
    }
    const token = randomHex(32);
    try {
      prefs.set(PREF_MCP_TOKEN, token);
    } catch (e) {
      throw new Error(`无法生成访问令牌：偏好存储不可用（${errMsg(e)}）`);
    }
    return token;
  }

  /** 重新生成 token（旧 token 立即失效）；持久化失败抛中文错 */
  regenerateToken(): string {
    const token = randomHex(32);
    try {
      prefs.set(PREF_MCP_TOKEN, token);
    } catch (e) {
      throw new Error(`无法重新生成访问令牌：偏好存储不可用（${errMsg(e)}）`);
    }
    return token;
  }

  /** 访问凭据是否启用（默认关闭） */
  isTokenEnabled(): boolean {
    return !!prefs.get(PREF_MCP_TOKEN_ENABLED, false);
  }

  /** 设置访问凭据开关 */
  setTokenEnabled(v: boolean): void {
    try {
      prefs.set(PREF_MCP_TOKEN_ENABLED, v);
      if (v) this.ensureToken();
    } catch (e) {
      throw new Error(`访问凭据开关保存失败：${errMsg(e)}`);
    }
    log(`MCP token auth ${v ? 'enabled' : 'disabled'}`);
  }

  /**
   * 服务状态：绝不抛错（端口探测失败返回 null，由调用方展示为"未知"）。
   */
  getStatus(): {
    enabled: boolean;
    host: string;
    path: string;
    port: number | null;
    url: string | null;
    lanAccessible: boolean;
  } {
    const port = detectServerPort();
    return {
      enabled: this.isEnabled(),
      host: MCP_HOST,
      path: MCP_PATH,
      port,
      url: port ? `http://${MCP_HOST}:${port}${MCP_PATH}` : null,
      // Zotero Connector Server 是 loopback 服务，并校验 Host 为 localhost/127.0.0.1/::1。
      lanAccessible: false,
    };
  }

  // ──────────── HTTP handler（安全边界强制层） ────────────

  /**
   * 端点请求入口。返回 [HTTP 状态码, Content-Type, 响应体]。
   * 注意：token 只做比较，绝不写入任何日志。
   */
  private async handleRequest(
    requestData: any
  ): Promise<[number, string, string]> {
    // ① 服务开关：用户关闭后在 handler 层强制拒绝
    if (!this.isEnabled()) {
      return [
        503,
        'application/json',
        JSON.stringify({ error: 'mcp-disabled' }),
      ];
    }
    // ② Bearer 鉴权（可选项）：仅在启用访问凭据时校验；关闭时跳过
    if (this.isTokenEnabled()) {
      const expected = String(prefs.get(PREF_MCP_TOKEN, '') ?? '');
      const got = extractBearer(requestData?.headers);
      if (!expected || !timingSafeEqual(got, expected)) {
        return [
          401,
          'application/json',
          JSON.stringify({ error: 'unauthorized' }),
        ];
      }
    }
    // ③ JSON-RPC 解析
    // Zotero.Server 对 application/json 已在进入 endpoint.init() 前执行 JSON.parse，
    // 因此 requestData.data 通常已经是对象；仅对字符串兜底解析。
    let rpc: any;
    try {
      const incoming = requestData?.data;
      if (incoming && typeof incoming === 'object') {
        rpc = incoming;
      } else if (typeof incoming === 'string' && incoming.trim()) {
        rpc = JSON.parse(incoming);
      } else {
        throw new Error('Missing JSON-RPC payload');
      }
    } catch {
      return [
        400,
        'application/json',
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: ERR_PARSE, message: 'Parse error' },
        }),
      ];
    }

    const envelope = modernEnvelope(rpc);
    const headerVersion = getHeader(requestData?.headers, 'MCP-Protocol-Version').trim();
    const envelopeVersion =
      typeof envelope?.[PROTOCOL_VERSION_META_KEY] === 'string'
        ? String(envelope[PROTOCOL_VERSION_META_KEY])
        : '';
    const legacyHeader =
      !headerVersion || /^202[45]-/.test(headerVersion);
    const modernAttempt =
      !!envelopeVersion ||
      (!!headerVersion && !legacyHeader);

    if (modernAttempt) {
      const rejection = this.validateModernRequest(
        rpc,
        requestData?.headers,
        envelope,
        headerVersion,
        envelopeVersion
      );
      if (rejection) return rejection;
    } else if (
      headerVersion &&
      !(MCP_LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion)
    ) {
      return this.jsonErrStatus(
        rpc?.id ?? null,
        400,
        UNSUPPORTED_PROTOCOL_VERSION,
        `Unsupported protocol version: ${headerVersion}`,
        { supportedVersions: [...MCP_LEGACY_PROTOCOL_VERSIONS] }
      );
    }

    const protocolVersion = modernAttempt
      ? MCP_MODERN_PROTOCOL_VERSION
      : headerVersion || MCP_LEGACY_HEADER_DEFAULT_VERSION;
    return this.dispatch(rpc, modernAttempt, protocolVersion);
  }

  /**
   * MCP 2026-07-28 的每请求 envelope/header 校验。
   * Legacy 2025 请求完全不经过这里，保证旧客户端兼容。
   */
  private validateModernRequest(
    rpc: any,
    headers: any,
    envelope: Record<string, unknown> | null,
    headerVersion: string,
    envelopeVersion: string
  ): [number, string, string] | null {
    const id = rpc?.id ?? null;

    if (envelopeVersion && headerVersion && envelopeVersion !== headerVersion) {
      return this.jsonErrStatus(
        id,
        400,
        HEADER_MISMATCH,
        'MCP-Protocol-Version header disagrees with request envelope'
      );
    }
    if (envelopeVersion && envelopeVersion !== MCP_MODERN_PROTOCOL_VERSION) {
      return this.jsonErrStatus(
        id,
        400,
        UNSUPPORTED_PROTOCOL_VERSION,
        `Unsupported protocol version: ${envelopeVersion}`,
        { supportedVersions: [MCP_MODERN_PROTOCOL_VERSION] }
      );
    }
    if (headerVersion && headerVersion !== MCP_MODERN_PROTOCOL_VERSION) {
      return this.jsonErrStatus(
        id,
        400,
        UNSUPPORTED_PROTOCOL_VERSION,
        `Unsupported protocol version: ${headerVersion}`,
        { supportedVersions: [MCP_MODERN_PROTOCOL_VERSION] }
      );
    }
    if (!envelope) {
      return this.jsonErrStatus(
        id,
        400,
        ERR_INVALID_PARAMS,
        'Missing MCP 2026 request envelope in params._meta'
      );
    }
    if (envelopeVersion !== MCP_MODERN_PROTOCOL_VERSION) {
      return this.jsonErrStatus(
        id,
        400,
        ERR_INVALID_PARAMS,
        `Missing ${PROTOCOL_VERSION_META_KEY}`
      );
    }
    const caps = envelope[CLIENT_CAPABILITIES_META_KEY];
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
      return this.jsonErrStatus(
        id,
        400,
        ERR_INVALID_PARAMS,
        `Missing or invalid ${CLIENT_CAPABILITIES_META_KEY}`
      );
    }
    // 2026 通知仍要求合法 envelope，但标准 header 的“必须存在”规则只约束 request。
    if (rpc?.id === undefined || rpc?.id === null) return null;

    if (!headerVersion) {
      return this.jsonErrStatus(
        id,
        400,
        HEADER_MISMATCH,
        'MCP-Protocol-Version header is absent'
      );
    }

    const method = typeof rpc?.method === 'string' ? rpc.method : '';
    const methodHeader = getHeader(headers, 'Mcp-Method').trim();
    if (!methodHeader) {
      return this.jsonErrStatus(id, 400, HEADER_MISMATCH, 'Mcp-Method header is absent');
    }
    if (methodHeader !== method) {
      return this.jsonErrStatus(
        id,
        400,
        HEADER_MISMATCH,
        'Mcp-Method header disagrees with JSON-RPC method'
      );
    }

    if (method === 'tools/call') {
      const bodyName =
        typeof rpc?.params?.name === 'string' ? rpc.params.name : '';
      const nameHeader = getHeader(headers, 'Mcp-Name').trim();
      if (!nameHeader) {
        return this.jsonErrStatus(id, 400, HEADER_MISMATCH, 'Mcp-Name header is absent');
      }
      if (nameHeader !== bodyName) {
        return this.jsonErrStatus(
          id,
          400,
          HEADER_MISMATCH,
          'Mcp-Name header disagrees with params.name'
        );
      }
    }
    return null;
  }

  // ──────────── JSON-RPC 2.0 分发 ────────────

  private async dispatch(
    rpc: any,
    modern: boolean,
    protocolVersion: string
  ): Promise<[number, string, string]> {
    const method = rpc?.method;
    const id = rpc?.id;
    // 无 id 的通知：notifications/initialized → 202 空响应；其他通知忽略
    if (id === undefined || id === null) {
      return [202, 'application/json', ''];
    }
    try {
      switch (method) {
        case 'ping':
          return this.jsonOk(id, {}, modern);
        case 'server/discover':
          if (!modern) {
            return this.jsonErr(
              id,
              ERR_METHOD_NOT_FOUND,
              'Method not found: server/discover'
            );
          }
          return this.jsonOk(
            id,
            {
              ttlMs: 0,
              cacheScope: 'private',
              supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
              capabilities: { tools: {} },
              instructions:
                'Use tools/list, then skilltask_claim / skilltask_renew / skilltask_release / skilltask_status / skilltask_inject_skill / skilltask_submit as needed.',
            },
            true
          );
        case 'initialize':
          if (modern) {
            return this.jsonErrStatus(
              id,
              404,
              ERR_METHOD_NOT_FOUND,
              'Method not found: initialize'
            );
          }
          const negotiatedVersion = negotiateLegacyProtocolVersion(rpc?.params);
          return this.jsonOk(id, {
            protocolVersion: negotiatedVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: 'zotero-skill-task-mcp',
              version: this.version,
            },
          });
        case 'tools/list': {
          const structuredOutput = supportsStructuredOutput(protocolVersion);
          const skillAssetFileSchema = {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              size: { type: 'integer' },
            },
            required: ['name', 'path', 'size'],
          };
          const deliverableSchema = {
            description: '技能组声明的交付物配置。',
            oneOf: [
              {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'note' },
                },
                required: ['type'],
              },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'file' },
                  attachToItem: { type: 'boolean' },
                  allowedExtensions: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  maxBytes: { type: 'integer', minimum: 1 },
                  targetFileName: { type: 'string' },
                  existingAttachmentPolicy: {
                    type: 'string',
                    enum: ['overwrite', 'skip'],
                  },
                },
                required: ['type'],
              },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'markdown' },
                  target: { type: 'string', enum: ['note', 'file'] },
                  attachToItem: { type: 'boolean' },
                  targetFileName: { type: 'string' },
                  existingAttachmentPolicy: {
                    type: 'string',
                    enum: ['overwrite', 'skip'],
                  },
                },
                required: ['type', 'target'],
              },
            ],
          };
          const tools: any[] = [
            {
              name: 'skilltask_claim',
              description:
                '领取下一条待处理任务。返回 task.id、itemKey、leaseExpiresAt、deliverable、' +
                'SKILL.md/references 清单和材料包；每次至多一条。',
              inputSchema: {
                type: 'object',
                properties: {
                  skillGroupId: {
                    type: 'string',
                    description: '可选技能组 ID；省略则从全部可领取任务中选择。',
                  },
                },
              },
              outputSchema: {
                type: 'object',
                properties: {
                  task: {
                    type: ['object', 'null'],
                    properties: {
                      id: { type: 'string' },
                      skillGroupId: { type: 'string' },
                      skillGroupVersion: { type: 'integer' },
                      instruction: { type: 'string' },
                      skillDescription: { type: 'string' },
                      skillAssets: {
                        type: 'object',
                        properties: {
                          skillGroupId: { type: 'string' },
                          skillDir: { type: 'string' },
                          skillFile: {
                            anyOf: [skillAssetFileSchema, { type: 'null' }],
                          },
                          referencesDir: { type: 'string' },
                          references: {
                            type: 'array',
                            items: skillAssetFileSchema,
                          },
                        },
                        required: [
                          'skillGroupId',
                          'skillDir',
                          'skillFile',
                          'referencesDir',
                          'references',
                        ],
                      },
                      referencesDescription: { type: 'string' },
                      itemKey: { type: 'string' },
                      leaseExpiresAt: { type: 'number' },
                      deliverable: deliverableSchema,
                    },
                    required: [
                      'id',
                      'skillGroupId',
                      'skillGroupVersion',
                      'instruction',
                      'skillDescription',
                      'skillAssets',
                      'referencesDescription',
                      'itemKey',
                      'leaseExpiresAt',
                      'deliverable',
                    ],
                  },
                  materials: {
                    type: ['object', 'null'],
                    properties: {
                      itemKey: { type: 'string' },
                      metadata: {
                        type: ['object', 'null'],
                        properties: {
                          title: { type: 'string' },
                          creators: { type: 'string' },
                          date: { type: 'string' },
                          itemType: { type: 'string' },
                        },
                      },
                      abstractNote: { type: ['string', 'null'] },
                      notes: {
                        type: ['array', 'null'],
                        items: {
                          type: 'object',
                          properties: {
                            key: { type: 'string' },
                            title: { type: 'string' },
                            text: { type: 'string' },
                          },
                          required: ['key', 'title', 'text'],
                        },
                      },
                      pdfPath: { type: ['string', 'null'] },
                    },
                    required: [
                      'itemKey',
                      'metadata',
                      'abstractNote',
                      'notes',
                      'pdfPath',
                    ],
                  },
                  message: { type: 'string' },
                },
                required: ['task', 'materials'],
              },
            },
            {
              name: 'skilltask_renew',
              description:
                '给已领取且仍有效的任务续租一个完整 lease 周期。每次从当前过期时间向后延长。',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: '领取时返回的 task.id。' },
                },
                required: ['taskId'],
              },
              outputSchema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  taskId: { type: 'string' },
                  leaseExpiresAt: { type: 'number' },
                  error: { type: 'string' },
                },
                required: ['ok'],
              },
            },
            {
              name: 'skilltask_release',
              description:
                '主动归还当前已领取任务，使其立即回到 pending，供其他 agent 重新领取。',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: '领取时返回的 task.id。' },
                },
                required: ['taskId'],
              },
              outputSchema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  taskId: { type: 'string' },
                  status: { type: 'string' },
                  error: { type: 'string' },
                },
                required: ['ok'],
              },
            },
            {
              name: 'skilltask_status',
              description:
                '只读查看任务队列状态，可按 skillGroupId 过滤；返回状态计数及当前 claimed 租约。',
              inputSchema: {
                type: 'object',
                properties: {
                  skillGroupId: { type: 'string' },
                },
              },
              outputSchema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  total: { type: 'integer' },
                  counts: {
                    type: 'object',
                    properties: {
                      'waiting-material': { type: 'integer' },
                      pending: { type: 'integer' },
                      claimed: { type: 'integer' },
                      done: { type: 'integer' },
                      failed: { type: 'integer' },
                      cancelled: { type: 'integer' },
                    },
                    required: [
                      'waiting-material',
                      'pending',
                      'claimed',
                      'done',
                      'failed',
                      'cancelled',
                    ],
                  },
                  claimed: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        skillGroupId: { type: 'string' },
                        itemKey: { type: 'string' },
                        leaseExpiresAt: { type: ['number', 'null'] },
                      },
                      required: ['id', 'skillGroupId', 'itemKey', 'leaseExpiresAt'],
                    },
                  },
                  skillGroups: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        enabled: { type: 'boolean' },
                        archived: { type: 'boolean' },
                        total: { type: 'integer' },
                        counts: { type: 'object' },
                      },
                      required: [
                        'id',
                        'name',
                        'enabled',
                        'archived',
                        'total',
                        'counts',
                      ],
                    },
                  },
                  error: { type: 'string' },
                },
                required: ['ok'],
              },
            },
            {
              name: 'skilltask_inject_skill',
              description:
                '向 Zotero Skill Task 注入一个新的技能组（任务模板）。' +
                '技能组创建后默认启用；可配置作用范围、输入材料和交付物。' +
                'scanNow=true 时创建后立即扫描现有文库生成任务。',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '技能组名称。' },
                  description: { type: 'string', description: '技能说明/用途说明。' },
                  instruction: { type: 'string', description: '发给 AI 的任务级指令。' },
                  skillMarkdown: {
                    type: 'string',
                    description: 'SKILL.md 的完整 Markdown 内容。',
                  },
                  referencesEnabled: { type: 'boolean' },
                  referencesDescription: { type: 'string' },
                  referenceFiles: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        fileName: { type: 'string' },
                        contentBase64: { type: 'string' },
                      },
                      required: ['fileName', 'contentBase64'],
                    },
                  },
                  scope: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['all', 'collections'] },
                      collectionKeys: { type: 'array', items: { type: 'string' } },
                      includeSubcollections: { type: 'boolean' },
                    },
                  },
                  materials: {
                    type: 'object',
                    properties: {
                      includeMetadata: { type: 'boolean' },
                      includeAbstract: { type: 'boolean' },
                      includeNotes: { type: 'boolean' },
                      pdf: { type: 'string', enum: ['earliest', 'none'] },
                    },
                  },
                  deliverable: deliverableSchema,
                  scanNow: { type: 'boolean' },
                },
                required: ['name', 'instruction'],
              },
              outputSchema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  skillGroup: { type: 'object' },
                  assets: { type: 'object' },
                  scan: {},
                  error: { type: 'string' },
                },
                required: ['ok'],
              },
            },
            {
              name: 'skilltask_submit',
              description:
                '提交任务结果。默认对 done 保持幂等；若确需更正已完成交付物，显式传 revise=true。' +
                'note 使用 noteHtml；markdown 使用 markdown；file 使用 contentBase64。',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: '领取时返回的任务 ID。' },
                  revise: {
                    type: 'boolean',
                    description:
                      '仅用于更正已完成任务；true 时覆盖既有交付物并记录 revised=true。',
                  },
                  noteHtml: { type: 'string' },
                  markdown: { type: 'string' },
                  fileName: { type: 'string' },
                  contentBase64: { type: 'string' },
                },
                required: ['taskId'],
              },
              outputSchema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  noteKey: { type: 'string' },
                  fileName: { type: 'string' },
                  attachmentKey: { type: 'string' },
                  deliverableType: {
                    type: 'string',
                    enum: ['note', 'file', 'markdown'],
                  },
                  duplicate: { type: 'boolean' },
                  revised: { type: 'boolean' },
                  submissionCount: { type: 'integer' },
                  error: { type: 'string' },
                },
                required: ['ok'],
              },
            },
          ];
          if (!structuredOutput) {
            for (const tool of tools) delete tool.outputSchema;
          }
          return this.jsonOk(
            id,
            {
              tools,
              ...(modern ? { ttlMs: 0, cacheScope: 'private' } : {}),
            },
            modern
          );
        }
        case 'tools/call': {
          const name = rpc?.params?.name;
          const args = rpc?.params?.arguments ?? {};
          if (name === 'skilltask_claim') {
            const result = await this.claim(args);
            return this.toolOk(id, result, modern, protocolVersion);
          }
          if (name === 'skilltask_renew') {
            const result = await this.renew(args);
            return this.toolOk(id, result, modern, protocolVersion);
          }
          if (name === 'skilltask_release') {
            const result = await this.release(args);
            return this.toolOk(id, result, modern, protocolVersion);
          }
          if (name === 'skilltask_status') {
            const result = await this.status(args);
            return this.toolOk(id, result, modern, protocolVersion);
          }
          if (name === 'skilltask_inject_skill') {
            const result = await this.injectSkill(args);
            return this.toolOk(id, result, modern, protocolVersion);
          }
          if (name === 'skilltask_submit') {
            const result = await this.submit(args);
            return this.toolOk(id, result, modern, protocolVersion);
          }
          return this.jsonErr(
            id,
            ERR_INVALID_PARAMS,
            `unknown tool: ${String(name)}`
          );
        }
        default:
          return modern
            ? this.jsonErrStatus(
                id,
                404,
                ERR_METHOD_NOT_FOUND,
                `Method not found: ${String(method)}`
              )
            : this.jsonErr(
                id,
                ERR_METHOD_NOT_FOUND,
                `Method not found: ${String(method)}`
              );
      }
    } catch (e) {
      return this.jsonErr(id, ERR_INTERNAL, `Internal error: ${errMsg(e)}`);
    }
  }

  private serverInfoMeta(): Record<string, unknown> {
    return {
      [SERVER_INFO_META_KEY]: {
        name: 'zotero-skill-task-mcp',
        version: this.version,
      },
    };
  }

  private jsonOk(
    id: unknown,
    result: unknown,
    modern = false
  ): [number, string, string] {
    let wireResult = result;
    if (modern) {
      const base =
        result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { value: result };
      wireResult = {
        ...base,
        resultType: 'complete',
        _meta: {
          ...(base._meta && typeof base._meta === 'object'
            ? (base._meta as Record<string, unknown>)
            : {}),
          ...this.serverInfoMeta(),
        },
      };
    }
    return [
      200,
      'application/json',
      JSON.stringify({ jsonrpc: '2.0', id, result: wireResult }),
    ];
  }

  private jsonErr(
    id: unknown,
    code: number,
    message: string
  ): [number, string, string] {
    return this.jsonErrStatus(id, 200, code, message);
  }

  private jsonErrStatus(
    id: unknown,
    status: number,
    code: number,
    message: string,
    data?: unknown
  ): [number, string, string] {
    return [
      status,
      'application/json',
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code,
          message,
          ...(data === undefined ? {} : { data }),
        },
      }),
    ];
  }

  /**
   * tools/call 成功响应：
   * - 所有版本都保留 content[].text，兼容只读文本的客户端；
   * - 2025-06-18 / 2025-11-25 / 2026-07-28 同时返回 structuredContent；
   * - 2025-03-26 / 2024-11-05 不声明 outputSchema，也不返回 structuredContent。
   */
  private toolOk(
    id: unknown,
    result: unknown,
    modern: boolean,
    protocolVersion: string
  ): [number, string, string] {
    return this.jsonOk(
      id,
      {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        ...(supportsStructuredOutput(protocolVersion)
          ? { structuredContent: result }
          : {}),
      },
      modern
    );
  }

  // ──────────── agent queue control ────────────

  private async renew(params: any): Promise<Record<string, unknown>> {
    const taskId =
      typeof params?.taskId === 'string' ? params.taskId.trim() : '';
    if (!taskId) return { ok: false, error: 'missing-taskId' };
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'task-not-found' };
    if (task.status !== 'claimed') {
      return { ok: false, error: `task-not-claimed:${task.status}` };
    }
    try {
      const renewed = await this.tasks.renewLease(taskId, getLeaseMs());
      return {
        ok: true,
        taskId,
        leaseExpiresAt: renewed.leaseExpiresAt,
      };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  private async release(params: any): Promise<Record<string, unknown>> {
    const taskId =
      typeof params?.taskId === 'string' ? params.taskId.trim() : '';
    if (!taskId) return { ok: false, error: 'missing-taskId' };
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'task-not-found' };
    if (task.status !== 'claimed') {
      return { ok: false, error: `task-not-claimed:${task.status}` };
    }
    try {
      const released = await this.tasks.releaseLease(taskId);
      return { ok: true, taskId, status: released.status };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  private async status(params: any): Promise<Record<string, unknown>> {
    const skillGroupId =
      typeof params?.skillGroupId === 'string' && params.skillGroupId.trim()
        ? params.skillGroupId.trim()
        : undefined;
    if (skillGroupId && !this.skillGroups.get(skillGroupId)) {
      return { ok: false, error: 'skill-group-not-found' };
    }
    try {
      await this.tasks.releaseExpiredLeases();
    } catch {
      // 状态读取仍可基于当前内存快照返回。
    }
    const tasks = this.tasks.list(
      skillGroupId ? { skillGroupId } : undefined
    );
    const blankCounts = () => ({
      'waiting-material': 0,
      pending: 0,
      claimed: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    });
    const counts = blankCounts();
    for (const task of tasks) {
      counts[task.status] += 1;
    }
    const claimed = tasks
      .filter((task) => task.status === 'claimed')
      .map((task) => ({
        id: task.id,
        skillGroupId: task.skillGroupId,
        itemKey: task.itemKey,
        leaseExpiresAt: task.leaseExpiresAt,
      }));
    const groups = this.skillGroups
      .list(true)
      .filter((group) => !skillGroupId || group.id === skillGroupId)
      .map((group) => {
        const groupTasks = tasks.filter(
          (task) => task.skillGroupId === group.id
        );
        const groupCounts = blankCounts();
        for (const task of groupTasks) {
          groupCounts[task.status] += 1;
        }
        return {
          id: group.id,
          name: group.name,
          enabled: group.enabled,
          archived: group.archived,
          total: groupTasks.length,
          counts: groupCounts,
        };
      });
    return {
      ok: true,
      total: tasks.length,
      counts,
      claimed,
      skillGroups: groups,
    };
  }

  // ──────────── skill injection ────────────

  /**
   * 由 MCP 客户端向程序注入新的技能组。
   * 不接受调用方指定 id/version/归档状态，避免绕过 SkillGroupStore 的约束。
   */
  private async injectSkill(params: any): Promise<{
    ok: boolean;
    skillGroup?: SkillGroup;
    assets?: Awaited<ReturnType<ISkillGroupStore['getAssetManifest']>>;
    scan?: unknown;
    error?: string;
  }> {
    try {
      const name = typeof params?.name === 'string' ? params.name.trim() : '';
      const instruction =
        typeof params?.instruction === 'string' ? params.instruction.trim() : '';
      if (!name) return { ok: false, error: 'missing-name' };
      if (!instruction) return { ok: false, error: 'missing-instruction' };

      const rawScope = params?.scope;
      const scope =
        rawScope?.type === 'collections'
          ? {
              type: 'collections' as const,
              collectionKeys: Array.isArray(rawScope.collectionKeys)
                ? rawScope.collectionKeys
                    .filter((v: unknown): v is string => typeof v === 'string')
                    .map((v: string) => v.trim())
                    .filter(Boolean)
                : [],
              includeSubcollections: rawScope.includeSubcollections !== false,
            }
          : {
              type: 'all' as const,
              collectionKeys: [],
              includeSubcollections: true,
            };

      const rawMaterials = params?.materials ?? {};
      const materials = {
        includeMetadata: rawMaterials.includeMetadata !== false,
        includeAbstract: rawMaterials.includeAbstract !== false,
        includeNotes: rawMaterials.includeNotes === true,
        pdf: rawMaterials.pdf === 'earliest' ? ('earliest' as const) : ('none' as const),
      };

      const deliverable: SkillDeliverable =
        params?.deliverable && typeof params.deliverable === 'object'
          ? (params.deliverable as SkillDeliverable)
          : { type: 'note' };

      const skillGroup = await this.skillGroups.create({
        name,
        description:
          typeof params?.description === 'string' ? params.description : '',
        instruction,
        referencesEnabled: params?.referencesEnabled === true,
        referencesDescription:
          typeof params?.referencesDescription === 'string'
            ? params.referencesDescription
            : '',
        scope,
        materials,
        deliverable,
      });

      if (
        typeof params?.skillMarkdown === 'string' &&
        params.skillMarkdown.trim()
      ) {
        await this.skillGroups.writeSkillFile(
          skillGroup.id,
          new TextEncoder().encode(params.skillMarkdown)
        );
      }

      if (
        params?.referencesEnabled === true &&
        Array.isArray(params?.referenceFiles) &&
        params.referenceFiles.length
      ) {
        const uploads = params.referenceFiles.map((file: any) => ({
          name: String(file?.fileName ?? ''),
          bytes: base64ToBytes(String(file?.contentBase64 ?? '')),
        }));
        await this.skillGroups.writeReferenceFiles(skillGroup.id, uploads);
      }

      const assets = await this.skillGroups.getAssetManifest(skillGroup.id);

      let scan: unknown = undefined;
      if (params?.scanNow === true) {
        scan = await this.generator.scanSkillGroup(skillGroup.id);
      }

      return { ok: true, skillGroup, assets, scan };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  // ──────────── claim（FR-06 / FR-07） ────────────

  /**
   * 领取：被动、按请求触发，每次至多一条（FR-06）。
   * 需求 §6：技能组停用/归档后暂停领取——显式指定的停用技能组直接返回明确结果；
   * 全局领取时只从"启用未归档"技能组的待领取任务里按创建时间取最早，
   * 停用组的任务连碰都不碰（不领取、不标记失败）。
   *
   * 并发说明：先释放过期租约 → 取 pending 快照 → 逐条 claimById。
   * claimById 只对仍为 pending 的任务加 claimed 标记，被并发抢走返回 null
   * 继续试下一条；快照之后新建的任务本轮可能 miss，客户端下次轮询即得。
   */
  @traced
  private async claim(params: any): Promise<ClaimResult> {
    const skillGroupId: string | undefined =
      typeof params?.skillGroupId === 'string' && params.skillGroupId
        ? params.skillGroupId
        : undefined;

    // 显式指定技能组时先做资格预检，给出明确结果而非空队列
    if (skillGroupId !== undefined) {
      const specified = this.skillGroups.get(skillGroupId);
      if (!specified) {
        return { task: null, materials: null, message: 'skill-group-not-found' };
      }
      if (specified.archived || !specified.enabled) {
        return { task: null, materials: null, message: 'skill-group-disabled' };
      }
    }

    try {
      await this.tasks.releaseExpiredLeases();
    } catch {
      // 释放失败不阻塞领取（下次定时/领取时再试）
    }
    const eligible = new Set(
      this.skillGroups
        .list(true)
        .filter((s) => s.enabled && !s.archived)
        .map((s) => s.id)
    );
    const pendings = this.tasks
      .list({ status: 'pending', skillGroupId })
      .filter((t) => eligible.has(t.skillGroupId))
      // 最早创建优先；时间相同按 id 稳定排序
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

    for (const p of pendings) {
      const task = await this.claimTaskById(p.id);
      if (!task) {
        continue; // 并发下已被其他领取者拿走，试下一条
      }
      const sg = this.skillGroups.get(task.skillGroupId);
      if (!sg) {
        // 技能组被硬删除：任务成孤儿，标记失败使其在界面可见（不静默丢弃）
        await this.tasks
          .fail(task.id, '技能组不存在，任务无法执行')
          .catch(() => undefined);
        continue;
      }
      if (sg.archived || !sg.enabled) {
        // 领取瞬间被停用/归档：放回待领取（不记为失败），继续找下一条
        await this.requeueTask(task.id);
        continue;
      }
      const materials = await this.buildMaterialPackage(sg, task.itemKey);
      const skillAssets = await this.skillGroups.getAssetManifest(sg.id);
      if (sg.referencesEnabled !== true) {
        skillAssets.references = [];
      }
      return {
        task: {
          id: task.id,
          skillGroupId: task.skillGroupId,
          skillGroupVersion: task.skillGroupVersion,
          instruction: task.instructionSnapshot,
          skillDescription: sg.description ?? '',
          skillAssets,
          referencesDescription:
            sg.referencesEnabled === true ? sg.referencesDescription ?? '' : '',
          itemKey: task.itemKey,
          leaseExpiresAt: task.leaseExpiresAt ?? Date.now() + getLeaseMs(),
          // FR-07：领取结果携带交付物 schema，提交时须按此格式
          deliverable: normalizeDeliverable(sg.deliverable),
        },
        materials,
      };
    }
    // FR-06：无任务时返回明确的空队列结果
    return { task: null, materials: null, message: 'empty-queue' };
  }

  /**
   * TaskStore 的内部扩展方法（requeue / claimById 不在 ITaskStore 接口内），
   * 这里做结构化调用，避免 mcpServer → taskStore 的类级导入依赖。
   */
  private taskStoreInternal(): {
    requeue?: (taskId: string) => Promise<unknown>;
    claimById?: (taskId: string, leaseMs: number) => Promise<unknown>;
  } {
    return this.tasks as unknown as {
      requeue?: (taskId: string) => Promise<unknown>;
      claimById?: (taskId: string, leaseMs: number) => Promise<unknown>;
    };
  }

  /** 按 id 领取（内部 claimById 的结构化调用；不支持时记日志不断言） */
  private async claimTaskById(id: string): Promise<any | null> {
    const store = this.taskStoreInternal();
    if (typeof store.claimById !== 'function') {
      logError('McpServer: 任务存储不支持 claimById，无法领取');
      return null;
    }
    // 注意：必须以 store.claimById(...) 形式调用，保持 this 指向 store
    return (await store.claimById(id, getLeaseMs())) as any | null;
  }

  /**
   * 把已领取任务放回待领取（技能组停用竞态用）。
   */
  private async requeueTask(id: string): Promise<void> {
    const store = this.taskStoreInternal();
    if (typeof store.requeue === 'function') {
      // 同上：保持 this 指向 store
      await store.requeue(id);
    } else {
      logError(
        'McpServer: 任务存储不支持 requeue，任务可能被租约卡住:',
        truncateForDisplay(id)
      );
    }
  }

  /**
   * 按技能组 materials 配置组装材料包（FR-07：只给允许的材料）。
   * 父条目已不存在时返回空材料包（不抛错，避免领取后无业务结果）。
   */
  private async buildMaterialPackage(
    sg: SkillGroup,
    itemKey: string
  ): Promise<MaterialPackage> {
    const parent = await this.resolveParentItem(itemKey);
    const pkg: MaterialPackage = {
      itemKey,
      metadata: null,
      abstractNote: null,
      notes: null,
      pdfPath: null,
    };
    if (!parent) return pkg;
    // 防御：持久化数据损坏导致 materials 缺失时按"无材料"处理，不抛错
    const mat: SkillGroup['materials'] = sg.materials ?? ({} as SkillGroup['materials']);
    if (mat.includeMetadata) {
      pkg.metadata = {
        title: tryGet(() => parent.getDisplayTitle(), '') || undefined,
        creators: formatCreators(parent) || undefined,
        date: tryGet(() => parent.getField('date'), '') || undefined,
        itemType: tryGet(() => parent.itemType, '') || undefined,
      };
    }
    if (mat.includeAbstract) {
      const abs = tryGet(() => parent.getField('abstractNote'), '');
      pkg.abstractNote = abs ? String(abs) : null;
    }
    if (mat.includeNotes) {
      pkg.notes = collectChildNotes(parent);
    }
    if (mat.pdf === 'earliest') {
      pkg.pdfPath = await resolveEarliestPdfPath(parent);
    }
    return pkg;
  }

  /**
   * 按 itemKey 查找父条目（守卫：遍历全部文库）。
   * 用 Zotero.Items.getByLibraryAndKey（zotero-types 已核对签名）；
   * 找不到、非父条目或异常时返回 null，调用方按缺失处理。
   */
  private async resolveParentItem(itemKey: string): Promise<any | null> {
    try {
      const Z = zoteroGlobal();
      if (!Z?.Items?.getByLibraryAndKey || !Z?.Libraries?.getAll) {
        return null;
      }
      const libs = Z.Libraries.getAll() as Array<{ libraryID: number }>;
      for (const lib of libs) {
        const item = Z.Items.getByLibraryAndKey(lib.libraryID, itemKey);
        if (item && item !== false && item.isRegularItem?.()) {
          return item;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // ──────────── submit（FR-08） ────────────

  /**
   * 提交结果（FR-08）：
   * - 校验 taskId 存在、任务处于 claimed 状态、租约未过期
   * - 按技能组声明的交付物 schema 校验提交参数：
   *   note → noteHtml（清理后为空则拒绝）；
   *   markdown → markdown 文本（target=note 转 HTML 写笔记，target=file 存 .md）；
   *   file → fileName + contentBase64（写受控输出目录，可选挂附件）
   * - 成功后 tasks.complete 标记完成并记录交付物引用；写回抛错 → tasks.fail
   *   保留未完成可重试
   * - 已完成 + 有交付物引用 → 幂等返回，不产生第二个交付物
   */
  @traced
  private async submit(params: any): Promise<SubmitResult> {
    const taskId =
      typeof params?.taskId === 'string' ? params.taskId.trim() : '';
    if (!taskId) {
      return { ok: false, error: 'missing-taskId' };
    }
    const task = this.tasks.get(taskId);
    if (!task) {
      return { ok: false, error: 'task-not-found' };
    }

    const revise = params?.revise === true;
    const isRevision = task.status === 'done' && revise;

    // 默认保持既有幂等语义；只有显式 revise=true 才允许更正 done。
    if (task.status === 'done' && !isRevision && task.deliverableRef) {
      return this.duplicateResult(task);
    }
    if (task.status === 'done' && !isRevision && task.noteKey) {
      return {
        ok: true,
        noteKey: task.noteKey,
        deliverableType: 'note',
        duplicate: true,
        submissionCount: Math.max(1, task.submissionCount || 1),
      };
    }

    if (!isRevision) {
      if (task.status !== 'claimed') {
        return { ok: false, error: `task-not-claimed:${task.status}` };
      }
      if (
        task.leaseExpiresAt !== null &&
        task.leaseExpiresAt <= Date.now()
      ) {
        try {
          await this.tasks.releaseExpiredLeases();
        } catch {
          // ignore
        }
        return { ok: false, error: 'lease-expired' };
      }
    }

    const sg = this.skillGroups.get(task.skillGroupId);
    if (!sg) {
      if (!isRevision) {
        await this.tasks
          .fail(task.id, '技能组不存在，任务无法提交')
          .catch(() => undefined);
      }
      return { ok: false, error: 'skill-group-missing' };
    }

    const deliverable = normalizeDeliverable(sg.deliverable);
    const validated = validateSubmitParams(deliverable, params, task.id);
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }

    const parent = await this.resolveParentItem(task.itemKey);
    if (!parent) {
      if (!isRevision) {
        await this.tasks
          .fail(task.id, 'parent-item-missing')
          .catch(() => undefined);
      }
      return { ok: false, error: 'parent-item-missing' };
    }

    switch (validated.kind) {
      case 'note':
        return this.submitNote(
          task,
          parent,
          validated.html,
          'note',
          isRevision
        );
      case 'markdown-note':
        return this.submitNote(
          task,
          parent,
          validated.html,
          'markdown',
          isRevision
        );
      case 'file':
        return this.submitFile(
          task,
          parent,
          deliverable,
          validated.fileName,
          validated.bytes,
          isRevision
        );
      case 'markdown-file':
        return this.submitFile(
          task,
          parent,
          deliverable,
          validated.fileName,
          new TextEncoder().encode(validated.text),
          isRevision
        );
    }
  }

  /** 幂等命中时按任务记录重建提交结果 */
  private duplicateResult(task: Task): SubmitResult {
    const dtype = task.deliverableType ?? 'note';
    const res: SubmitResult = {
      ok: true,
      duplicate: true,
      deliverableType: dtype,
      submissionCount: Math.max(1, task.submissionCount || 1),
    };
    if (task.noteKey) {
      res.noteKey = task.noteKey;
    }
    // 文件类交付物：deliverableRef 为相对受控目录的文件名
    if (
      (dtype === 'file' ||
        (dtype === 'markdown' && !task.noteKey)) &&
      task.deliverableRef
    ) {
      res.fileName = task.deliverableRef;
    }
    if (task.attachmentKey) {
      res.attachmentKey = task.attachmentKey;
    }
    return res;
  }

  /** 写内建笔记（note / markdown→note 共用）；revision 时优先原位更新既有笔记。 */
  private async submitNote(
    task: Task,
    parent: any,
    html: string,
    dtype: 'note' | 'markdown',
    revision = false
  ): Promise<SubmitResult> {
    const clean = sanitizeNoteHtml(html);
    if (!clean) {
      return { ok: false, error: 'empty-note-after-sanitize' };
    }
    try {
      let noteKey: string;
      if (revision && task.noteKey) {
        const existingNote = this.resolveItemByKey(task.noteKey);
        if (existingNote && existingNote.isNote?.()) {
          existingNote.setNote(clean);
          await existingNote.saveTx();
          noteKey = task.noteKey;
        } else {
          noteKey = await this.createChildNote(parent, clean);
        }
      } else {
        noteKey = await this.createChildNote(parent, clean);
      }

      const saved = revision
        ? await this.tasks.reviseComplete(task.id, {
            noteKey,
            deliverableType: dtype,
            deliverableRef: noteKey,
          })
        : await this.tasks.complete(task.id, {
            noteKey,
            deliverableType: dtype,
            deliverableRef: noteKey,
          });
      log(
        revision ? 'revise ok:' : 'submit ok:',
        task.id,
        `-> note(${dtype})`,
        noteKey
      );
      return {
        ok: true,
        noteKey,
        deliverableType: dtype,
        ...(revision ? { revised: true } : {}),
        submissionCount: saved.submissionCount,
      };
    } catch (e) {
      return this.failSubmit(task, e, revision ? 'note-revise' : 'note');
    }
  }

  /** 在全部文库中按 key 找条目；用于 revision 原位更新历史笔记/附件。 */
  private resolveItemByKey(itemKey: string): any | null {
    try {
      const Z = zoteroGlobal();
      if (!Z?.Items?.getByLibraryAndKey || !Z?.Libraries?.getAll) return null;
      const libs = Z.Libraries.getAll() as Array<{ libraryID: number }>;
      for (const lib of libs) {
        const item = Z.Items.getByLibraryAndKey(lib.libraryID, itemKey);
        if (item && item !== false) return item;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 在父条目下创建内建笔记，返回笔记 key */
  private async createChildNote(parent: any, html: string): Promise<string> {
    const Z = zoteroGlobal();
    const note = new Z.Item('note');
    note.parentID = parent.id;
    note.setNote(html);
    await note.saveTx();
    const noteKey: string = note.key;
    if (!noteKey) {
      throw new Error('note-key-missing');
    }
    return noteKey;
  }

  /**
   * 写文件交付物：存入受控输出目录。
   * revision 时显式覆盖现有交付物，并在可行时直接覆盖既有附件文件以保留 attachmentKey。
   */
  private async submitFile(
    task: Task,
    parent: any,
    deliverable: SkillDeliverable,
    fileName: string,
    bytes: Uint8Array,
    revision = false
  ): Promise<SubmitResult> {
    const dtype = deliverable.type === 'markdown' ? 'markdown' : 'file';
    const attach =
      deliverable.type === 'file'
        ? !!deliverable.attachToItem
        : deliverable.type === 'markdown' &&
          deliverable.target === 'file' &&
          !!deliverable.attachToItem;
    const policy =
      deliverable.type === 'file'
        ? deliverable.existingAttachmentPolicy ?? 'skip'
        : deliverable.type === 'markdown' && deliverable.target === 'file'
          ? deliverable.existingAttachmentPolicy ?? 'skip'
          : 'skip';

    try {
      const existing = attach
        ? await findChildAttachmentsByFilename(parent, fileName)
        : [];

      // 普通 submit 保持原 skip 语义；显式 revision 必须真正覆盖，不被 skip 截断。
      if (!revision && attach && existing.length && policy === 'skip') {
        const existingKey =
          typeof existing[0]?.key === 'string' ? existing[0].key : null;
        const saved = await this.tasks.complete(task.id, {
          noteKey: null,
          deliverableType: dtype,
          deliverableRef: fileName,
          attachmentKey: existingKey,
        });
        return {
          ok: true,
          fileName,
          attachmentKey: existingKey ?? undefined,
          deliverableType: dtype,
          duplicate: true,
          submissionCount: saved.submissionCount,
        };
      }

      const { dir, dest, rel } = this.deliverablePaths(task.id, fileName);
      await this.writeBytes(dir, dest, bytes);
      log(
        revision ? 'revise file saved:' : 'submit file saved:',
        task.id,
        rel,
        `${bytes.length} bytes`
      );

      let attachmentKey: string | null = null;
      if (attach) {
        // revision 优先覆写任务记录中的原附件，保持 attachmentKey 稳定。
        if (revision && task.attachmentKey) {
          const replaced = await this.replaceAttachmentBytes(
            task.attachmentKey,
            bytes
          );
          if (replaced) {
            attachmentKey = task.attachmentKey;
          }
        }

        // 原附件不存在/不可写时退化为重新导入，再删除旧同名附件。
        if (!attachmentKey) {
          attachmentKey = await this.attachFileToParent(parent, dest);
        }

        if (
          revision ||
          (existing.length && policy === 'overwrite')
        ) {
          await eraseAttachments(
            existing.filter((att: any) => att?.key !== attachmentKey)
          );
        }
      }

      const saved = revision
        ? await this.tasks.reviseComplete(task.id, {
            noteKey: null,
            deliverableType: dtype,
            deliverableRef: rel,
            attachmentKey,
          })
        : await this.tasks.complete(task.id, {
            noteKey: null,
            deliverableType: dtype,
            deliverableRef: rel,
            attachmentKey,
          });

      log(
        revision ? 'revise ok:' : 'submit ok:',
        task.id,
        `-> file(${dtype})`,
        rel
      );
      const res: SubmitResult = {
        ok: true,
        fileName: rel,
        deliverableType: dtype,
        ...(revision ? { revised: true } : {}),
        submissionCount: saved.submissionCount,
      };
      if (attachmentKey) {
        res.attachmentKey = attachmentKey;
      }
      return res;
    } catch (e) {
      return this.failSubmit(task, e, revision ? 'file-revise' : 'file');
    }
  }

  /** revision 时直接覆盖已挂附件的底层文件；成功返回 true。 */
  private async replaceAttachmentBytes(
    attachmentKey: string,
    bytes: Uint8Array
  ): Promise<boolean> {
    try {
      const attachment = this.resolveItemByKey(attachmentKey);
      if (!attachment || !attachment.isAttachment?.()) return false;
      let absPath = '';
      if (typeof attachment.getFilePathAsync === 'function') {
        absPath = String((await attachment.getFilePathAsync()) ?? '');
      } else if (typeof attachment.getFilePath === 'function') {
        absPath = String(attachment.getFilePath() ?? '');
      }
      if (!absPath) return false;
      const g = globalThis as any;
      if (typeof g.IOUtils?.write !== 'function') return false;
      await g.IOUtils.write(absPath, bytes);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 计算交付物文件的落盘路径。
   * fileName 已在 validateSubmitParams 中消毒（无路径分隔符），
   * 这里再做一次分隔符断言做纵深防御。
   */
  private deliverablePaths(
    taskId: string,
    fileName: string
  ): { dir: string; dest: string; rel: string } {
    if (fileName.includes('/') || fileName.includes('\\')) {
      throw new Error('invalid-file-path');
    }
    const Z = zoteroGlobal();
    const g = globalThis as any;
    const base = g.PathUtils.join(
      Z.DataDirectory.dir,
      DATA_DIR_NAME,
      DELIVERABLES_DIR_NAME
    );
    const dir = g.PathUtils.join(base, taskId);
    return {
      dir,
      dest: g.PathUtils.join(dir, fileName),
      rel: `${taskId}/${fileName}`,
    };
  }

  /** 写字节到受控目录（先建目录；IO API 不可用时直接抛错） */
  private async writeBytes(
    dir: string,
    dest: string,
    bytes: Uint8Array
  ): Promise<void> {
    const g = globalThis as any;
    if (
      typeof g.IOUtils?.write !== 'function' ||
      typeof g.IOUtils?.makeDirectory !== 'function' ||
      typeof g.PathUtils?.join !== 'function'
    ) {
      throw new Error('file-write-unavailable');
    }
    await g.IOUtils.makeDirectory(dir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await g.IOUtils.write(dest, bytes);
  }

  /** 把已落盘文件挂成父条目的子附件（导入进 Zotero 存储），返回附件 key */
  private async attachFileToParent(
    parent: any,
    absPath: string
  ): Promise<string> {
    const Z = zoteroGlobal();
    if (typeof Z?.Attachments?.importFromFile !== 'function') {
      throw new Error('attachment-api-unavailable');
    }
    const attachment = await Z.Attachments.importFromFile({
      file: absPath,
      parentItemID: parent.id,
    });
    const key: string | undefined = attachment?.key;
    if (!key) {
      throw new Error('attachment-key-missing');
    }
    return key;
  }

  /**
   * 提交写回失败：任务保留未完成并记录错误，可重试；
   * 错误信息截断后再持久化/返回（fail 有长度上限校验）。
   */
  private async failSubmit(
    task: Task,
    e: unknown,
    kind: string
  ): Promise<SubmitResult> {
    const msg = e instanceof Error ? e.message : String(e);
    const short = truncateForDisplay(msg, LIMITS.mcpErrorSnippet);
    logError(`submit ${kind} write failed:`, task.id, short);
    const persisted =
      msg.length > LIMITS.failReason ? msg.slice(0, LIMITS.failReason) + '…' : msg;
    await this.tasks.fail(task.id, persisted).catch(() => undefined);
    return { ok: false, error: `${kind}-write-failed:${short}` };
  }
}
