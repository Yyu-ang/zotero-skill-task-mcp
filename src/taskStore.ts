/**
 * src/taskStore.ts — 模块 B：任务存储（持久化、状态机与租约）
 *
 * 实现 ITaskStore 契约（见 types.ts），负责：
 * - 任务 JSON 持久化（Zotero 数据目录下 skilltask/tasks.json），写穿落盘；
 * - 状态机流转：waiting-material → pending → claimed → done，另设 failed / cancelled；
 * - 租约机制：领取即加租约（默认 30 分钟），过期租约自动释放回 pending，防止多 AI 并发重复领取。
 *
 * 设计要点：
 * - 绝不直接写 Zotero 数据库；所有持久化只经过 IOUtils 的 JSON 文件 API。
 * - IOUtils.writeJSON 内部为原子写（临时文件 + 重命名），崩溃后不会产生半截文件。
 * - JS 单线程内“先释放过期租约 → 取最早 pending → 标记 claimed → 落盘”即原子领取。
 * - 对外返回任务时一律返回浅拷贝，调用方无法绕开本类修改内部状态。
 */

import {
  DATA_DIR_NAME,
  type ITaskStore,
  type Task,
  type TaskCompleteResult,
  type TaskCreateData,
  type TaskFilter,
  type TaskStatus,
  uid,
} from './types';
import { LIMITS, error, log, truncateForDisplay } from './utils';
import { traced } from './utils/trace';
import { getLeaseMs } from './prefs';

/** 任务文件的文件名（位于 Zotero 数据目录下 DATA_DIR_NAME 目录内） */
const TASKS_FILE_NAME = 'tasks.json';

/** 全部六种任务状态（用于计数补齐与状态合法性校验） */
const ALL_STATUSES: TaskStatus[] = [
  'waiting-material',
  'pending',
  'claimed',
  'done',
  'failed',
  'cancelled',
];

/**
 * 任务存储实现。
 *
 * 请使用 `TaskStore.load()` 异步构造（会创建数据目录并从磁盘恢复任务）。
 */
export class TaskStore implements ITaskStore {
  /** 内部任务表：id → 任务。Map 保持插入顺序（即创建时间顺序），便于取“最早”任务。 */
  private tasks: Map<string, Task> = new Map();

  /** tasks.json 的绝对路径 */
  private readonly filePath: string;

  /**
   * 持久化写队列：串行化落盘。
   * IOUtils.writeJSON 是"临时文件 + 重命名"语义，并发 persist 会共用临时文件
   * 互相覆盖/重命名失败（如并发 claimNext）；队列保证同一时刻只有一个落盘在飞。
   */
  private persistQueue: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  // ──────────── 构造与持久化 ────────────

  /**
   * 异步构造：创建数据目录、从磁盘读取已有任务（文件不存在或损坏时视为空）。
   */
  static async load(): Promise<TaskStore> {
    const dirPath = PathUtils.join(Zotero.DataDirectory.dir, DATA_DIR_NAME);
    const filePath = PathUtils.join(dirPath, TASKS_FILE_NAME);
    await IOUtils.makeDirectory(dirPath, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const store = new TaskStore(filePath);
    await store.restoreFromDisk();
    log(`任务存储就绪：${store.tasks.size} 条任务 @ ${filePath}`);
    return store;
  }

  /** 从磁盘恢复任务；读不到或内容非法时视为 0 条并记录错误。 */
  private async restoreFromDisk(): Promise<void> {
    let raw: unknown;
    try {
      if (!(await IOUtils.exists(this.filePath))) {
        return; // 首次运行：没有文件，视为空
      }
      raw = await IOUtils.readJSON(this.filePath);
    } catch (e) {
      error('读取任务文件失败，视为空任务表：', e);
      return;
    }
    if (!Array.isArray(raw)) {
      error('任务文件内容不是数组，视为空任务表');
      return;
    }
    for (const item of raw) {
      const task = normalizeTask(item);
      if (task) {
        this.tasks.set(task.id, task);
      }
    }
  }

  /** 写穿落盘：全量任务表序列化为 JSON 并原子写入（经队列串行）。 */
  private async persist(): Promise<void> {
    const run = this.persistQueue.then(() => this.writeSnapshot());
    // 保持队列不断：本次失败不影响后续落盘；调用方仍能拿到本次的错误
    this.persistQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async writeSnapshot(): Promise<void> {
    try {
      await IOUtils.writeJSON(this.filePath, Array.from(this.tasks.values()));
    } catch (e) {
      error('任务持久化落盘失败：', e);
      throw e;
    }
  }

  // ──────────── 查询 ────────────

  /** 列出任务（可选按技能组和状态过滤），返回浅拷贝。 */
  list(filter?: TaskFilter): Task[] {
    let result = Array.from(this.tasks.values());
    if (filter?.skillGroupId !== undefined) {
      result = result.filter((t) => t.skillGroupId === filter.skillGroupId);
    }
    if (filter?.status !== undefined) {
      const wanted = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      result = result.filter((t) => wanted.includes(t.status));
    }
    return result.map((t) => ({ ...t }));
  }

  /** 按 id 取任务；不存在返回 undefined。 */
  get(id: string): Task | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task } : undefined;
  }

  /**
   * 幂等键：同一技能组 × 同一条目下状态不在 ('done','cancelled') 的任务。
   * 供生成器去重：返回其中创建时间最晚的一条（若有多条“有效”任务并存）。
   */
  findActiveBySkillAndItem(
    skillGroupId: string,
    itemKey: string
  ): Task | undefined {
    let found: Task | undefined;
    for (const task of this.tasks.values()) {
      if (
        task.skillGroupId === skillGroupId &&
        task.itemKey === itemKey &&
        task.status !== 'done' &&
        task.status !== 'cancelled'
      ) {
        // tasks 按插入顺序遍历 → 后遍历到的创建时间更晚，直接覆盖即可
        found = task;
      }
    }
    return found ? { ...found } : undefined;
  }


  findLatestBySkillAndItem(
    skillGroupId: string,
    itemKey: string
  ): Task | undefined {
    let found: Task | undefined;
    for (const task of this.tasks.values()) {
      if (task.skillGroupId !== skillGroupId || task.itemKey !== itemKey) continue;
      if (!found || task.createdAt >= found.createdAt) {
        found = task;
      }
    }
    return found ? { ...found } : undefined;
  }

  /** 取内部任务记录（无拷贝）；不存在时抛错（id 超长时截断展示） */
  private require(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`任务不存在：${truncateForDisplay(id)}`);
    }
    return task;
  }

  // ──────────── 写入操作（均为写穿落盘） ────────────

  /**
   * 创建任务。
   * - id 用 uid() 生成；status 默认 'pending'，也可传入 'waiting-material'；
   * - attempts=0、leaseExpiresAt=null、lastError=null、noteKey=null，时间戳齐全。
   */
  @traced
  async create(data: TaskCreateData): Promise<Task> {
    const status: TaskStatus = data.status ?? 'pending';
    if (status !== 'pending' && status !== 'waiting-material') {
      throw new Error(`新建任务只允许 pending 或 waiting-material 状态，收到：${status}`);
    }
    if (typeof data.skillGroupId !== 'string' || !data.skillGroupId.trim()) {
      throw new Error('创建任务失败：技能组 ID 无效');
    }
    if (typeof data.itemKey !== 'string' || !data.itemKey.trim()) {
      throw new Error('创建任务失败：条目 key 无效');
    }
    const now = Date.now();
    const task: Task = {
      id: uid(),
      skillGroupId: data.skillGroupId,
      skillGroupVersion: data.skillGroupVersion,
      instructionSnapshot: data.instructionSnapshot,
      itemKey: data.itemKey,
      status,
      leaseExpiresAt: null,
      attempts: 0,
      lastError: null,
      noteKey: null,
      deliverableType: null,
      deliverableRef: null,
      attachmentKey: null,
      createdAt: now,
      claimedAt: null,
      completedAt: null,
    };
    this.tasks.set(task.id, task);
    await this.persist();
    return { ...task };
  }


  @traced
  async createCompleted(
    data: TaskCreateData,
    result: TaskCompleteResult
  ): Promise<Task> {
    if (typeof data.skillGroupId !== 'string' || !data.skillGroupId.trim()) {
      throw new Error('创建已完成任务失败：技能组 ID 无效');
    }
    if (typeof data.itemKey !== 'string' || !data.itemKey.trim()) {
      throw new Error('创建已完成任务失败：条目 key 无效');
    }
    if (
      result.deliverableType !== 'note' &&
      result.deliverableType !== 'file' &&
      result.deliverableType !== 'markdown'
    ) {
      throw new Error('创建已完成任务失败：交付物类型无效');
    }
    if (typeof result.deliverableRef !== 'string' || !result.deliverableRef.trim()) {
      throw new Error('创建已完成任务失败：交付物引用无效');
    }
    const now = Date.now();
    const task: Task = {
      id: uid(),
      skillGroupId: data.skillGroupId,
      skillGroupVersion: data.skillGroupVersion,
      instructionSnapshot: data.instructionSnapshot,
      itemKey: data.itemKey,
      status: 'done',
      leaseExpiresAt: null,
      attempts: 0,
      lastError: null,
      noteKey:
        typeof result.noteKey === 'string' && result.noteKey
          ? result.noteKey
          : null,
      deliverableType: result.deliverableType,
      deliverableRef: result.deliverableRef,
      attachmentKey:
        typeof result.attachmentKey === 'string' && result.attachmentKey
          ? result.attachmentKey
          : null,
      createdAt: now,
      claimedAt: null,
      completedAt: now,
    };
    this.tasks.set(task.id, task);
    await this.persist();
    return { ...task };
  }

  /**
   * 原子领取：先释放过期租约，再从最早的一条 pending（可选限定技能组）中取。
   * 标记 claimed + 租约过期时间 + claimedAt + attempts+1 后落盘返回；
   * 无任务时返回 null。
   */
  @traced
  async claimNext(
    skillGroupId: string | undefined,
    leaseMs: number
  ): Promise<Task | null> {
    // 防御：非法租约时长回退到偏好/默认值，避免租约立即过期或溢出
    const safeLeaseMs =
      Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : getLeaseMs();
    await this.releaseExpiredLeases();

    let candidate: Task | undefined;
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') {
        continue;
      }
      if (skillGroupId !== undefined && task.skillGroupId !== skillGroupId) {
        continue;
      }
      if (!candidate || task.createdAt < candidate.createdAt) {
        candidate = task;
      }
    }
    if (!candidate) {
      return null;
    }

    const now = Date.now();
    candidate.status = 'claimed';
    candidate.leaseExpiresAt = now + safeLeaseMs;
    candidate.claimedAt = now;
    candidate.attempts += 1;

    await this.persist();
    return { ...candidate };
  }

  /**
   * 释放过期租约：claimed 且 leaseExpiresAt <= now 的转回 pending（leaseExpiresAt 置 null），
   * 返回释放数量。claimedAt 保留为上次领取时间的历史记录。
   */
  @traced
  async releaseExpiredLeases(now: number = Date.now()): Promise<number> {
    let released = 0;
    for (const task of this.tasks.values()) {
      if (
        task.status === 'claimed' &&
        task.leaseExpiresAt !== null &&
        task.leaseExpiresAt <= now
      ) {
        task.status = 'pending';
        task.leaseExpiresAt = null;
        released += 1;
      }
    }
    if (released > 0) {
      await this.persist();
      log(`释放过期租约：${released} 条任务回到待领取`);
    }
    return released;
  }

  /**
   * 完成任务：置 done、completedAt=now、记录交付物引用，并清除租约。
   * 已 done 直接返回原任务（幂等：重复提交不抛错、引用不变）。
   */
  @traced
  async complete(id: string, result: TaskCompleteResult): Promise<Task> {
    const task = this.require(id);
    if (task.status === 'done') {
      return { ...task }; // 幂等：重复提交不产生副作用
    }
    if (
      result.deliverableType !== 'note' &&
      result.deliverableType !== 'file' &&
      result.deliverableType !== 'markdown'
    ) {
      throw new Error('完成任务失败：交付物类型无效');
    }
    if (typeof result.deliverableRef !== 'string' || !result.deliverableRef.trim()) {
      throw new Error('完成任务失败：交付物引用无效');
    }
    task.status = 'done';
    task.completedAt = Date.now();
    task.deliverableType = result.deliverableType;
    task.deliverableRef = result.deliverableRef;
    task.attachmentKey =
      typeof result.attachmentKey === 'string' && result.attachmentKey
        ? result.attachmentKey
        : null;
    // noteKey 保持历史兼容：note / markdown→note 时写入笔记 key
    task.noteKey =
      typeof result.noteKey === 'string' && result.noteKey
        ? result.noteKey
        : null;
    task.leaseExpiresAt = null;
    await this.persist();
    return { ...task };
  }

  /**
   * 任务失败：置 failed、记录错误信息、清除租约（attempts 保留，lastError 保留到下次重试）。
   * 已完成任务不允许标记为失败（笔记已写回，状态不可回退）。
   * 失败原因超长时抛中文错，调用方应先截断。
   */
  @traced
  async fail(id: string, errorMsg: string): Promise<Task> {
    const task = this.require(id);
    if (task.status === 'done') {
      throw new Error('已完成任务不能标记为失败');
    }
    const msg = String(errorMsg ?? '');
    if (msg.length > LIMITS.failReason) {
      throw new Error(`失败原因过长（最多 ${LIMITS.failReason} 字符）`);
    }
    task.status = 'failed';
    task.lastError = msg;
    task.leaseExpiresAt = null;
    await this.persist();
    return { ...task };
  }

  /**
   * 取消任务：非 done 的置 cancelled 并清除租约。
   * 已完成任务拒绝取消并抛中文错（FR-11：已完成任务和既有笔记默认保留）。
   */
  @traced
  async cancel(id: string): Promise<void> {
    const task = this.require(id);
    if (task.status === 'done') {
      throw new Error('已完成任务不能取消');
    }
    task.status = 'cancelled';
    task.leaseExpiresAt = null;
    await this.persist();
  }

  /**
   * 内部方法：按 id 领取指定任务（MCP 领取流程用，未列入 ITaskStore 接口）。
   * 仅当任务处于 pending 时才标记 claimed + 租约 + attempts+1 并返回；
   * 已被并发领取走时返回 null（调用方继续试下一条），不抛错。
   */
  @traced
  async claimById(id: string, leaseMs: number): Promise<Task | null> {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'pending') {
      return null;
    }
    // 防御：非法租约时长回退到偏好/默认值
    const safeLeaseMs =
      Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : getLeaseMs();
    const now = Date.now();
    task.status = 'claimed';
    task.leaseExpiresAt = now + safeLeaseMs;
    task.claimedAt = now;
    task.attempts += 1;
    await this.persist();
    return { ...task };
  }

  /**
   * 把已领取任务放回待领取（内部方法，未列入 ITaskStore 接口）：
   * 用于"技能组在领取瞬间被停用/归档"等竞态，放回后任务可被重新领取。
   * 只允许 claimed 状态；清除租约，attempts 保留（不算一次新的领取尝试）。
   */
  @traced
  async requeue(id: string): Promise<Task> {
    const task = this.require(id);
    if (task.status !== 'claimed') {
      throw new Error(`只有已领取任务可放回待领取，当前状态：${task.status}`);
    }
    task.status = 'pending';
    task.leaseExpiresAt = null;
    await this.persist();
    return { ...task };
  }

  /** 重试失败任务：failed → pending 并清空 lastError（attempts 保留）。非 failed 状态抛错。 */
  @traced
  async retry(id: string): Promise<void> {
    const task = this.require(id);
    if (task.status !== 'failed') {
      throw new Error(`只有失败任务可重试，当前状态：${task.status}`);
    }
    task.status = 'pending';
    task.lastError = null;
    await this.persist();
  }

  /**
   * 材料后到时调用：waiting-material → pending。
   * 非等待材料状态（或任务不存在时不存在抛错）返回 null。
   */
  @traced
  async promoteToPending(id: string): Promise<Task | null> {
    const task = this.require(id);
    if (task.status !== 'waiting-material') {
      return null;
    }
    task.status = 'pending';
    await this.persist();
    return { ...task };
  }

  /**
   * 按技能组返回各状态任务数（六种状态齐全，无任务的状态补 0），
   * 供界面计数（与明细一致：counts 直接按同一任务表统计）。
   */
  countsBySkill(skillGroupId: string): Record<TaskStatus, number> {
    const counts = {} as Record<TaskStatus, number>;
    for (const status of ALL_STATUSES) {
      counts[status] = 0;
    }
    for (const task of this.tasks.values()) {
      if (task.skillGroupId === skillGroupId && counts[task.status] !== undefined) {
        counts[task.status] += 1;
      }
    }
    return counts;
  }
}

/**
 * 校验并归一化从磁盘读到的任务记录。
 * 字段缺失时补默认值（保持向后兼容）；关键字段非法时返回 null（跳过该条）。
 */
function normalizeTask(item: unknown): Task | null {
  if (typeof item !== 'object' || item === null) {
    error('跳过非法任务记录（非对象）：', item);
    return null;
  }
  const raw = item as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.skillGroupId !== 'string' || typeof raw.itemKey !== 'string') {
    error('跳过非法任务记录（缺少关键字段）：', item);
    return null;
  }
  const status: TaskStatus = ALL_STATUSES.includes(raw.status as TaskStatus)
    ? (raw.status as TaskStatus)
    : 'pending';
  const now = Date.now();
  return {
    id: raw.id,
    skillGroupId: raw.skillGroupId,
    skillGroupVersion:
      typeof raw.skillGroupVersion === 'number' ? raw.skillGroupVersion : 1,
    instructionSnapshot:
      typeof raw.instructionSnapshot === 'string' ? raw.instructionSnapshot : '',
    itemKey: raw.itemKey,
    status,
    leaseExpiresAt:
      typeof raw.leaseExpiresAt === 'number' ? raw.leaseExpiresAt : null,
    attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    noteKey: typeof raw.noteKey === 'string' ? raw.noteKey : null,
    deliverableType:
      raw.deliverableType === 'note' ||
      raw.deliverableType === 'file' ||
      raw.deliverableType === 'markdown'
        ? raw.deliverableType
        : null,
    deliverableRef:
      typeof raw.deliverableRef === 'string' ? raw.deliverableRef : null,
    attachmentKey:
      typeof raw.attachmentKey === 'string' ? raw.attachmentKey : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    claimedAt: typeof raw.claimedAt === 'number' ? raw.claimedAt : null,
    completedAt:
      typeof raw.completedAt === 'number' ? raw.completedAt : null,
  };
}
