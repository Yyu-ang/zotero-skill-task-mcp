/**
 * src/mcpServer.ts — 模块 D：MCP 服务（FR-06 / FR-07 / FR-08 + 需求 §8 安全）
 *
 * 按 docs/TECH_VALIDATION_MCP_HTTP.md 方案 A 实现：
 * 复用 Zotero 进程内 Connector Server，注册端点 /skilltask/mcp，
 * 以 JSON-RPC 2.0 over POST 处理 MCP 请求（Streamable HTTP 简化模式，不做 SSE）。
 *
 * 安全（需求 §8）：
 * - 默认关闭：pref `extensions.zotero-skill-task.mcp.enabled` 默认为 false，
 *   handler 层强制检查，未启用返回 503。
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
  MaterialPackage,
  SkillGroup,
  SubmitResult,
} from './types';
import { DEFAULT_LEASE_MS } from './types';
import { resolveEarliestPdfPath } from './taskGenerator';
import { prefs } from './prefs';
import { error as logError, log } from './utils';

// Firefox chrome 特权环境里运行时可用，但 zotero-types 未声明，这里补声明
declare const DOMParser: any;
declare const TextEncoder: any;

/** MCP 端点路径（技术文档 §2.1 方案 A） */
const MCP_PATH = '/skilltask/mcp';
/** 默认关闭开关（addon/prefs.js 中默认 false） */
const PREF_MCP_ENABLED = 'extensions.zotero-skill-task.mcp.enabled';
/** Bearer token 存储键（由 ensureToken 生成/持久化） */
const PREF_MCP_TOKEN = 'extensions.zotero-skill-task.mcp.token';
/** 响应的 MCP 协议版本 */
const MCP_PROTOCOL_VERSION = '2024-11-05';
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
      if (!n || n === false || (n.isNote && !n.isNote())) continue;
      out.push({
        key: String(n.key),
        title: tryGet(
          () => (n.getNoteTitle ? n.getNoteTitle() : ''),
          ''
        ),
        text: stripHtml(tryGet(() => (n.getNote ? n.getNote() : ''), '')),
      });
    } catch {
      // 单条笔记异常跳过，不影响整体材料包
    }
  }
  return out;
}

/** 探测 Connector Server 端口（取不到为 null，绝不写回 pref） */
function detectServerPort(): number | null {
  try {
    const Z = zoteroGlobal();
    const p = Z?.Prefs?.get?.('httpServer.port', true);
    return typeof p === 'number' && p > 0 ? p : null;
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
  private version: string;

  constructor(deps: {
    skillGroups: ISkillGroupStore;
    tasks: ITaskStore;
    version: string;
  }) {
    this.skillGroups = deps.skillGroups;
    this.tasks = deps.tasks;
    this.version = deps.version;
  }

  // ──────────── IMcpServer ────────────

  /** 注册端点到 Zotero.Server.Endpoints */
  register(): void {
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
    log('MCP endpoint registered:', MCP_PATH);
  }

  /** 注销端点（不持有 socket，无需额外清理） */
  unregister(): void {
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
    return !!prefs.get(PREF_MCP_ENABLED, false);
  }

  setEnabled(v: boolean): void {
    prefs.set(PREF_MCP_ENABLED, v);
  }

  /** 返回现有 token；没有则生成（32 字节随机 hex）并持久化 */
  ensureToken(): string {
    const existing = prefs.get(PREF_MCP_TOKEN, '');
    if (typeof existing === 'string' && existing.length >= 32) {
      return existing;
    }
    const token = randomHex(32);
    prefs.set(PREF_MCP_TOKEN, token);
    return token;
  }

  /** 重新生成 token（旧 token 立即失效） */
  regenerateToken(): string {
    const token = randomHex(32);
    prefs.set(PREF_MCP_TOKEN, token);
    return token;
  }

  getStatus(): { enabled: boolean; path: string; port: number | null } {
    return {
      enabled: this.isEnabled(),
      path: MCP_PATH,
      port: detectServerPort(),
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
    // ① 默认关闭：在 handler 层强制（需求 §8）
    if (!this.isEnabled()) {
      return [
        503,
        'application/json',
        JSON.stringify({ error: 'mcp-disabled' }),
      ];
    }
    // ② Bearer 鉴权：常量时间比较，缺失/错误一律 401
    const expected = String(prefs.get(PREF_MCP_TOKEN, '') ?? '');
    const got = extractBearer(requestData?.headers);
    if (!expected || !timingSafeEqual(got, expected)) {
      return [
        401,
        'application/json',
        JSON.stringify({ error: 'unauthorized' }),
      ];
    }
    // ③ JSON-RPC 解析
    let rpc: any;
    try {
      rpc = JSON.parse(String(requestData?.data ?? ''));
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
    return this.dispatch(rpc);
  }

  // ──────────── JSON-RPC 2.0 分发 ────────────

  private async dispatch(rpc: any): Promise<[number, string, string]> {
    const method = rpc?.method;
    const id = rpc?.id;
    // 无 id 的通知：notifications/initialized → 202 空响应；其他通知忽略
    if (id === undefined || id === null) {
      return [202, 'application/json', ''];
    }
    try {
      switch (method) {
        case 'initialize':
          return this.jsonOk(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: 'zotero-skill-task-mcp',
              version: this.version,
            },
          });
        case 'tools/list':
          return this.jsonOk(id, {
            tools: [
              {
                name: 'skilltask_claim',
                description:
                  '从技能组任务队列中领取下一条待处理任务。每次调用至多返回一条任务；' +
                  '无可领取任务时返回空队列结果（message 为 empty-queue）。',
                inputSchema: {
                  type: 'object',
                  properties: {
                    skillGroupId: {
                      type: 'string',
                      description:
                        '技能组 ID；省略则从全部待领取任务中领取最早的一条。',
                    },
                  },
                },
              },
              {
                name: 'skilltask_submit',
                description:
                  '提交任务结果（Zotero 内建笔记 HTML 内容）。成功后插件在任务关联的' +
                  '父条目下创建一条内建笔记并把任务标记为完成；重复提交同一任务幂等返回，' +
                  '不会创建第二条笔记。',
                inputSchema: {
                  type: 'object',
                  properties: {
                    taskId: {
                      type: 'string',
                      description: '领取时返回的任务 ID。',
                    },
                    noteHtml: {
                      type: 'string',
                      description:
                        '要写入 Zotero 内建笔记的 HTML 内容（脚本/事件属性会被清理）。',
                    },
                  },
                  required: ['taskId', 'noteHtml'],
                },
              },
            ],
          });
        case 'tools/call': {
          const name = rpc?.params?.name;
          const args = rpc?.params?.arguments ?? {};
          if (name === 'skilltask_claim') {
            const result = await this.claim(args);
            return this.toolOk(id, result);
          }
          if (name === 'skilltask_submit') {
            const result = await this.submit(args);
            return this.toolOk(id, result);
          }
          return this.jsonErr(
            id,
            ERR_INVALID_PARAMS,
            `unknown tool: ${String(name)}`
          );
        }
        default:
          return this.jsonErr(
            id,
            ERR_METHOD_NOT_FOUND,
            `Method not found: ${String(method)}`
          );
      }
    } catch (e) {
      return this.jsonErr(id, ERR_INTERNAL, `Internal error: ${errMsg(e)}`);
    }
  }

  private jsonOk(id: unknown, result: unknown): [number, string, string] {
    return [
      200,
      'application/json',
      JSON.stringify({ jsonrpc: '2.0', id, result }),
    ];
  }

  private jsonErr(
    id: unknown,
    code: number,
    message: string
  ): [number, string, string] {
    return [
      200,
      'application/json',
      JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    ];
  }

  /**
   * tools/call 成功响应：业务错误（如空队列、提交校验失败）放在结果 JSON 里返回，
   * 而不是 JSON-RPC 错误，保证 MCP 客户端总能拿到结构化的业务结果。
   */
  private toolOk(
    id: unknown,
    result: unknown
  ): [number, string, string] {
    return this.jsonOk(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    });
  }

  // ──────────── claim（FR-06 / FR-07） ────────────

  /**
   * 领取：被动、按请求触发，每次至多一条（FR-06）。
   * 租约并发保护由 tasks.claimNext 原子实现。
   */
  private async claim(params: any): Promise<ClaimResult> {
    const skillGroupId: string | undefined =
      typeof params?.skillGroupId === 'string' && params.skillGroupId
        ? params.skillGroupId
        : undefined;
    const task = await this.tasks.claimNext(skillGroupId, DEFAULT_LEASE_MS);
    if (!task) {
      // FR-06：无任务时返回明确的空队列结果
      return { task: null, materials: null, message: 'empty-queue' };
    }
    const sg = this.skillGroups.get(task.skillGroupId);
    if (!sg) {
      await this.tasks
        .fail(task.id, 'skill-group-missing')
        .catch(() => undefined);
      throw new Error(`技能组不存在：${task.skillGroupId}`);
    }
    const materials = await this.buildMaterialPackage(sg, task.itemKey);
    return {
      task: {
        id: task.id,
        skillGroupId: task.skillGroupId,
        skillGroupVersion: task.skillGroupVersion,
        instruction: task.instructionSnapshot,
        itemKey: task.itemKey,
        leaseExpiresAt: task.leaseExpiresAt ?? Date.now() + DEFAULT_LEASE_MS,
      },
      materials,
    };
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
    const mat = sg.materials;
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
   * - noteHtml 清理后为空 → 拒绝
   * - 笔记写入任务关联的父条目下（new Zotero.Item('note') + parentID）
   * - 成功后 tasks.complete 标记完成；写回抛错 → tasks.fail 保留未完成可重试
   * - 已完成 + 有 noteKey → 幂等返回，不建第二条笔记
   */
  private async submit(params: any): Promise<SubmitResult> {
    const taskId = params?.taskId;
    if (!taskId || typeof taskId !== 'string') {
      return { ok: false, error: 'missing-taskId' };
    }
    const task = this.tasks.get(taskId);
    if (!task) {
      return { ok: false, error: 'task-not-found' };
    }
    // 幂等：已完成且已有笔记 key，直接返回（不建第二条笔记）
    if (task.status === 'done' && task.noteKey) {
      return { ok: true, noteKey: task.noteKey, duplicate: true };
    }
    if (task.status !== 'claimed') {
      return { ok: false, error: `task-not-claimed:${task.status}` };
    }
    // 租约过期：先释放过期租约，再报错（任务回到待领取，可重新领取）
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
    // 写回安全：清理后再校验（需求 §8）
    const clean = sanitizeNoteHtml(params?.noteHtml);
    if (!clean) {
      return { ok: false, error: 'empty-note-after-sanitize' };
    }
    // 按 itemKey 取父条目（守卫：不存在则 fail 任务并报错）
    const parent = await this.resolveParentItem(task.itemKey);
    if (!parent) {
      await this.tasks
        .fail(task.id, 'parent-item-missing')
        .catch(() => undefined);
      return { ok: false, error: 'parent-item-missing' };
    }
    try {
      const Z = zoteroGlobal();
      const note = new Z.Item('note');
      note.parentID = parent.id;
      note.setNote(clean);
      await note.saveTx();
      const noteKey: string = note.key;
      if (!noteKey) {
        throw new Error('note-key-missing');
      }
      await this.tasks.complete(task.id, noteKey);
      log('submit ok:', task.id, '-> note', noteKey);
      return { ok: true, noteKey };
    } catch (e) {
      // 写回失败：任务保留未完成并记录错误，可重试
      const msg = errMsg(e);
      logError('submit note write failed:', task.id, msg);
      await this.tasks.fail(task.id, msg).catch(() => undefined);
      return { ok: false, error: `note-write-failed:${msg}` };
    }
  }
}
