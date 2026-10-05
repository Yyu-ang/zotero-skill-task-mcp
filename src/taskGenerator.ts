/**
 * src/taskGenerator.ts — 模块 C：任务生成器（FR-04 / FR-05 + 需求 §5 PDF 规则）
 *
 * 职责：
 * - 全库 / 指定范围的初始扫描（scanSkillGroup / scanAllEnabled）
 * - Zotero 新增条目 / 新增附件后的增量判定（Notifier 观察者）
 * - 材料判定：需求 §5「dateAdded 最早的本地 PDF 附件」（resolveEarliestPdfPath）
 * - 任务唯一性去重（技能组 × 条目），以及 waiting-material → pending 的晋升
 *
 * 只依赖 types.ts 的接口契约（ISkillGroupStore / ITaskStore），
 * 不依赖任何具体实现类——具体类由别的模块实现，协调员在 core.ts 接线。
 */

import {
  ITaskGenerator,
  ISkillGroupStore,
  ITaskStore,
  ScanOptions,
  ScanResult,
  SkillGroup,
} from './types';
import { log, error } from './utils';
import { traced } from './utils/trace';
import { findChildAttachmentsByFilename } from './attachments';

/** 扫描分块大小：每块从 Zotero 一次加载的条目数 */
const SCAN_CHUNK_SIZE = 200;

/** Notifier 观察者 ID（调试输出用） */
const OBSERVER_ID = 'skilltask-generator';

/** 扫描计数器（ScanResult 的可变子集，扫描与增量路径共用） */
interface ScanCounters {
  created: number;
  skipped: number;
  waitingMaterial: number;
  promoted: number;
  completedExisting: number;
}

/** 全零扫描结果 */
function emptyScanResult(skillGroupId: string): ScanResult {
  return {
    skillGroupId,
    scanned: 0,
    created: 0,
    skipped: 0,
    waitingMaterial: 0,
    promoted: 0,
    completedExisting: 0,
  };
}

/**
 * 是否为书目父条目（任务只挂在父条目上，不为附件/笔记子条目建任务）。
 * 优先用 isRegularItem()；无此 API 时降级为「非附件且非笔记」。
 */
function isParentItem(item: any): boolean {
  if (!item) return false;
  if (typeof item.isRegularItem === 'function') {
    try {
      return !!item.isRegularItem();
    } catch {
      return false;
    }
  }
  const isAtt =
    typeof item.isAttachment === 'function' ? !!item.isAttachment() : false;
  const isNote = typeof item.isNote === 'function' ? !!item.isNote() : false;
  return !isAtt && !isNote;
}

/** 是否为附件条目 */
function isAttachmentItem(item: any): boolean {
  return !!item && typeof item.isAttachment === 'function' && !!item.isAttachment();
}

/**
 * 附件是否为 PDF（运行时守卫：优先 isPDFAttachment，不可用则看 contentType）。
 */
function isPdfAttachment(att: any): boolean {
  if (typeof att.isPDFAttachment === 'function') {
    try {
      if (att.isPDFAttachment()) return true;
    } catch {
      // 掉下去再看 contentType
    }
  }
  return att.attachmentContentType === 'application/pdf';
}

/**
 * 取附件的本地文件路径；无本地文件 / 不可读时返回 null。
 * 同步 getFilePath() 优先（便宜），拿不到再走异步 getFilePathAsync()。
 */
async function getLocalFilePath(att: any): Promise<string | null> {
  try {
    if (typeof att.getFilePath === 'function') {
      const p = att.getFilePath();
      if (typeof p === 'string' && p) return p;
    }
    if (typeof att.getFilePathAsync === 'function') {
      const p = await att.getFilePathAsync();
      if (typeof p === 'string' && p) return p;
    }
  } catch {
    // 路径解析失败视为不可读
  }
  return null;
}

/**
 * 需求 §5「首次添加的 PDF」判定：目标父条目下 dateAdded 最早的本地 PDF 附件；
 * 时间相同则按附件 key 稳定排序。无合格 PDF 时返回 null。
 *
 * 合格 = 是 PDF 且有本地可读文件。尚未下载、网络链接无本地文件、
 * 不可读的附件一律排除，且**不得静默改用其他文件**（直接返回 null，
 * 调用方据此把任务置为 waiting-material）。
 */
export async function resolveEarliestPdfPath(item: any): Promise<string | null> {
  try {
    const attIds: number[] =
      item && typeof item.getAttachments === 'function'
        ? item.getAttachments()
        : [];
    if (!attIds.length) return null;

    const atts = await Zotero.Items.getAsync(attIds);
    const candidates: Array<{ path: string; dateAdded: string; key: string }> =
      [];
    for (const att of atts) {
      if (!att) continue;
      try {
        if (!isPdfAttachment(att)) continue;
        const path = await getLocalFilePath(att);
        // 无本地文件 / 不可读：排除，不换文件
        if (!path) continue;
        candidates.push({
          path,
          dateAdded: typeof att.dateAdded === 'string' ? att.dateAdded : '',
          key: typeof att.key === 'string' ? att.key : '',
        });
      } catch (e) {
        // 单个附件判定失败：跳过该附件，不影响其他附件
        error('[TaskGenerator] 附件判定失败，已跳过:', att?.key, e);
      }
    }
    if (!candidates.length) return null;

    // dateAdded 升序；相同按 key 稳定排序，保证多次运行结果一致
    candidates.sort((a, b) => {
      if (a.dateAdded !== b.dateAdded)
        return a.dateAdded < b.dateAdded ? -1 : 1;
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return 0;
    });
    return candidates[0].path;
  } catch (e) {
    error('[TaskGenerator] resolveEarliestPdfPath 失败:', item?.key, e);
    return null;
  }
}

export class TaskGenerator implements ITaskGenerator {
  private readonly skillGroups: ISkillGroupStore;
  private readonly tasks: ITaskStore;
  private observerId: string | null = null;
  /**
   * 插件存活检查（需求单 需求4：由 core.ts 传入 () => core.alive）。
   * notifier 是长驻回调：触发时若插件已卸载，自注销并直接返回。
   */
  private readonly isAliveFn: (() => boolean) | null;
  /**
   * 扫描并发 guard（service 层第二道；面板侧另有 scanBusy 第一道）：
   * 同一技能组同时只允许一次扫描，防止并发扫描在"去重检查→创建"之间
   * 的 await 间隙重复建任务，破坏"技能组 × 条目"唯一性。
   */
  private readonly scanLocks = new Set<string>();

  constructor(deps: {
    skillGroups: ISkillGroupStore;
    tasks: ITaskStore;
    /** 可选：插件存活检查（core.ts 传入；缺省时不做守卫） */
    isAlive?: () => boolean;
  }) {
    this.skillGroups = deps.skillGroups;
    this.tasks = deps.tasks;
    this.isAliveFn = deps.isAlive ?? null;
  }

  // ──────────── 扫描 ────────────

  /**
   * 扫描单个技能组：枚举全库父条目，逐条做「范围匹配 → 去重/晋升 → 创建」。
   * 技能组不存在 / 已归档 / 已停用时返回全零结果，不生成任何任务。
   * 支持 AbortSignal 中断：扫描本身幂等，中断后重跑可续（已创建的不重复）。
   */
  @traced
  async scanSkillGroup(
    skillGroupId: string,
    opts: ScanOptions = {},
  ): Promise<ScanResult> {
    const result = emptyScanResult(skillGroupId);
    const sg = this.skillGroups.get(skillGroupId);
    if (!sg || sg.archived || !sg.enabled) {
      log('[TaskGenerator] 跳过扫描（不存在/已归档/已停用）:', skillGroupId);
      return result;
    }
    if (this.scanLocks.has(skillGroupId)) {
      throw new Error('该技能组正在扫描中，请稍候再试');
    }
    // 扫描依赖的 Zotero API 不可用时直接报中文错（面板侧展示），不静默空跑
    const Z: any = (globalThis as any).Zotero;
    if (
      !Z?.Search ||
      typeof Z?.Items?.getAsync !== 'function' ||
      !Z?.Libraries
    ) {
      throw new Error('扫描失败：Zotero 条目 API 不可用');
    }

    this.scanLocks.add(skillGroupId);
    try {
      return await this.runScan(sg, opts, result);
    } finally {
      this.scanLocks.delete(skillGroupId);
    }
  }

  /**
   * 扫描主体（scanSkillGroup 加锁后调用）：枚举全库父条目，
   * 逐条做「范围匹配 → 去重/晋升 → 创建」。
   */
  private async runScan(
    sg: SkillGroup,
    opts: ScanOptions,
    result: ScanResult,
  ): Promise<ScanResult> {
    const Z: any = (globalThis as any).Zotero;
    // 枚举全库候选条目（等价于任务书的 s.libraryID = userLibraryID 写法，
    // types 里 libraryID 是只读属性，故用构造参数传入）
    const search = new Z.Search({
      libraryID: Z.Libraries.userLibraryID,
    });
    const ids = await search.search();
    const total = ids.length;
    log(`[TaskGenerator] 开始扫描技能组「${sg.name}」，候选条目 ${total}`);

    for (let i = 0; i < ids.length; i += SCAN_CHUNK_SIZE) {
      if (opts.signal?.aborted) {
        log('[TaskGenerator] 扫描被中断，已处理部分保留，重跑可续');
        return result;
      }
      const chunk = ids.slice(i, i + SCAN_CHUNK_SIZE);
      const items = await Z.Items.getAsync(chunk);
      for (const item of items) {
        if (!isParentItem(item)) continue;
        if (opts.signal?.aborted) {
          log('[TaskGenerator] 扫描被中断，已处理部分保留，重跑可续');
          return result;
        }
        await this.processItemForSkillGroup(sg, item, result);
        result.scanned++;
      }
      opts.onProgress?.(Math.min(i + chunk.length, total), total);
    }

    log(
      `[TaskGenerator] 扫描完成「${sg.name}」: scanned=${result.scanned} ` +
        `created=${result.created} skipped=${result.skipped} ` +
        `waitingMaterial=${result.waitingMaterial} promoted=${result.promoted} ` +
        `completedExisting=${result.completedExisting}`,
    );
    return result;
  }

  /** 逐个扫描所有启用且未归档的技能组 */
  @traced
  async scanAllEnabled(opts: ScanOptions = {}): Promise<ScanResult[]> {
    const results: ScanResult[] = [];
    for (const sg of this.enabledSkillGroups()) {
      if (opts.signal?.aborted) break;
      results.push(await this.scanSkillGroup(sg.id, opts));
    }
    return results;
  }

  // ──────────── 增量通知 ────────────

  /** 注册条目新增观察者（插件启动时调用一次） */
  registerNotifier(): void {
    if (this.observerId) {
      log('[TaskGenerator] 观察者已注册，跳过');
      return;
    }
    // 防御：Notifier API 不可用时降级为仅手动扫描，不抛错中断启动
    const Z: any = (globalThis as any).Zotero;
    if (typeof Z?.Notifier?.registerObserver !== 'function') {
      log('[TaskGenerator] Notifier API 不可用，跳过观察者注册（仅支持手动扫描）');
      return;
    }
    const id = Z.Notifier.registerObserver(
      {
        notify: async (
          event: string,
          _type: string,
          ids: Array<string | number>,
          _extraData: any
        ) => {
          // 需求4：长驻回调存活守卫 —— 插件已卸载则自注销并直接返回
          if (this.isAliveFn && !this.isAliveFn()) {
            try {
              Z.Notifier.unregisterObserver(id);
            } catch {
              // ignore
            }
            this.observerId = null;
            return;
          }
          if (event !== 'add') return;
          await this.handleItemsAdded(ids);
        },
      },
      ['item'],
      OBSERVER_ID,
    );
    this.observerId = id;
    log('[TaskGenerator] 观察者已注册:', id);
  }

  /** 取消注册（插件关闭时调用） */
  unregisterNotifier(): void {
    if (!this.observerId) return;
    try {
      Zotero.Notifier.unregisterObserver(this.observerId);
    } catch (e) {
      error('[TaskGenerator] 取消观察者失败:', e);
    } finally {
      this.observerId = null;
    }
    log('[TaskGenerator] 观察者已取消注册');
  }

  // ──────────── 内部逻辑 ────────────

  /** 启用且未归档的技能组 */
  private enabledSkillGroups(): SkillGroup[] {
    return this.skillGroups.list(true).filter((sg) => sg.enabled && !sg.archived);
  }

  /**
   * 单条处理：范围匹配 → 唯一性去重/晋升 → 材料判定 → 创建。
   * 内部消化异常，单条失败不中断整体扫描/通知。
   */
  private async processItemForSkillGroup(
    sg: SkillGroup,
    item: any,
    counters: ScanCounters,
  ): Promise<void> {
    try {
      // 防御：条目 key 非法（缺失/非字符串）直接跳过，避免污染任务表
      const itemKey: string =
        typeof item?.key === 'string' && item.key ? item.key : '';
      if (!itemKey) {
        return;
      }

      // 1. 范围匹配
      const inScope = await this.skillGroups.matchesScope(sg, item);
      if (!inScope) return;

      // 2. 已完成任务保持幂等：重复扫描不为同一技能组×条目再造任务
      const latest = this.tasks.findLatestBySkillAndItem(sg.id, itemKey);
      if (latest?.status === 'done') {
        counters.skipped++;
        return;
      }

      // 3. 若配置了固定附件名 + skip 策略，已有同名附件直接视为完成
      const existingAttachment = await this.findExistingDeliverableAttachment(sg, item);
      if (existingAttachment) {
        const dtype =
          sg.deliverable.type === 'markdown' ? 'markdown' : 'file';
        const targetName =
          sg.deliverable.type === 'file'
            ? sg.deliverable.targetFileName!
            : sg.deliverable.targetFileName!;
        const existingActive = this.tasks.findActiveBySkillAndItem(sg.id, itemKey);
        if (existingActive) {
          await this.tasks.complete(existingActive.id, {
            noteKey: null,
            deliverableType: dtype,
            deliverableRef: targetName,
            attachmentKey:
              typeof existingAttachment.key === 'string'
                ? existingAttachment.key
                : null,
          });
        } else {
          await this.tasks.createCompleted(
            {
              skillGroupId: sg.id,
              skillGroupVersion: sg.version,
              instructionSnapshot: sg.instruction,
              itemKey,
            },
            {
              noteKey: null,
              deliverableType: dtype,
              deliverableRef: targetName,
              attachmentKey:
                typeof existingAttachment.key === 'string'
                  ? existingAttachment.key
                  : null,
            }
          );
        }
        counters.completedExisting++;
        return;
      }

      // 4. 唯一性去重：同一「技能组 × 条目」最多一条有效任务
      const existing = this.tasks.findActiveBySkillAndItem(sg.id, itemKey);
      if (existing) {
        if (existing.status === 'waiting-material') {
          // FR-05：材料可能后到，重新判定；齐了就晋升为待领取
          if (await this.materialsReady(sg, item)) {
            const promoted = await this.tasks.promoteToPending(existing.id);
            if (promoted) {
              counters.promoted++;
              return;
            }
          }
        }
        counters.skipped++;
        return;
      }

      // 5. 材料判定 → 创建任务
      const ready = await this.materialsReady(sg, item);
      const status = ready ? 'pending' : 'waiting-material';
      await this.tasks.create({
        skillGroupId: sg.id,
        skillGroupVersion: sg.version,
        instructionSnapshot: sg.instruction,
        itemKey,
        status,
      });
      if (ready) {
        counters.created++;
      } else {
        counters.waitingMaterial++;
      }
    } catch (e) {
      error('[TaskGenerator] 单条处理失败，已跳过:', sg.id, item?.key, e);
    }
  }

  /**
   * 仅当交付物会挂成附件、配置了固定目标文件名，且同名策略为 skip 时，
   * 扫描才可根据既有附件直接判定任务已完成。
   */
  private async findExistingDeliverableAttachment(
    sg: SkillGroup,
    item: any
  ): Promise<any | null> {
    const d = sg.deliverable;
    const targetName =
      d.type === 'file'
        ? d.targetFileName
        : d.type === 'markdown' && d.target === 'file'
          ? d.targetFileName
          : undefined;
    const attach =
      d.type === 'file'
        ? !!d.attachToItem
        : d.type === 'markdown' && d.target === 'file'
          ? !!d.attachToItem
          : false;
    const policy =
      d.type === 'file' || (d.type === 'markdown' && d.target === 'file')
        ? d.existingAttachmentPolicy ?? 'skip'
        : undefined;
    if (!attach || !targetName || policy !== 'skip') return null;
    const matches = await findChildAttachmentsByFilename(item, targetName);
    return matches[0] ?? null;
  }

  /**
   * 材料是否齐备：pdf==='none' 时恒齐；否则要求能解析出最早的本地 PDF。
   */
  private async materialsReady(sg: SkillGroup, item: any): Promise<boolean> {
    if (sg.materials.pdf === 'none') return true;
    return (await resolveEarliestPdfPath(item)) !== null;
  }

  /** Notifier 'add' 事件：批量加载后逐条处理，单条失败不中断整体 */
  private async handleItemsAdded(ids: Array<string | number>): Promise<void> {
    if (!ids || !ids.length) return;
    let items: any[];
    try {
      // getAsync 的重载只接受纯 string[] 或纯 number[]，混合数组先分流
      const strIds: string[] = [];
      const numIds: number[] = [];
      for (const id of ids) {
        if (typeof id === 'string') strIds.push(id);
        else if (typeof id === 'number') numIds.push(id);
      }
      const loaded = await Promise.all([
        numIds.length ? Zotero.Items.getAsync(numIds) : [],
        strIds.length ? Zotero.Items.getAsync(strIds) : [],
      ]);
      items = loaded.flat();
    } catch (e) {
      error('[TaskGenerator] 加载新增条目失败:', e);
      return;
    }
    for (const item of items) {
      if (!item) continue;
      try {
        await this.handleAddedItem(item);
      } catch (e) {
        error('[TaskGenerator] 新增条目处理失败，已跳过:', item?.key, e);
      }
    }
  }

  /** 单个新增条目的增量判定 */
  private async handleAddedItem(item: any): Promise<void> {
    if (isParentItem(item)) {
      // 父条目：对每个启用未归档技能组做「匹配 → 去重/晋升 → 创建」
      const counters: ScanCounters = {
        created: 0,
        skipped: 0,
        waitingMaterial: 0,
        promoted: 0,
        completedExisting: 0,
      };
      for (const sg of this.enabledSkillGroups()) {
        await this.processItemForSkillGroup(sg, item, counters);
      }
      if (
        counters.created > 0 ||
        counters.promoted > 0 ||
        counters.completedExisting > 0
      ) {
        log(
          `[TaskGenerator] 新增条目 ${item.key}: ` +
            `created=${counters.created} promoted=${counters.promoted} ` +
            `waitingMaterial=${counters.waitingMaterial} ` +
            `completedExisting=${counters.completedExisting}`,
        );
      }
      return;
    }
    if (isAttachmentItem(item)) {
      // 附件条目：可能是等待材料的 PDF 后到了，重新判定其父条目
      await this.handleAddedAttachment(item);
    }
    // 笔记等其他类型：忽略
  }

  /**
   * 附件新增：取 parentID 得父条目，对该父条目的 waiting-material 任务
   * 重新判定材料，齐了就晋升为待领取（FR-05 材料后到路径）。
   */
  private async handleAddedAttachment(att: any): Promise<void> {
    const parentID = (att as { parentID?: unknown }).parentID;
    if (typeof parentID !== 'number' || parentID <= 0) return;
    let parent: any;
    try {
      parent = await Zotero.Items.getAsync(parentID);
    } catch (e) {
      error('[TaskGenerator] 加载附件父条目失败:', att?.key, e);
      return;
    }
    if (!parent || !isParentItem(parent)) return;

    const counters: ScanCounters = {
      created: 0,
      skipped: 0,
      waitingMaterial: 0,
      promoted: 0,
      completedExisting: 0,
    };
    for (const sg of this.enabledSkillGroups()) {
      await this.processItemForSkillGroup(sg, parent, counters);
    }
    if (
      counters.promoted > 0 ||
      counters.created > 0 ||
      counters.completedExisting > 0
    ) {
      log(
        `[TaskGenerator] 附件变更触发父条目重判 ${parent.key}: ` +
          `created=${counters.created} promoted=${counters.promoted} ` +
          `completedExisting=${counters.completedExisting}`
      );
    }
  }
}
