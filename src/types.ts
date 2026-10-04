/**
 * src/types.ts — 模块间共享契约（协调员统一定义，各模块不得擅自修改）
 *
 * MVP 五个模块（技能组/任务存储/生成器/MCP/面板）都按这里的接口编程：
 * - 数据结构：SkillGroup / Task / MaterialPackage
 * - 存储接口：ISkillGroupStore / ITaskStore（具体类用 `implements` 实现）
 * - 服务接口：ITaskGenerator / IMcpServer
 * - 面板运行时 API：SkillTaskAPI（协调员在 core.ts 接线时挂载到 Zotero.SkillTask）
 *
 * 约定：
 * - 所有时间戳为毫秒 epoch（Date.now()）
 * - id 一律用随机字符串（`uid()` 生成，见下）
 * - Zotero 条目一律用父条目的 key（item.key），不为附件子条目建任务
 */

/** 任务状态机：等待材料 → 待领取 → 已领取（租约中）→ 已完成；另设失败/待重试、已取消 */
export type TaskStatus =
  | 'waiting-material'
  | 'pending'
  | 'claimed'
  | 'done'
  | 'failed'
  | 'cancelled';

/** 技能组范围 */
export interface SkillScope {
  /** 'all' 全库；'collections' 指定集合 */
  type: 'all' | 'collections';
  /** 指定集合的 key 列表（type==='collections' 时有效） */
  collectionKeys: string[];
  /** 是否包含子集合（默认 true） */
  includeSubcollections: boolean;
}

/** 技能组输入材料配置 */
export interface SkillMaterials {
  /** 文献基本信息（标题/作者/年份/条目 key） */
  includeMetadata: boolean;
  /** 摘要 */
  includeAbstract: boolean;
  /** 已有笔记（标题+文本，不含附件） */
  includeNotes: boolean;
  /** 'earliest' = 目标父条目下 dateAdded 最早的本地 PDF；'none' = 不提供 PDF */
  pdf: 'earliest' | 'none';
}

/** 技能组交付物定义 */
export type SkillDeliverable =
  | {
      /** 内建笔记：文本/HTML 写成父条目下的 Zotero 笔记 */
      type: 'note';
    }
  | {
      /** 文件：二进制文件（PDF 等）存入受控输出目录 */
      type: 'file';
      /** 是否自动挂成父条目附件（默认 false：只存受控目录） */
      attachToItem?: boolean;
      /** 允许的扩展名白名单（小写、无点，如 ['pdf']）；省略用默认安全白名单 */
      allowedExtensions?: string[];
      /** 单文件最大字节数；省略用全局默认（LIMITS.deliverableFileBytes） */
      maxBytes?: number;
    }
  | {
      /** Markdown 文本 */
      type: 'markdown';
      /** 'note' 转写成内建笔记；'file' 存为 .md 文件 */
      target: 'note' | 'file';
      /** target==='file' 时是否挂成父条目附件（默认 false） */
      attachToItem?: boolean;
    };

/** 技能组（AI 任务模板） */
export interface SkillGroup {
  id: string;
  name: string;
  /** 任务指令（发给 AI 的说明文字） */
  instruction: string;
  /** 启用中 / 已停用 */
  enabled: boolean;
  /** 归档（软删除，不再生成新任务，历史保留） */
  archived: boolean;
  /** 版本号：每次编辑 +1；任务领取时快照当时的版本+指令 */
  version: number;
  scope: SkillScope;
  materials: SkillMaterials;
  deliverable: SkillDeliverable;
  createdAt: number;
  updatedAt: number;
}

export interface SkillGroupCreateData {
  name: string;
  instruction: string;
  scope: SkillScope;
  materials: SkillMaterials;
  deliverable: SkillDeliverable;
}

export type SkillGroupPatch = Partial<
  Pick<
    SkillGroup,
    'name' | 'instruction' | 'scope' | 'materials' | 'deliverable'
  >
>;

/** 任务 */
export interface Task {
  id: string;
  skillGroupId: string;
  /** 领取时的技能组版本快照 */
  skillGroupVersion: number;
  /** 领取时的任务指令快照 */
  instructionSnapshot: string;
  /** 目标 Zotero 父条目 key */
  itemKey: string;
  status: TaskStatus;
  /** 租约过期时间（claimed 时设置），null 表示无租约 */
  leaseExpiresAt: number | null;
  /** 领取/提交尝试次数 */
  attempts: number;
  lastError: string | null;
  /** 完成时创建的 Zotero 笔记 key（note / markdown→note 时；历史兼容字段） */
  noteKey: string | null;
  /** 完成时交付物类型（done 时记录；历史任务为 null） */
  deliverableType: 'note' | 'file' | 'markdown' | null;
  /**
   * 完成时交付物引用（幂等依据）：
   * note/markdown→note 时为笔记 key；file/markdown→file 时为相对受控目录的文件名
   */
  deliverableRef: string | null;
  /** 完成时挂成的 Zotero 附件 key（仅 attachToItem 时有值） */
  attachmentKey: string | null;
  createdAt: number;
  claimedAt: number | null;
  completedAt: number | null;
}

export interface TaskCreateData {
  skillGroupId: string;
  skillGroupVersion: number;
  instructionSnapshot: string;
  itemKey: string;
  /** 默认 'pending'；材料不齐时传 'waiting-material' */
  status?: TaskStatus;
}

export interface TaskFilter {
  skillGroupId?: string;
  status?: TaskStatus | TaskStatus[];
}

/** 领取时返回给 AI 的输入材料包（只含技能配置允许的材料） */
export interface MaterialPackage {
  itemKey: string;
  metadata: {
    title?: string;
    creators?: string;
    date?: string;
    itemType?: string;
  } | null;
  abstractNote: string | null;
  notes: Array<{ key: string; title: string; text: string }> | null;
  /** 本地 PDF 绝对路径；无合格 PDF 时为 null */
  pdfPath: string | null;
}

/** 领取结果 */
export interface ClaimResult {
  task: {
    id: string;
    skillGroupId: string;
    skillGroupVersion: number;
    instruction: string;
    itemKey: string;
    leaseExpiresAt: number;
    /** 技能组声明的交付物 schema（FR-07）：提交时须按此格式 */
    deliverable: SkillDeliverable;
  } | null;
  materials: MaterialPackage | null;
  /** task 为 null 时的说明（如 'empty-queue'） */
  message?: string;
}

/** 提交结果 */
export interface SubmitResult {
  ok: boolean;
  noteKey?: string;
  /** 文件交付物的文件名（相对受控输出目录） */
  fileName?: string;
  /** 挂成附件时的 Zotero 附件 key */
  attachmentKey?: string;
  /** 本次提交的交付物类型 */
  deliverableType?: 'note' | 'file' | 'markdown';
  /** 重复提交（幂等命中）时为 true */
  duplicate?: boolean;
  error?: string;
}

/** 任务完成时的交付物记录（传给 ITaskStore.complete） */
export interface TaskCompleteResult {
  /** 笔记 key（note / markdown→note 时；其余类型为 null） */
  noteKey: string | null;
  deliverableType: 'note' | 'file' | 'markdown';
  /** 交付物引用：note 时为笔记 key；file 时为相对受控目录的文件名 */
  deliverableRef: string | null;
  /** 挂成附件时的 Zotero 附件 key（无则为 null） */
  attachmentKey?: string | null;
}

/** 扫描结果统计 */
export interface ScanResult {
  skillGroupId: string;
  scanned: number;
  created: number;
  /** 已存在同样任务，跳过 */
  skipped: number;
  /** 材料不齐，进入等待材料 */
  waitingMaterial: number;
  /** 材料后到，由等待材料转为待领取 */
  promoted: number;
}

export interface ScanOptions {
  /** 可中断 */
  signal?: AbortSignal;
  /** 进度回调 (已处理, 总数) */
  onProgress?: (done: number, total: number) => void;
}

// ──────────── 存储接口 ────────────

/** 技能组存储（模块 A 实现 src/skillGroupStore.ts，`implements ISkillGroupStore`） */
export interface ISkillGroupStore {
  list(includeArchived?: boolean): SkillGroup[];
  get(id: string): SkillGroup | undefined;
  create(data: SkillGroupCreateData): Promise<SkillGroup>;
  /** 编辑：patch 生效后 version +1、updatedAt 更新 */
  update(id: string, patch: SkillGroupPatch): Promise<SkillGroup>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** 复制为新技能组（名称 + " 副本"，新 id/version=1） */
  copy(id: string): Promise<SkillGroup>;
  /** 归档（软删除） */
  archive(id: string): Promise<void>;
  /** 硬删除（仅允许已归档的） */
  remove(id: string): Promise<void>;
  /** 条目是否命中技能组范围（父条目；多集合命中仍只算一次，由调用方保证唯一性） */
  matchesScope(sg: SkillGroup, item: any): Promise<boolean>;
}

/** 任务存储（模块 B 实现 src/taskStore.ts，`implements ITaskStore`） */
export interface ITaskStore {
  list(filter?: TaskFilter): Task[];
  get(id: string): Task | undefined;
  /** 幂等键：同一技能组 × 同一条目 的有效任务（非 cancelled/done 视为有效） */
  findActiveBySkillAndItem(
    skillGroupId: string,
    itemKey: string
  ): Task | undefined;
  create(data: TaskCreateData): Promise<Task>;
  /**
   * 原子领取：取最早的一条 pending（可选限定技能组）→ 标记 claimed + 租约。
   * 无任务返回 null。领取前先释放过期租约。
   */
  claimNext(
    skillGroupId: string | undefined,
    leaseMs: number
  ): Promise<Task | null>;
  /** 过期租约 → pending，返回释放数量 */
  releaseExpiredLeases(now?: number): Promise<number>;
  /**
   * 完成：置 done、completedAt=now、记录交付物引用，并清除租约。
   * 已 done 直接返回原任务（幂等：重复提交不抛错、引用不变）。
   */
  complete(id: string, result: TaskCompleteResult): Promise<Task>;
  fail(id: string, error: string): Promise<Task>;
  cancel(id: string): Promise<void>;
  /** failed → pending（attempts 保留） */
  retry(id: string): Promise<void>;
  /** waiting-material → pending（材料到达时调用） */
  promoteToPending(id: string): Promise<Task | null>;
  countsBySkill(skillGroupId: string): Record<TaskStatus, number>;
}

// ──────────── 服务接口 ────────────

/** 任务生成器（模块 C 实现 src/taskGenerator.ts，`implements ITaskGenerator`） */
export interface ITaskGenerator {
  scanSkillGroup(
    skillGroupId: string,
    opts?: ScanOptions
  ): Promise<ScanResult>;
  scanAllEnabled(opts?: ScanOptions): Promise<ScanResult[]>;
  registerNotifier(): void;
  unregisterNotifier(): void;
}

/** MCP 服务（模块 D 实现 src/mcpServer.ts，`implements IMcpServer`） */
export interface IMcpServer {
  register(): void;
  unregister(): void;
  isEnabled(): boolean;
  setEnabled(v: boolean): void;
  /** 返回现有 token；没有则生成并持久化 */
  ensureToken(): string;
  regenerateToken(): string;
  /** 访问凭据是否启用（可选项，默认关闭） */
  isTokenEnabled(): boolean;
  setTokenEnabled(v: boolean): void;
  getStatus(): {
    enabled: boolean;
    path: string;
    /** Zotero 内建服务器端口（Connector Server）；null 表示未知 */
    port: number | null;
  };
}

/** 面板运行时 API（协调员在 core.ts 接线，挂载为 Zotero.SkillTask） */
export interface SkillTaskAPI {
  skillGroups: ISkillGroupStore;
  tasks: ITaskStore;
  generator: ITaskGenerator;
  mcp: IMcpServer;
  version: string;
}

/** 生成随机 id（各模块统一使用） */
export function uid(): string {
  const bytes = new Uint8Array(12);
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 默认租约时长：30 分钟 */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;

/** 插件数据目录名（放在 Zotero.DataDirectory.dir 下） */
export const DATA_DIR_NAME = 'skilltask';
