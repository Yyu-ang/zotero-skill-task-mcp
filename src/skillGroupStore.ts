/**
 * src/skillGroupStore.ts — 模块 A：技能组存储（FR-01 / FR-02）
 *
 * 负责技能组数据的增删改查、持久化与范围判定：
 * - 持久化：JSON 文件，存放在 Zotero 数据目录下 DATA_DIR_NAME 目录中
 *   （PathUtils.join(Zotero.DataDirectory.dir, DATA_DIR_NAME, 'skill-groups.json')）
 * - 所有变更方法写穿（write-through），立即落盘
 * - 范围判定 matchesScope 支持"全库"与"指定集合（含/不含子集合）"
 *
 * 只依赖 Zotero 8+ 官方 API（IOUtils / PathUtils / Zotero.Collections），
 * 官方类型一律以 node_modules/zotero-types 为准，原生 Promise。
 *
 * 注意：Zotero 官方 API item.getCollections() 返回的是集合内部 ID（number[]），
 * 不是集合 key；因此范围判定走"配置 key → 内部 ID（含子集合展开）→ 求交集"路径。
 */

import {
  DATA_DIR_NAME,
  ISkillGroupStore,
  SkillAssetFile,
  SkillAssetUpload,
  SkillGroup,
  SkillGroupCreateData,
  SkillGroupPatch,
  uid,
} from './types';
import { LIMITS, log, error, truncateForDisplay } from './utils';
import { traced } from './utils/trace';
import { assertValidDeliverable } from './deliverables';

/** 持久化文件名 */
const FILE_NAME = 'skill-groups.json';
const SKILLS_DIR_NAME = 'skills';
const SKILL_FILE_NAME = 'SKILL.md';
const REFERENCES_DIR_NAME = 'references';

/** 深拷贝：保护内存中的内部状态不被调用方篡改 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 校验技能组名称：非空 + 长度上限，返回 trim 后的值 */
function assertValidName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new Error('技能组名称不能为空');
  }
  if (trimmed.length > LIMITS.skillGroupName) {
    throw new Error(`技能组名称过长（最多 ${LIMITS.skillGroupName} 字符）`);
  }
  return trimmed;
}

/** 校验任务指令：非空 + 长度上限，返回 trim 后的值 */
function assertValidInstruction(instruction: unknown): string {
  const trimmed = typeof instruction === 'string' ? instruction.trim() : '';
  if (!trimmed) {
    throw new Error('任务指令不能为空');
  }
  if (trimmed.length > LIMITS.instruction) {
    throw new Error(`任务指令过长（最多 ${LIMITS.instruction} 字符）`);
  }
  return trimmed;
}

function assertOptionalText(value: unknown, max: number, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) {
    throw new Error(`${label}过长（最多 ${max} 字符）`);
  }
  return text;
}

function sanitizeAssetName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error('参考文件名必须是字符串');
  }
  let base = name.split(/[\\/]/).pop()?.trim() ?? '';
  base = base.replace(/^\.+/, '');
  base = base.replace(/[^\p{L}\p{N}._\- ()\[\]]/gu, '_');
  base = base.replace(/_{2,}/g, '_').replace(/\.{2,}/g, '.');
  if (!base || base === '.' || base === '..') {
    throw new Error('参考文件名无效');
  }
  if (base.length > 180) {
    throw new Error('参考文件名过长（最多 180 字符）');
  }
  return base;
}

/**
 * 将面板窗口/MCP 等其他 JS realm 传入的 Uint8Array 正规化到插件核心 realm。
 * 不能使用 `instanceof Uint8Array`：跨窗口 TypedArray 会被误判为 false。
 */
function normalizeUploadBytes(value: unknown, emptyMessage: string): Uint8Array {
  const src = value as
    | {
        byteLength?: number;
        byteOffset?: number;
        length?: number;
        buffer?: ArrayBufferLike;
        [index: number]: number;
      }
    | undefined;

  const byteLength =
    typeof src?.byteLength === 'number'
      ? src.byteLength
      : typeof src?.length === 'number'
        ? src.length
        : 0;

  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new Error(emptyMessage);
  }

  // 主路径：TypedArray/DataView（包括来自另一个 window realm 的对象）
  try {
    if (src?.buffer) {
      const offset =
        typeof src.byteOffset === 'number' && Number.isFinite(src.byteOffset)
          ? src.byteOffset
          : 0;
      const local = new Uint8Array(src.buffer, offset, byteLength);
      return new Uint8Array(local);
    }
  } catch {
    // 继续走 ArrayLike 降级路径
  }

  // 降级：普通 ArrayLike<number>
  try {
    const local = Uint8Array.from(src as ArrayLike<number>);
    if (local.byteLength > 0) return local;
  } catch {
    // fall through
  }

  throw new Error(emptyMessage);
}

/** 校验范围配置：类型合法；指定集合时至少选一个集合 */
function assertValidScope(scope: unknown): void {
  const s = scope as SkillGroup['scope'] | undefined;
  if (!s || (s.type !== 'all' && s.type !== 'collections')) {
    throw new Error('技能组范围配置无效');
  }
  if (s.type === 'collections') {
    const keys = Array.isArray(s.collectionKeys)
      ? s.collectionKeys.filter(
          (k): k is string => typeof k === 'string' && k.length > 0
        )
      : [];
    if (keys.length === 0) {
      throw new Error('指定集合范围至少选择一个集合');
    }
  }
}

/**
 * 技能组存储。构造器私有，请用 SkillGroupStore.load() 创建实例。
 */
export class SkillGroupStore implements ISkillGroupStore {
  private groups: SkillGroup[] = [];
  private readonly path: string;
  private readonly skillsDir: string;
  /**
   * 持久化写队列：串行化落盘（同 taskStore：并发 persist 共用临时文件会互相覆盖）。
   */
  private persistQueue: Promise<void> = Promise.resolve();

  private constructor(path: string, skillsDir: string, groups: SkillGroup[]) {
    this.path = path;
    this.skillsDir = skillsDir;
    this.groups = groups;
  }

  // ──────────── 生命周期 ────────────

  /**
   * 加载存储：建数据目录（已存在则忽略）+ 读 JSON 文件。
   * 文件不存在（新安装）视为空数组；文件损坏则记日志并从空开始，
   * 避免插件启动失败。
   */
  static async load(): Promise<SkillGroupStore> {
    const dir = PathUtils.join(Zotero.DataDirectory.dir, DATA_DIR_NAME);
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const path = PathUtils.join(dir, FILE_NAME);
    const skillsDir = PathUtils.join(dir, SKILLS_DIR_NAME);
    await IOUtils.makeDirectory(skillsDir, { ignoreExisting: true });

    let data: unknown = [];
    try {
      data = await IOUtils.readJSON(path);
    } catch (e: any) {
      // 文件不存在是正常情况（首次使用）；其他错误也记日志后从空开始
      log(`技能组数据文件读取失败，视为空数组: ${path}`, e?.message ?? e);
      data = [];
    }

    const groups: SkillGroup[] = Array.isArray(data)
      ? data
          .filter((g: any) => g && typeof g === 'object' && typeof g.id === 'string')
          .map((g: any) => ({
            ...g,
            description: typeof g.description === 'string' ? g.description : '',
            referencesEnabled: g.referencesEnabled === true,
            referencesDescription:
              typeof g.referencesDescription === 'string'
                ? g.referencesDescription
                : '',
          }))
      : [];
    return new SkillGroupStore(path, skillsDir, groups);
  }

  /** 数据文件完整路径（调试/测试用） */
  getFilePath(): string {
    return this.path;
  }

  // ──────────── 查询 ────────────

  list(includeArchived: boolean = false): SkillGroup[] {
    const list = includeArchived
      ? this.groups
      : this.groups.filter((g) => !g.archived);
    return clone(list);
  }

  get(id: string): SkillGroup | undefined {
    const found = this.groups.find((g) => g.id === id);
    return found ? clone(found) : undefined;
  }

  // ──────────── 变更（全部写穿落盘） ────────────

  @traced
  async create(data: SkillGroupCreateData): Promise<SkillGroup> {
    // store 层校验（面板侧已有校验，这里是第二道防线，错误为中文可直接展示）
    const name = assertValidName(data.name);
    const description = assertOptionalText(
      data.description,
      LIMITS.skillDescription,
      '技能说明'
    );
    const instruction = assertValidInstruction(data.instruction);
    const referencesDescription = assertOptionalText(
      data.referencesDescription,
      LIMITS.referencesDescription,
      '参考资料说明'
    );
    assertValidScope(data.scope);
    const deliverable = assertValidDeliverable(data.deliverable);

    const now = Date.now();
    const sg: SkillGroup = {
      id: uid(),
      name,
      description,
      instruction,
      referencesEnabled: data.referencesEnabled === true,
      referencesDescription,
      enabled: true,
      archived: false,
      version: 1,
      scope: clone(data.scope),
      materials: clone(data.materials),
      deliverable,
      createdAt: now,
      updatedAt: now,
    };
    this.groups.push(sg);
    await IOUtils.makeDirectory(this.skillDir(sg.id), { ignoreExisting: true });
    if (sg.referencesEnabled) {
      await this.ensureReferencesDir(sg.id);
    }
    await this.persist();
    return clone(sg);
  }

  @traced
  async update(id: string, patch: SkillGroupPatch): Promise<SkillGroup> {
    const sg = this.findOrThrow(id);

    // 只允许修改白名单字段，忽略其余字段
    if (patch.name !== undefined) {
      sg.name = assertValidName(patch.name);
    }
    if (patch.description !== undefined) {
      sg.description = assertOptionalText(
        patch.description,
        LIMITS.skillDescription,
        '技能说明'
      );
    }
    if (patch.instruction !== undefined) {
      sg.instruction = assertValidInstruction(patch.instruction);
    }
    if (patch.referencesEnabled !== undefined) {
      sg.referencesEnabled = !!patch.referencesEnabled;
      if (sg.referencesEnabled) {
        await this.ensureReferencesDir(sg.id);
      }
    }
    if (patch.referencesDescription !== undefined) {
      sg.referencesDescription = assertOptionalText(
        patch.referencesDescription,
        LIMITS.referencesDescription,
        '参考资料说明'
      );
    }
    if (patch.scope !== undefined) {
      assertValidScope(patch.scope);
      sg.scope = clone(patch.scope);
    }
    if (patch.materials !== undefined) {
      sg.materials = clone(patch.materials);
    }
    if (patch.deliverable !== undefined) {
      sg.deliverable = assertValidDeliverable(patch.deliverable);
    }

    sg.version += 1;
    sg.updatedAt = Date.now();
    await this.persist();
    return clone(sg);
  }

  @traced
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const sg = this.findOrThrow(id);
    if (sg.enabled === enabled) {
      return; // 幂等：状态未变化时不写盘、不更新 updatedAt
    }
    sg.enabled = enabled;
    sg.updatedAt = Date.now();
    await this.persist();
  }

  @traced
  async copy(id: string): Promise<SkillGroup> {
    const src = this.findOrThrow(id);
    const now = Date.now();
    const sg: SkillGroup = {
      ...clone(src),
      id: uid(),
      // 副本名称加后缀；超长时截断以符合长度上限
      name: `${src.name} 副本`.slice(0, LIMITS.skillGroupName),
      // 副本从 version=1 重新开始；归档的源不直接带出"已归档"状态
      version: 1,
      enabled: src.enabled && !src.archived,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.copySkillAssets(src.id, sg.id);
    this.groups.push(sg);
    await this.persist();
    return clone(sg);
  }

  @traced
  async archive(id: string): Promise<void> {
    const sg = this.findOrThrow(id);
    // 归档 = 软删除：不再生成新任务（生成器只扫描 enabled && !archived）
    sg.archived = true;
    sg.enabled = false;
    sg.updatedAt = Date.now();
    await this.persist();
  }

  @traced
  async remove(id: string): Promise<void> {
    const sg = this.findOrThrow(id);
    if (!sg.archived) {
      throw new Error('只能删除已归档的技能组，请先归档');
    }
    const idx = this.groups.indexOf(sg);
    this.groups.splice(idx, 1);
    await IOUtils.remove(this.skillDir(id), {
      recursive: true,
      ignoreAbsent: true,
    });
    await this.persist();
  }

  // ──────────── 技能文件 / references ────────────

  async getAssetManifest(id: string) {
    this.findOrThrow(id);
    const skillDir = this.skillDir(id);
    const skillPath = PathUtils.join(skillDir, SKILL_FILE_NAME);
    const referencesDir = PathUtils.join(skillDir, REFERENCES_DIR_NAME);

    let skillFile: SkillAssetFile | null = null;
    if (await IOUtils.exists(skillPath)) {
      const stat = await IOUtils.stat(skillPath);
      skillFile = {
        name: SKILL_FILE_NAME,
        path: skillPath,
        size: Number(stat.size ?? 0),
      };
    }

    const references: SkillAssetFile[] = [];
    if (await IOUtils.exists(referencesDir)) {
      for (const child of await IOUtils.getChildren(referencesDir)) {
        try {
          const stat = await IOUtils.stat(child);
          if (stat.type === 'directory') continue;
          references.push({
            name: PathUtils.filename(child),
            path: child,
            size: Number(stat.size ?? 0),
          });
        } catch {
          // 单个损坏/消失文件不影响其余清单
        }
      }
      references.sort((a, b) => a.name.localeCompare(b.name));
    }

    return { skillGroupId: id, skillDir, skillFile, referencesDir, references };
  }

  async writeSkillFile(id: string, bytes: Uint8Array): Promise<SkillAssetFile> {
    this.findOrThrow(id);
    const localBytes = normalizeUploadBytes(bytes, 'SKILL.md 文件为空');
    const dir = this.skillDir(id);
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const path = PathUtils.join(dir, SKILL_FILE_NAME);
    await IOUtils.write(path, localBytes);
    return { name: SKILL_FILE_NAME, path, size: localBytes.byteLength };
  }

  async writeReferenceFiles(
    id: string,
    files: SkillAssetUpload[]
  ): Promise<SkillAssetFile[]> {
    this.findOrThrow(id);
    const dir = await this.ensureReferencesDir(id);
    const written: SkillAssetFile[] = [];
    for (const input of files) {
      const name = sanitizeAssetName(input?.name);
      const localBytes = normalizeUploadBytes(
        input?.bytes,
        `参考文件为空：${String(input?.name ?? '')}`
      );
      const path = PathUtils.join(dir, name);
      await IOUtils.write(path, localBytes);
      written.push({ name, path, size: localBytes.byteLength });
    }
    return written;
  }

  async removeReferenceFile(id: string, name: string): Promise<void> {
    this.findOrThrow(id);
    const safe = sanitizeAssetName(name);
    const path = PathUtils.join(this.skillDir(id), REFERENCES_DIR_NAME, safe);
    await IOUtils.remove(path, { ignoreAbsent: true });
  }

  private skillDir(id: string): string {
    return PathUtils.join(this.skillsDir, id);
  }

  private async ensureReferencesDir(id: string): Promise<string> {
    const skillDir = this.skillDir(id);
    await IOUtils.makeDirectory(skillDir, { ignoreExisting: true });
    const referencesDir = PathUtils.join(skillDir, REFERENCES_DIR_NAME);
    await IOUtils.makeDirectory(referencesDir, { ignoreExisting: true });
    return referencesDir;
  }

  private async copySkillAssets(sourceId: string, targetId: string): Promise<void> {
    const src = this.skillDir(sourceId);
    if (!(await IOUtils.exists(src))) return;

    const dest = this.skillDir(targetId);
    await IOUtils.makeDirectory(dest, { ignoreExisting: true });

    const srcSkill = PathUtils.join(src, SKILL_FILE_NAME);
    if (await IOUtils.exists(srcSkill)) {
      await IOUtils.copy(srcSkill, PathUtils.join(dest, SKILL_FILE_NAME));
    }

    const srcRefs = PathUtils.join(src, REFERENCES_DIR_NAME);
    if (await IOUtils.exists(srcRefs)) {
      const destRefs = PathUtils.join(dest, REFERENCES_DIR_NAME);
      await IOUtils.makeDirectory(destRefs, { ignoreExisting: true });
      for (const child of await IOUtils.getChildren(srcRefs)) {
        try {
          const stat = await IOUtils.stat(child);
          if (stat.type === 'directory') continue;
          await IOUtils.copy(
            child,
            PathUtils.join(destRefs, PathUtils.filename(child))
          );
        } catch {
          // 单个参考文件复制失败不阻止技能组副本创建
        }
      }
    }
  }

  // ──────────── 范围判定（FR-02） ────────────

  /**
   * 条目是否命中技能组范围。
   * - scope.type === 'all'：直接命中
   * - 'collections'：条目的所属集合与"配置集合（按开关展开子集合）"求交集
   * - 只判定书目父条目：附件/笔记等非父条目直接返回 false
   *
   * 注意：多集合命中仍只返回一次命中（布尔值），"一个技能组 × 一条目只生成一条任务"
   * 的唯一性由任务生成器保证。
   */
  async matchesScope(sg: SkillGroup, item: any): Promise<boolean> {
    if (!sg || !item) {
      return false;
    }
    // 防御：持久化数据损坏导致 scope 缺失时直接判为不命中，不抛错
    if (!sg.scope) {
      return false;
    }
    // 全库范围直接命中
    if (sg.scope.type === 'all') {
      return true;
    }
    if (sg.scope.type !== 'collections') {
      return false;
    }

    // 只判定书目父条目（官方 API：isRegularItem；缺失时退化为"非附件且非笔记"）
    const isParent: boolean =
      typeof item.isRegularItem === 'function'
        ? item.isRegularItem()
        : !(item.isAttachment?.() || item.isNote?.());
    if (!isParent) {
      return false;
    }

    const keys: string[] = Array.isArray(sg.scope.collectionKeys)
      ? sg.scope.collectionKeys
      : [];
    if (keys.length === 0) {
      return false;
    }

    // 条目所属集合（官方 API 返回内部 ID 数组）
    const itemCollectionIds: number[] =
      typeof item.getCollections === 'function'
        ? item.getCollections() ?? []
        : [];

    // 主路径：官方 API —— 配置 key → 内部 ID；includeSubcollections 时用
    // Zotero.Collections.getByParent(id, true) 展开"自身 + 所有后代集合"，再求交集
    const includeSubs = sg.scope.includeSubcollections !== false; // 默认 true
    if (this.canUseCollectionAPIs()) {
      try {
        const targetIds = this.expandScopeIDs(sg, item, keys, includeSubs);
        if (targetIds.size === 0) {
          return false;
        }
        return itemCollectionIds.some((id) => targetIds.has(id));
      } catch (e) {
        error('技能组范围判定失败，降级为直接成员判定', e);
      }
    }

    // ── 降级路径（子集合展开 API 不可用时）：仅做直接成员判定 ──
    // 先把条目的集合 ID 反查为 key 再与配置 key 求交集；
    // 反查也不行时，直接按原始值比对（兼容 getCollections 返回 key 的实现）。
    return this.directMembershipFallback(keys, itemCollectionIds);
  }

  // ──────────── 内部方法 ────────────

  /** 查找技能组，不存在则抛中文错误（id 超长时截断展示） */
  private findOrThrow(id: string): SkillGroup {
    const sg = this.groups.find((g) => g.id === id);
    if (!sg) {
      throw new Error(`技能组不存在: ${truncateForDisplay(id)}`);
    }
    return sg;
  }

  /** 写穿落盘（IOUtils.writeJSON 默认原子写：先写临时文件再重命名；经队列串行） */
  private async persist(): Promise<void> {
    const run: Promise<unknown> = this.persistQueue.then(() =>
      IOUtils.writeJSON(this.path, this.groups)
    );
    this.persistQueue = run.then(
      () => undefined,
      () => undefined
    );
    await run;
  }

  /** 子集合展开所需的官方 API 是否可用 */
  private canUseCollectionAPIs(): boolean {
    const cols: any = Zotero?.Collections;
    return (
      !!cols &&
      typeof cols.getIDFromLibraryAndKey === 'function' &&
      typeof cols.getByParent === 'function'
    );
  }

  /**
   * 把配置的集合 key 展开为"内部 ID 集合"：
   * 每个配置集合自身 ID +（includeSubcollections 时）所有后代集合的 ID。
   * 配置的集合若已被删除（查不到 ID），跳过。
   */
  private expandScopeIDs(
    sg: SkillGroup,
    item: any,
    keys: string[],
    includeSubcollections: boolean
  ): Set<number> {
    const ids = new Set<number>();
    const cols: any = Zotero.Collections;
    const libraryID: number = item.libraryID ?? Zotero?.Libraries?.userLibraryID;

    for (const key of keys) {
      let id: number | false = false;
      try {
        id = cols.getIDFromLibraryAndKey(libraryID, key);
      } catch {
        // 集合不存在或 API 异常，视为已删除，跳过
        id = false;
      }
      if (id === false || id == null) {
        continue;
      }
      ids.add(id);
      if (includeSubcollections) {
        // getByParent(parentID, recursive=true) 返回所有后代集合
        const descendants: any[] = cols.getByParent(id, true) ?? [];
        for (const d of descendants) {
          if (d && typeof d.id === 'number') {
            ids.add(d.id);
          }
        }
      }
    }
    return ids;
  }

  /**
   * 降级路径：子集合展开 API 不可用时的直接成员判定。
   * 注：此处不做子集合展开，仅判断条目是否直接属于配置集合之一。
   */
  private directMembershipFallback(
    keys: string[],
    itemCollectionIds: number[]
  ): boolean {
    const cols: any = Zotero?.Collections;

    // 先尝试把条目的集合 ID 反查为 key
    if (cols && typeof cols.get === 'function') {
      const itemKeys = new Set<string>();
      for (const cid of itemCollectionIds) {
        try {
          const c = cols.get(cid);
          if (c && c.key) {
            itemKeys.add(c.key);
          }
        } catch {
          // 单个集合查不到不影响其他
        }
      }
      if (itemKeys.size > 0) {
        return keys.some((k) => itemKeys.has(k));
      }
    }

    // 最后兜底：按原始值直接比对（兼容返回 key 而非 ID 的实现）
    return itemCollectionIds.some((v: any) => keys.includes(String(v)));
  }
}
