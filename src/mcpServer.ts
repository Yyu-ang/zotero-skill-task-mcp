/**
 * src/mcpServer.ts — 模块 D：MCP 服务（FR-06 / FR-07 / FR-08 + 需求 §8 安全）
 *
 * 独立监听 23123（本机/局域网）与 23124（外网 OAuth），
 * 不修改 Zotero Connector 的 23119 或任何系统网络偏好。
 * 同一 HTTP 端点双栈支持 MCP 2025-11-25（legacy stateless）与 2026-07-28（modern stateless）；
 * 不提供 SSE/服务端主动消息。
 *
 * 安全（需求 §8）：
 * - 默认启用：pref `extensions.zotero-skill-task.mcp.enabled` 默认为 true；
 *   用户关闭后 handler 层强制返回 503。
 * - 本机/局域网入口免鉴权；外网 23124 独立执行 OAuth，不能用请求头降级。
 * - 两个远程选项默认关闭；OAuth 凭据仅保存在内存，切换模式与重启均失效。
 * - 只返回技能组配置允许的材料（metadata / abstract / notes / pdf 开关）。
 * - 提交的笔记 HTML 在写入前做清理（按数据处理，不执行脚本）。
 *
 * 局域网入口拒绝浏览器跨站 Origin 与公共来源；公网入口使用固定 HTTPS issuer。
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
import { assertValidCompletionRule, findMatchingBuiltinNote, NOTE_COMPLETION_RULE_SCHEMA } from './noteCompletion';
import { existingNoteResult, supportsNoteCompletion, taskLibraryID, withTaskLock } from './taskCoordinator';
import { resolveEarliestPdfPath } from './taskGenerator';
import { prefs, getLeaseMs, getDeliverableMaxBytes } from './prefs';
import { NetworkAccess } from './networkAccess';
import { LAN_MCP_PORT, OAUTH_MCP_PORT } from './lanMcpListener';
import { OAuthServer, normalizeOAuthOrigin, type HttpRequest, type HttpResponse } from './oauthServer';
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

/** Shared MCP route on the two isolated listeners. */
const MCP_PATH = '/skilltask/mcp';
const MCP_HOST = '127.0.0.1';
/** MCP 服务开关（addon/prefs.js 中默认 true） */
const PREF_MCP_ENABLED = 'extensions.zotero-skill-task.mcp.enabled';
/** Independent opt-in flags: an old static token never grants remote access. */
const PREF_ALLOW_REMOTE = 'extensions.zotero-skill-task.mcp.allowRemote';
const PREF_OAUTH_ENABLED = 'extensions.zotero-skill-task.mcp.oauthEnabled';
const PREF_OAUTH_ORIGIN = 'extensions.zotero-skill-task.mcp.oauthPublicOrigin';
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

/** Header names are case-insensitive; accept plain objects and Map-like containers. */
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** MCP service: isolated sockets, JSON-RPC dispatch, task claim and submission. */
export class McpServer implements IMcpServer {
  private skillGroups: ISkillGroupStore;
  private tasks: ITaskStore;
  private generator: ITaskGenerator;
  private version: string;
  private networkError: string | null = null;
  private disposed = false;
  private oauthRevision = 0;
  private transitions: Promise<void> = Promise.resolve();
  private readonly oauth = new OAuthServer({
    getPublicOrigin: () => String(prefs.get(PREF_OAUTH_ORIGIN, '')),
    requestApproval: async ({ clientName, redirectUri, scope }) => {
      const g = globalThis as any;
      const prompt = g.Services?.prompt;
      const win = zoteroGlobal()?.getMainWindow?.();
      const constants = g.Ci?.nsIPromptService;
      if (!prompt || !win || !constants) return false;
      const flags = constants.BUTTON_POS_0 * constants.BUTTON_TITLE_IS_STRING
        + constants.BUTTON_POS_1 * constants.BUTTON_TITLE_CANCEL
        + constants.BUTTON_POS_1_DEFAULT;
      return prompt.confirmEx(win, 'Skill Task MCP — OAuth 授权',
        `客户端自报名称：${clientName}\n回调域名：${new URL(redirectUri).origin}\n回调地址：${truncateForDisplay(redirectUri, 300)}\n权限：${scope}\n\n允许此客户端读取文献及附件材料、创建或修改技能组、领取和管理任务，并将笔记或文件写入文库吗？`,
        flags, '允许本次授权', null, null, null, { value: false }) === 0;
    },
  });
  private readonly network = new NetworkAccess({
    handleLan: async (request) => {
      if (!this.isEnabled()) return this.httpError(503, 'mcp-disabled');
      const [status, mime, body] = await this.handleRequest({ data: request.body, headers: request.headers });
      return { status, headers: { 'Content-Type': mime }, body };
    },
    handleOAuth: (request) => this.handleOAuthHttp(request),
    preflightOAuth: (request) => this.preflightOAuth(request),
    maxBodyBytes: () => Math.ceil(getDeliverableMaxBytes() * 4 / 3) + 1024 * 1024,
  });

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

  private enqueueTransition(action: () => Promise<void>): Promise<void> {
    const next = this.transitions.then(action);
    this.transitions = next.catch(() => {});
    return next;
  }

  private requireLiveInstance(): void {
    if (this.disposed) throw new Error('插件实例已停用，请重新启用插件并打开面板');
  }

  private allowRemote(): boolean { return prefs.get(PREF_ALLOW_REMOTE, false) === true; }
  private oauthEnabled(): boolean { return prefs.get(PREF_OAUTH_ENABLED, false) === true; }

  private async configureNetwork(): Promise<void> {
    this.networkError = null;
    try {
      if (this.isEnabled() && this.allowRemote() && this.oauthEnabled()) {
        if (!normalizeOAuthOrigin(String(prefs.get(PREF_OAUTH_ORIGIN, '')))) {
          throw new Error('启用外网 OAuth 前，请填写有效的 HTTPS 公开地址');
        }
        const c = (globalThis as any).crypto;
        if (!c?.getRandomValues || !c?.subtle?.digest) throw new Error('安全随机数或 Web Crypto 不可用，OAuth 未启动');
      }
      await this.network.configure({
        enabled: this.isEnabled(), allowRemote: this.allowRemote(), oauthEnabled: this.oauthEnabled(),
      });
    } catch (error) {
      this.revokeOAuthAuthorizations();
      try {
        await this.network.configure({ enabled: this.isEnabled(), allowRemote: false, oauthEnabled: false });
      } catch { /* A local port conflict is reported without opening another port. */ }
      this.networkError = errMsg(error);
      throw error;
    }
  }

  async register(): Promise<void> {
    this.requireLiveInstance();
    return this.enqueueTransition(async () => {
      this.requireLiveInstance();
      if (!this.isEnabled()) return;
      // Keep the local management UI usable if a port is occupied or a saved
      // public URL is invalid; no remote listener may survive the failure.
      try { await this.configureNetwork(); }
      catch (error) { logError(`MCP remote access not started: ${errMsg(error)}`); }
    });
  }

  async unregister(): Promise<void> {
    // A stale panel can retain this API object after add-on shutdown. It must
    // never be able to reopen either listener on an unloaded plugin instance.
    this.disposed = true;
    this.revokeOAuthAuthorizations();
    return this.enqueueTransition(async () => { await this.network.stop(); });
  }

  isEnabled(): boolean { return !this.disposed && prefs.get(PREF_MCP_ENABLED, true) === true; }

  async setEnabled(value: boolean): Promise<void> {
    this.requireLiveInstance();
    return this.enqueueTransition(async () => {
      this.requireLiveInstance();
      prefs.set(PREF_MCP_ENABLED, value);
      this.revokeOAuthAuthorizations();
      if (value) {
        await this.configureNetwork();
      } else {
        await this.network.stop();
        this.networkError = null;
      }
    });
  }

  async setNetworkOptions(options: {
    allowRemote: boolean; oauthEnabled: boolean; oauthPublicOrigin: string;
  }): Promise<void> {
    this.requireLiveInstance();
    return this.enqueueTransition(async () => {
      this.requireLiveInstance();
      let origin = options.oauthPublicOrigin.trim()
        ? normalizeOAuthOrigin(options.oauthPublicOrigin) : '';
      // Turning access off must remain possible even if an unsaved origin field
      // contains a typo. Keep the previous value while closing that access.
      const reducingAccess = (this.allowRemote() && !options.allowRemote)
        || (this.oauthEnabled() && !options.oauthEnabled);
      if (origin === null && reducingAccess) origin = String(prefs.get(PREF_OAUTH_ORIGIN, ''));
      if (origin === null) throw new Error('公开地址必须是有效的 HTTPS 地址，不含路径、账号或查询参数');
      if (options.allowRemote && options.oauthEnabled && !origin) {
        throw new Error('启用外网 OAuth 前，请填写 HTTPS 公开地址');
      }
      // Changing a mode or issuer invalidates pending approvals and every token.
      this.revokeOAuthAuthorizations();
      prefs.set(PREF_ALLOW_REMOTE, options.allowRemote);
      prefs.set(PREF_OAUTH_ENABLED, options.oauthEnabled);
      prefs.set(PREF_OAUTH_ORIGIN, origin);
      try { await this.configureNetwork(); }
      catch (error) {
        prefs.set(PREF_ALLOW_REMOTE, false);
        const recovery = this.network.getState().localAccessible
          ? '已恢复本机访问' : '未能监听，所有远程入口已关闭';
        throw new Error(`网络设置未生效，${recovery}：${errMsg(error)}`);
      }
    });
  }

  revokeOAuthAuthorizations(): void {
    this.oauthRevision++;
    this.oauth.revokeAll();
  }

  getStatus(): ReturnType<IMcpServer['getStatus']> {
    const state = this.network.getState();
    const port = state.localAccessible ? LAN_MCP_PORT : null;
    const publicOrigin = String(prefs.get(PREF_OAUTH_ORIGIN, ''));
    return {
      enabled: this.isEnabled(), host: MCP_HOST, path: MCP_PATH, port,
      url: port ? `http://${MCP_HOST}:${port}${MCP_PATH}` : null,
      allowRemote: this.allowRemote(), oauthEnabled: this.oauthEnabled(),
      oauthPublicOrigin: publicOrigin,
      mode: state.mode,
      lanAccessible: state.lanAccessible, lanPort: state.lanPort,
      lanUrl: state.lanAccessible ? `http://<LAN-IP>:${LAN_MCP_PORT}${MCP_PATH}` : null,
      oauthAccessible: state.oauthAccessible, oauthPort: state.oauthPort,
      oauthUrl: state.oauthAccessible ? `${publicOrigin}${MCP_PATH}` : null,
      networkError: this.networkError ?? state.error,
    };
  }

  private httpError(status: number, error: string): HttpResponse {
    return { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error }) };
  }

  private async preflightOAuth(request: HttpRequest): Promise<HttpResponse | null> {
    if (!this.isEnabled() || !this.allowRemote() || !this.oauthEnabled()) return this.httpError(503, 'oauth-disabled');
    const origin = normalizeOAuthOrigin(String(prefs.get(PREF_OAUTH_ORIGIN, '')));
    if (!origin) return this.httpError(503, 'oauth-not-configured');
    const host = getHeader(request.headers, 'host').toLowerCase();
    const allowedHosts = [new URL(origin).host.toLowerCase(), `127.0.0.1:${OAUTH_MCP_PORT}`, `localhost:${OAUTH_MCP_PORT}`, `[::1]:${OAUTH_MCP_PORT}`];
    if (!allowedHosts.includes(host)) return this.httpError(400, 'invalid-host');
    const browserOrigin = getHeader(request.headers, 'origin');
    if (browserOrigin && browserOrigin !== origin) return this.httpError(403, 'invalid-origin');
    const path = request.path.split('?')[0];
    const getRoutes = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/skilltask/mcp', '/oauth/authorize'];
    const postRoutes = ['/oauth/register', '/oauth/token', '/oauth/revoke'];
    if (path !== MCP_PATH) {
      if (!getRoutes.includes(path) && !postRoutes.includes(path)) return this.httpError(404, 'not-found');
      if (request.method !== (getRoutes.includes(path) ? 'GET' : 'POST')) return this.httpError(405, 'method-not-allowed');
      if (Number(getHeader(request.headers, 'content-length') || '0') > 8192) return this.httpError(413, 'oauth-request-too-large');
    }
    if (path === MCP_PATH) {
      if (request.method !== 'POST') return this.httpError(405, 'use-post');
      if (!/^application\/json(?:\s*;|$)/i.test(getHeader(request.headers, 'content-type'))) return this.httpError(415, 'json-required');
      if (!await this.oauth.authenticate(request.headers)) {
        const response = this.httpError(401, 'invalid_token');
        response.headers['WWW-Authenticate'] = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/skilltask/mcp", scope="skilltask"`;
        return response;
      }
    }
    return null;
  }

  private async handleOAuthHttp(request: HttpRequest): Promise<HttpResponse> {
    // Check again after the body read: disabling OAuth must also reject requests
    // that were accepted before the option changed.
    const revision = this.oauthRevision;
    const denied = await this.preflightOAuth(request);
    if (denied) return denied;
    if (revision !== this.oauthRevision || !this.isEnabled() || !this.allowRemote() || !this.oauthEnabled()) {
      return this.oauth.unauthorized();
    }
    if (request.path === MCP_PATH) {
      const [status, mime, body] = await this.handleRequest({ data: request.body, headers: request.headers });
      return { status, headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' }, body };
    }
    return await this.oauth.handle(request) ?? this.httpError(404, 'not-found');
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
    // Authentication belongs to the accepting socket. Local/LAN requests are
    // unauthenticated; every request arriving on 23124 has passed OAuth above.
    // ③ JSON-RPC 解析
    // Socket adapters pass UTF-8 JSON; internal callers may pass a parsed object.
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
                  completionRule: NOTE_COMPLETION_RULE_SCHEMA,
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
                  completionOrigin: { type: 'string', enum: ['agent', 'existing-note', 'existing-attachment'] },
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
        completionRule: assertValidCompletionRule(params?.completionRule),
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

    let checkFailed = false;
    for (const p of pendings) {
      const result = await withTaskLock(p.skillGroupId, p.libraryID, p.itemKey, async (): Promise<ClaimResult | null> => {
        const pending = this.tasks.get(p.id);
        if (!pending || pending.status !== 'pending') return null;
        const sg = this.skillGroups.get(pending.skillGroupId);
        if (!sg || sg.archived || !sg.enabled) return null;
        const parent = await this.resolveParentItem(pending.itemKey, pending.libraryID);
        if (!parent) {
          await this.tasks.fail(pending.id, 'parent-item-missing');
          return null;
        }
        if (!(await this.skillGroups.matchesScope(sg, parent))) return null;
        const match = await findMatchingBuiltinNote(parent, sg.completionRule);
        const current = this.skillGroups.get(sg.id);
        if (!current || !current.enabled || current.archived || current.version !== sg.version) return null;
        if (match.status === 'error' || (sg.completionRule?.enabled && !supportsNoteCompletion(sg.deliverable))) {
          await this.tasks.recordCompletionCheckError(pending.id,
            match.status === 'error' ? match.error : '已有笔记完成判定仅支持内建笔记交付物');
          checkFailed = true;
          return null;
        }
        if (match.status === 'matched') {
          await this.tasks.recognizeExistingNote(pending.id, existingNoteResult(sg, match));
          return null;
        }
        await this.tasks.recordCompletionCheckError(pending.id, null);
        const task = await this.tasks.claimById(pending.id, getLeaseMs(), {
          skillGroupVersion: sg.version,
          instructionSnapshot: sg.instruction,
          completionRuleSnapshot: sg.completionRule?.enabled ? sg.completionRule : null,
          deliverableSnapshot: normalizeDeliverable(sg.deliverable),
        });
        if (!task) return null;
        try {
          const materials = await this.buildMaterialPackage(sg, task.itemKey, task.libraryID);
          const skillAssets = await this.skillGroups.getAssetManifest(sg.id);
          if (sg.referencesEnabled !== true) skillAssets.references = [];
          const stillClaimed = this.tasks.get(task.id);
          if (!stillClaimed || stillClaimed.status !== 'claimed' ||
              stillClaimed.leaseExpiresAt === null || stillClaimed.leaseExpiresAt <= Date.now()) return null;
          const latest = this.skillGroups.get(sg.id);
          if (!latest || latest.archived || !latest.enabled) {
            await this.requeueTask(task.id);
            return null;
          }
          return {
            task: {
              id: task.id,
              skillGroupId: task.skillGroupId,
              skillGroupVersion: task.skillGroupVersion,
              instruction: task.instructionSnapshot,
              skillDescription: sg.description ?? '',
              skillAssets,
              referencesDescription: sg.referencesEnabled === true ? sg.referencesDescription ?? '' : '',
              itemKey: task.itemKey,
              libraryID: taskLibraryID(task.libraryID),
              leaseExpiresAt: task.leaseExpiresAt ?? Date.now() + getLeaseMs(),
              deliverable: normalizeDeliverable(sg.deliverable),
            },
            materials,
          };
        } catch (e) {
          await this.tasks.fail(task.id, errMsg(e));
          return null;
        }
      });
      if (result) return result;
    }
    return { task: null, materials: null, message: checkFailed ? 'completion-check-failed' : 'empty-queue' };
  }

  /**
   * TaskStore 的内部放回方法（requeue 不在 ITaskStore 接口内），
   * 这里做结构化调用，避免 mcpServer → taskStore 的类级导入依赖。
   */
  private taskStoreInternal(): {
    requeue?: (taskId: string) => Promise<unknown>;
  } {
    return this.tasks as unknown as {
      requeue?: (taskId: string) => Promise<unknown>;
      };
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
    itemKey: string,
    libraryID?: number
  ): Promise<MaterialPackage> {
    const parent = await this.resolveParentItem(itemKey, libraryID);
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
   * 按任务文库和 itemKey 查找父条目，旧任务缺少文库时使用个人文库。
   * 用 Zotero.Items.getByLibraryAndKey（zotero-types 已核对签名）；
   * 找不到、非父条目或异常时返回 null，调用方按缺失处理。
   */
  private async resolveParentItem(itemKey: string, libraryID?: number): Promise<any | null> {
    try {
      const Z = zoteroGlobal();
      const item = Z?.Items?.getByLibraryAndKey?.(taskLibraryID(libraryID), itemKey);
      return item && !item.deleted && item.isRegularItem?.() ? item : null;
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
    const taskId = typeof params?.taskId === 'string' ? params.taskId.trim() : '';
    if (!taskId) return { ok: false, error: 'missing-taskId' };
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'task-not-found' };
    return withTaskLock(task.skillGroupId, task.libraryID, task.itemKey,
      () => this.submitLocked(params));
  }

  private async submitLocked(params: any): Promise<SubmitResult> {
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
        submissionCount: task.completionOrigin === 'existing-note' || task.completionOrigin === 'existing-attachment'
          ? Math.max(0, task.submissionCount || 0) : Math.max(1, task.submissionCount || 1),
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

    const deliverable = normalizeDeliverable(task.deliverableSnapshot ?? sg.deliverable);
    const validated = validateSubmitParams(deliverable, params, task.id);
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }

    const parent = await this.resolveParentItem(task.itemKey, task.libraryID);
    if (!parent) {
      if (!isRevision) {
        await this.tasks
          .fail(task.id, 'parent-item-missing')
          .catch(() => undefined);
      }
      return { ok: false, error: 'parent-item-missing' };
    }

    if (!isRevision && supportsNoteCompletion(deliverable)) {
      // Preserve the rule agreed at claim time; old leases without a copy use current config.
      const rule = task.completionRuleSnapshot === undefined
        ? sg.completionRule : task.completionRuleSnapshot ?? undefined;
      const match = await findMatchingBuiltinNote(parent, rule);
      if (match.status === 'error') {
        await this.tasks.recordCompletionCheckError(task.id, match.error);
        return { ok: false, error: `completion-check-failed:${match.error}` };
      }
      if (match.status === 'matched') {
        const completed = await this.tasks.recognizeExistingNote(task.id,
          existingNoteResult({ ...sg, deliverable, version: task.skillGroupVersion }, match), true);
        if (!completed) return { ok: false, error: 'task-state-changed' };
        return this.duplicateResult(completed);
      }
    }

    // Reads may take longer than the lease. Do not write using a stale task state.
    const currentTask = this.tasks.get(task.id);
    if (!currentTask || currentTask.status !== (isRevision ? 'done' : 'claimed')) {
      return { ok: false, error: 'task-state-changed' };
    }
    if (!isRevision && (currentTask.leaseExpiresAt === null || currentTask.leaseExpiresAt <= Date.now())) {
      await this.tasks.releaseExpiredLeases();
      return { ok: false, error: 'lease-expired' };
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
      completionOrigin: task.completionOrigin ?? 'agent',
      deliverableType: dtype,
      submissionCount: task.completionOrigin === 'existing-note' || task.completionOrigin === 'existing-attachment'
          ? Math.max(0, task.submissionCount || 0) : Math.max(1, task.submissionCount || 1),
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
        const existingNote = this.resolveItemByKey(task.noteKey, parent.libraryID);
        if (existingNote && !existingNote.deleted && existingNote.isNote?.() && existingNote.parentID === parent.id) {
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

  /** Keys are unique only within a library. */
  private resolveItemByKey(itemKey: string, libraryID?: number): any | null {
    try {
      return zoteroGlobal()?.Items?.getByLibraryAndKey?.(taskLibraryID(libraryID), itemKey) || null;
    } catch {
      return null;
    }
  }

  /** 在父条目下创建内建笔记，返回笔记 key */
  private async createChildNote(parent: any, html: string): Promise<string> {
    const Z = zoteroGlobal();
    const note = new Z.Item('note');
    note.libraryID = parent.libraryID;
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
            bytes,
            parent
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
    bytes: Uint8Array,
    parent: any
  ): Promise<boolean> {
    try {
      const attachment = this.resolveItemByKey(attachmentKey, parent.libraryID);
      if (!attachment || !attachment.isAttachment?.() ||
          attachment.libraryID !== parent.libraryID || attachment.parentID !== parent.id) return false;
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
