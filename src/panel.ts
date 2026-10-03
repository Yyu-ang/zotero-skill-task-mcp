/**
 * src/panel.ts — 技能任务管理面板前端脚本（模块 E）
 *
 * 由 addon/content/panel.xhtml 通过 <script src="panel.js"> 引入，
 * 经 scripts/build.mjs 打包为 addon/content/panel.js（iife）。
 *
 * 运行时通过 (Zotero as any).SkillTask 拿到协调员在 core.ts 挂载的
 * SkillTaskAPI；若挂载缺失则显示降级提示，不抛异常。
 *
 * 三个选项卡：技能组（CRUD）/ 任务（按技能组分组的各状态明细）/ MCP 服务（开关+状态+token）。
 * 所有异步操作均 try/catch 并在面板顶部显示中文错误提示。
 */

import type {
  SkillGroup,
  SkillGroupCreateData,
  SkillMaterials,
  SkillScope,
  SkillTaskAPI,
  Task,
  TaskStatus,
} from './types';

/** 选项卡 id */
type TabId = 'skills' | 'tasks' | 'mcp';

/** 任务状态中文标签 */
const STATUS_LABEL: Record<TaskStatus, string> = {
  'waiting-material': '等待材料',
  pending: '待领取',
  claimed: '已领取',
  done: '已完成',
  failed: '失败待重试',
  cancelled: '已取消',
};

/** 非已完成状态的展示顺序 */
const ACTIVE_STATUS_ORDER: TaskStatus[] = [
  'pending',
  'claimed',
  'waiting-material',
  'failed',
  'cancelled',
];

// ────────────────────────── 基础工具 ──────────────────────────

/** 取面板 API；缺失（核心未挂载）时返回 undefined，由调用方降级处理 */
function getAPI(): SkillTaskAPI | undefined {
  try {
    const z =
      typeof Zotero !== 'undefined' ? (Zotero as unknown as Record<string, unknown>) : undefined;
    const api = z?.['SkillTask'] as SkillTaskAPI | undefined;
    if (!api || !api.skillGroups || !api.tasks || !api.generator || !api.mcp) {
      return undefined;
    }
    return api;
  } catch {
    return undefined;
  }
}

/** 按 id 取元素（找不到直接抛错，属面板自身 bug） */
function $<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) {
    throw new Error(`面板元素缺失: #${id}`);
  }
  return e as T;
}

/** 建元素小助手 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text) {
    e.textContent = text;
  }
  return e;
}

/** 错误对象 → 可读中文信息 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 毫秒时间戳 → 本地时间字符串 */
function fmtTime(ts: number | null | undefined): string {
  if (!ts) {
    return '—';
  }
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 全局错误提示 */
function showError(msg: string): void {
  const box = $<HTMLDivElement>('error-box');
  box.textContent = msg;
  box.hidden = false;
}

/** 清除全局错误提示 */
function clearError(): void {
  $<HTMLDivElement>('error-box').hidden = true;
}

/** 操作按钮（点击回调内部自行 try/catch，这里只防未捕获的 Promise 抛错） */
function opBtn(
  label: string,
  onClick: () => void | Promise<void>,
  cls = ''
): HTMLButtonElement {
  const b = el('button', `btn ${cls}`.trim(), label);
  b.addEventListener('click', () => {
    void Promise.resolve()
      .then(onClick)
      .catch((e: unknown) => showError(`操作失败：${errMsg(e)}`));
  });
  return b;
}

// ────────────────────────── 模块状态 ──────────────────────────

let api: SkillTaskAPI | undefined;
let activeTab: TabId = 'skills';
/** 新增/编辑表单状态：null = 未打开；{ editingId: null } = 新增；否则为编辑目标 id */
let formState: { editingId: string | null } | null = null;
/** 正在执行重新扫描的技能组 id（防重复点击） */
let scanBusy: string | null = null;
/** 集合选项缓存（表单内用） */
let collCache: { ok: boolean; options: Array<{ key: string; name: string; depth: number }> } | null =
  null;

// ────────────────────────── 初始化 ──────────────────────────

function init(): void {
  // 静态按钮绑定
  $<HTMLButtonElement>('btn-refresh').addEventListener('click', () => {
    clearError();
    void refreshAll().catch((e: unknown) => showError(`刷新失败：${errMsg(e)}`));
  });
  $<HTMLButtonElement>('btn-close').addEventListener('click', () => {
    window.close();
  });
  for (const t of ['skills', 'tasks', 'mcp'] as TabId[]) {
    $<HTMLButtonElement>(`tabbtn-${t}`).addEventListener('click', () => switchTab(t));
  }

  api = getAPI();
  if (!api) {
    // 插件核心未就绪：降级显示提示，主界面隐藏
    $<HTMLDivElement>('main-ui').hidden = true;
    $<HTMLDivElement>('not-ready').hidden = false;
    return;
  }
  $<HTMLSpanElement>('ver').textContent = `v${api.version}`;
  void refreshAll().catch((e: unknown) => showError(`加载失败：${errMsg(e)}`));
}

/** 切换选项卡 */
function switchTab(tab: TabId): void {
  activeTab = tab;
  clearError();
  for (const t of ['skills', 'tasks', 'mcp'] as TabId[]) {
    $<HTMLButtonElement>(`tabbtn-${t}`).classList.toggle('active', t === tab);
    $<HTMLElement>(`tab-${t}`).hidden = t !== tab;
  }
  void refreshTab(tab).catch((e: unknown) => showError(`加载失败：${errMsg(e)}`));
}

/** 刷新全部选项卡 */
async function refreshAll(): Promise<void> {
  await refreshTab('skills');
  await refreshTab('tasks');
  await refreshTab('mcp');
}

/** 刷新单个选项卡 */
async function refreshTab(tab: TabId): Promise<void> {
  if (!api) {
    return;
  }
  if (tab === 'skills') {
    renderSkills();
  } else if (tab === 'tasks') {
    renderTasks();
  } else {
    renderMcp();
  }
}

// ══════════════════════════ 技能组选项卡 ══════════════════════════

/** 技能组卡片 */
function skillCard(sg: SkillGroup): HTMLElement {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('h3', '', sg.name));
  const badgeKind = sg.archived ? 'warn' : sg.enabled ? 'ok' : 'muted';
  const badgeText = sg.archived ? '已归档' : sg.enabled ? '启用中' : '已停用';
  head.append(el('span', `badge ${badgeKind}`, badgeText));
  head.append(el('span', 'ver', `v${sg.version}`));
  card.append(head);
  card.append(el('div', 'summary', scopeSummary(sg)));
  card.append(el('div', 'summary', materialsSummary(sg)));
  if (sg.instruction) {
    card.append(el('div', 'instruction', sg.instruction));
  }

  const ops = el('div', 'ops');
  ops.append(opBtn('编辑', () => openForm(sg.id)));
  ops.append(opBtn(sg.enabled ? '停用' : '启用', () => setSkillEnabled(sg, !sg.enabled)));
  ops.append(opBtn('复制', () => copySkillGroup(sg.id)));
  if (!sg.archived) {
    ops.append(opBtn('归档', () => archiveSkillGroup(sg.id)));
  } else {
    // 硬删除仅允许已归档的技能组（存储层同样约束，这里先做界面侧限制）
    ops.append(opBtn('删除', () => deleteSkillGroup(sg.id), 'danger'));
  }
  card.append(ops);
  return card;
}

/** 范围摘要 */
function scopeSummary(sg: SkillGroup): string {
  if (sg.scope.type === 'all') {
    return '范围：全库';
  }
  const n = sg.scope.collectionKeys.length;
  return `范围：${n} 个集合（${sg.scope.includeSubcollections ? '含子集合' : '不含子集合'}）`;
}

/** 输入材料 + 交付物摘要（交付物 v1 固定为内建笔记） */
function materialsSummary(sg: SkillGroup): string {
  const m = sg.materials;
  const parts: string[] = [];
  if (m.includeMetadata) {
    parts.push('基本信息');
  }
  if (m.includeAbstract) {
    parts.push('摘要');
  }
  if (m.includeNotes) {
    parts.push('已有笔记');
  }
  if (m.pdf === 'earliest') {
    parts.push('最早 PDF');
  }
  return `材料：${parts.length ? parts.join('、') : '无'}；交付物：内建笔记`;
}

/** 渲染技能组选项卡 */
function renderSkills(): void {
  if (!api) {
    return;
  }
  const root = $<HTMLElement>('tab-skills');
  root.replaceChildren();

  const topRow = el('div', 'row');
  topRow.append(opBtn('＋ 新增技能组', () => openForm(null), 'primary'));
  root.append(topRow);

  const groups = api.skillGroups.list(true);
  if (!groups.length) {
    root.append(el('p', 'empty', '还没有技能组，点击上方按钮创建第一个。'));
  }
  for (const sg of groups) {
    root.append(skillCard(sg));
  }

  // 新增/编辑表单容器（打开时才渲染）
  const wrap = el('div', 'form-wrap');
  wrap.id = 'skill-form-wrap';
  wrap.hidden = true;
  root.append(wrap);
  if (formState) {
    renderForm(wrap);
  }
}

/** 打开新增/编辑表单 */
function openForm(editingId: string | null): void {
  formState = { editingId };
  collCache = null; // 每次打开重新加载集合，避免缓存过期
  clearError();
  const wrap = $<HTMLDivElement>('skill-form-wrap');
  renderForm(wrap);
  wrap.hidden = false;
  wrap.scrollIntoView({ block: 'nearest' });
}

/** 关闭表单 */
function closeForm(): void {
  formState = null;
  $<HTMLDivElement>('skill-form-wrap').hidden = true;
}

/** 加载集合选项（带运行时守卫：API 不可用时返回 ok=false 并在表单内提示） */
function loadCollectionOptions(): {
  ok: boolean;
  options: Array<{ key: string; name: string; depth: number }>;
} {
  try {
    const z = Zotero as unknown as Record<string, any> | undefined;
    const libs = z?.['Libraries'];
    const cols = z?.['Collections'];
    if (!libs || !cols || typeof cols.getByLibrary !== 'function') {
      return { ok: false, options: [] };
    }
    const libraryID = libs.userLibraryID as number | undefined;
    if (typeof libraryID !== 'number') {
      return { ok: false, options: [] };
    }
    const all = cols.getByLibrary(libraryID, true) as Array<any>;
    const byKey = new Map<string, any>();
    for (const c of all) {
      if (!c.deleted && c.key) {
        byKey.set(c.key, c);
      }
    }
    // 按 parentKey 链计算缩进层级（防环）
    const depthOf = (c: any): number => {
      let d = 0;
      let cur: any = c;
      const seen = new Set<string>();
      while (cur && cur.parentKey && byKey.has(cur.parentKey) && !seen.has(cur.key)) {
        seen.add(cur.key);
        cur = byKey.get(cur.parentKey);
        d++;
      }
      return d;
    };
    const options = Array.from(byKey.values()).map((c) => ({
      key: String(c.key),
      name: String(c.name ?? c.key),
      depth: depthOf(c),
    }));
    return { ok: true, options };
  } catch {
    return { ok: false, options: [] };
  }
}

/** 渲染新增/编辑表单（页内表单，不弹窗） */
function renderForm(wrap: HTMLElement): void {
  if (!api || !formState) {
    return;
  }
  wrap.replaceChildren();
  const editing = formState.editingId ? api.skillGroups.get(formState.editingId) : undefined;
  wrap.append(el('h3', '', editing ? `编辑技能组「${editing.name}」` : '新增技能组'));

  // —— 名称 ——
  const nameField = el('div', 'field');
  nameField.append(el('label', '', '名称'));
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.value = editing?.name ?? '';
  nameInput.placeholder = '例如：文献综述初稿';
  nameField.append(nameInput);
  wrap.append(nameField);

  // —— 任务指令 ——
  const instrField = el('div', 'field');
  instrField.append(el('label', '', '任务指令'));
  const instrInput = el('textarea');
  instrInput.value = editing?.instruction ?? '';
  instrInput.placeholder = '发给 AI 的任务说明，例如：阅读 PDF 并撰写 300 字中文摘要…';
  instrField.append(instrInput);
  wrap.append(instrField);

  // —— 范围 ——
  const scopeField = el('div', 'field');
  scopeField.append(el('label', '', '适用范围'));
  const scopeAll = el('input');
  scopeAll.type = 'radio';
  scopeAll.name = 'scope-type';
  scopeAll.value = 'all';
  const scopeColl = el('input');
  scopeColl.type = 'radio';
  scopeColl.name = 'scope-type';
  scopeColl.value = 'collections';
  const currentScope: SkillScope = editing?.scope ?? {
    type: 'all',
    collectionKeys: [],
    includeSubcollections: true,
  };
  if (currentScope.type === 'collections') {
    scopeColl.checked = true;
  } else {
    scopeAll.checked = true;
  }
  const rowAll = el('div', 'radio-row');
  rowAll.append(scopeAll);
  rowAll.append(el('span', '', '全库'));
  const rowColl = el('div', 'radio-row');
  rowColl.append(scopeColl);
  rowColl.append(el('span', '', '指定集合'));
  scopeField.append(rowAll, rowColl);

  // 集合多选列表（仅指定集合时显示）
  const collBox = el('div');
  const collList = el('div', 'coll-list');
  const collHint = el('div', 'hint');
  const includeSubRow = el('div', 'check-row');
  const includeSub = el('input');
  includeSub.type = 'checkbox';
  includeSub.checked = currentScope.includeSubcollections;
  includeSubRow.append(includeSub);
  includeSubRow.append(el('span', '', '包含子集合'));
  collBox.append(collList, collHint, includeSubRow);
  collBox.hidden = currentScope.type !== 'collections';

  const renderCollList = (): void => {
    collList.replaceChildren();
    if (!collCache) {
      collCache = loadCollectionOptions();
    }
    if (!collCache.ok) {
      collHint.textContent = '取不到集合列表（Zotero.Collections API 不可用），请改用全库范围。';
      return;
    }
    if (!collCache.options.length) {
      collHint.textContent = '文库中没有集合，请改用全库范围。';
      return;
    }
    collHint.textContent = '';
    for (const opt of collCache.options) {
      const item = el('div', 'coll-item');
      item.style.paddingLeft = `${opt.depth * 18}px`;
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = opt.key;
      if (currentScope.type === 'collections' && currentScope.collectionKeys.includes(opt.key)) {
        cb.checked = true;
      }
      item.append(cb);
      item.append(el('span', '', opt.name));
      collList.append(item);
    }
  };
  const syncCollBox = (): void => {
    const isColl = (wrap.querySelector('input[name="scope-type"]:checked') as HTMLInputElement)
      ?.value === 'collections';
    collBox.hidden = !isColl;
    if (isColl) {
      renderCollList();
    }
  };
  scopeAll.addEventListener('change', syncCollBox);
  scopeColl.addEventListener('change', syncCollBox);
  if (currentScope.type === 'collections') {
    renderCollList();
  }
  scopeField.append(collBox);
  wrap.append(scopeField);

  // —— 输入材料 ——
  const matField = el('div', 'field');
  matField.append(el('label', '', '输入材料'));
  const curMat: SkillMaterials = editing?.materials ?? {
    includeMetadata: true,
    includeAbstract: false,
    includeNotes: false,
    pdf: 'earliest',
  };
  const matMeta = el('input');
  matMeta.type = 'checkbox';
  matMeta.checked = curMat.includeMetadata;
  const matAbs = el('input');
  matAbs.type = 'checkbox';
  matAbs.checked = curMat.includeAbstract;
  const matNotes = el('input');
  matNotes.type = 'checkbox';
  matNotes.checked = curMat.includeNotes;
  const rowMeta = el('div', 'check-row');
  rowMeta.append(matMeta, el('span', '', '文献基本信息（标题/作者/年份/条目 key）'));
  const rowAbs = el('div', 'check-row');
  rowAbs.append(matAbs, el('span', '', '摘要'));
  const rowNotes = el('div', 'check-row');
  rowNotes.append(matNotes, el('span', '', '已有笔记（标题 + 文本）'));
  const pdfEarliest = el('input');
  pdfEarliest.type = 'radio';
  pdfEarliest.name = 'pdf-mode';
  pdfEarliest.value = 'earliest';
  const pdfNone = el('input');
  pdfNone.type = 'radio';
  pdfNone.name = 'pdf-mode';
  pdfNone.value = 'none';
  if (curMat.pdf === 'none') {
    pdfNone.checked = true;
  } else {
    pdfEarliest.checked = true;
  }
  const rowPdf1 = el('div', 'radio-row');
  rowPdf1.append(pdfEarliest, el('span', '', 'PDF：目标条目最早加入的本地 PDF 路径'));
  const rowPdf2 = el('div', 'radio-row');
  rowPdf2.append(pdfNone, el('span', '', 'PDF：不提供'));
  matField.append(rowMeta, rowAbs, rowNotes, rowPdf1, rowPdf2);
  wrap.append(matField);

  // —— 交付物（固定显示） ——
  const delField = el('div', 'field');
  delField.append(el('label', '', '交付物'));
  delField.append(el('div', 'fixed-note', '内建笔记（v1 唯一支持的交付物类型）'));
  wrap.append(delField);

  // —— 保存 / 取消 ——
  const btnRow = el('div', 'ops');
  btnRow.append(
    opBtn('保存', async () => {
      clearError();
      const name = nameInput.value.trim();
      if (!name) {
        showError('请填写技能组名称。');
        return;
      }
      const instruction = instrInput.value.trim();
      if (!instruction) {
        showError('请填写任务指令。');
        return;
      }
      const scopeType = (wrap.querySelector('input[name="scope-type"]:checked') as HTMLInputElement)
        ?.value as 'all' | 'collections';
      let scope: SkillScope;
      if (scopeType === 'collections') {
        const checked = Array.from(
          wrap.querySelectorAll('.coll-list input[type="checkbox"]:checked')
        )
          .filter(
            (n): n is HTMLInputElement => n instanceof HTMLInputElement && n.checked
          )
          .map((i) => i.value);
        if (!checked.length) {
          showError('指定集合范围至少选择一个集合。');
          return;
        }
        scope = {
          type: 'collections',
          collectionKeys: checked,
          includeSubcollections: includeSub.checked,
        };
      } else {
        scope = { type: 'all', collectionKeys: [], includeSubcollections: true };
      }
      const pdfMode = (wrap.querySelector('input[name="pdf-mode"]:checked') as HTMLInputElement)
        ?.value as 'earliest' | 'none';
      const materials: SkillMaterials = {
        includeMetadata: matMeta.checked,
        includeAbstract: matAbs.checked,
        includeNotes: matNotes.checked,
        pdf: pdfMode === 'none' ? 'none' : 'earliest',
      };
      if (editing) {
        await api!.skillGroups.update(editing.id, { name, instruction, scope, materials });
      } else {
        const data: SkillGroupCreateData = {
          name,
          instruction,
          scope,
          materials,
          deliverable: { type: 'note' },
        };
        await api!.skillGroups.create(data);
      }
      closeForm();
      renderSkills();
    }, 'primary')
  );
  btnRow.append(opBtn('取消', () => closeForm()));
  wrap.append(btnRow);
}

/** 启停技能组 */
async function setSkillEnabled(sg: SkillGroup, enabled: boolean): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  try {
    await api.skillGroups.setEnabled(sg.id, enabled);
    await refreshTab(activeTab);
  } catch (e) {
    showError(`${enabled ? '启用' : '停用'}失败：${errMsg(e)}`);
  }
}

/** 复制技能组 */
async function copySkillGroup(id: string): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  try {
    await api.skillGroups.copy(id);
    await refreshTab(activeTab);
  } catch (e) {
    showError(`复制失败：${errMsg(e)}`);
  }
}

/** 归档技能组（软删除） */
async function archiveSkillGroup(id: string): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  if (!window.confirm('确定归档该技能组吗？归档后不再生成新任务，历史任务与笔记保留。')) {
    return;
  }
  try {
    await api.skillGroups.archive(id);
    await refreshTab(activeTab);
  } catch (e) {
    showError(`归档失败：${errMsg(e)}`);
  }
}

/** 删除技能组（硬删除；存储层仅允许已归档的） */
async function deleteSkillGroup(id: string): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  if (!window.confirm('确定永久删除该技能组吗？此操作不可恢复，历史任务保留但不再关联。')) {
    return;
  }
  try {
    await api.skillGroups.remove(id);
    await refreshTab(activeTab);
  } catch (e) {
    showError(`删除失败：${errMsg(e)}`);
  }
}

// ══════════════════════════ 任务选项卡 ══════════════════════════

/** 渲染任务选项卡：按技能组分组，每组显示计数 + 各状态明细 */
function renderTasks(): void {
  if (!api) {
    return;
  }
  const root = $<HTMLElement>('tab-tasks');
  root.replaceChildren();
  const groups = api.skillGroups.list(true);
  if (!groups.length) {
    root.append(el('p', 'empty', '还没有技能组。'));
    return;
  }
  for (const sg of groups) {
    root.append(taskGroupSection(sg));
  }
}

/** 单个技能组的任务分组块 */
function taskGroupSection(sg: SkillGroup): HTMLElement {
  const sec = el('section', 'card');
  // —— 头部：名称 + 计数（调 tasks.countsBySkill，必须与下方明细一致） ——
  const counts = api!.tasks.countsBySkill(sg.id);
  const done = counts.done ?? 0;
  const undone =
    (counts['waiting-material'] ?? 0) +
    (counts.pending ?? 0) +
    (counts.claimed ?? 0) +
    (counts.failed ?? 0) +
    (counts.cancelled ?? 0);
  const head = el('div', 'card-head');
  head.append(el('h3', '', sg.name));
  const countEl = el('span', 'count', '');
  const strongDone = el('strong', '', String(done));
  const strongUndone = el('strong', '', String(undone));
  countEl.append('完成 ', strongDone, ' · 未完成 ', strongUndone);
  head.append(countEl);
  sec.append(head);

  const ops = el('div', 'ops');
  ops.append(opBtn(sg.enabled ? '暂停领取' : '恢复领取', () => setSkillEnabled(sg, !sg.enabled)));
  const rescanBtn = opBtn('重新扫描', () => rescan(sg.id));
  rescanBtn.id = `rescan-btn-${sg.id}`;
  ops.append(rescanBtn);
  sec.append(ops);

  const prog = el('div', 'scan-prog');
  prog.id = `scan-prog-${sg.id}`;
  sec.append(prog);

  // —— 明细：六个状态分组 ——
  const tasks = api!.tasks.list({ skillGroupId: sg.id });
  for (const st of ACTIVE_STATUS_ORDER) {
    const items = tasks.filter((t) => t.status === st);
    const det = el('details', 'status-group');
    det.open = items.length > 0 && st !== 'cancelled';
    det.append(el('summary', '', `${STATUS_LABEL[st]}（${items.length}）`));
    for (const t of items) {
      det.append(taskRow(t));
    }
    sec.append(det);
  }
  // 已完成：可折叠列表，只显示条目 key + 完成时间
  const dones = tasks.filter((t) => t.status === 'done');
  const doneDet = el('details', 'status-group');
  doneDet.append(el('summary', '', `已完成（${dones.length}）`));
  for (const t of dones) {
    const row = el('div', 'task-row');
    const info = el('div', 'task-info');
    info.append(el('span', 'mono', t.itemKey));
    info.append(el('span', 'muted', `　完成：${fmtTime(t.completedAt)}`));
    if (t.noteKey) {
      info.append(el('span', 'muted', `　笔记：${t.noteKey}`));
    }
    row.append(info);
    doneDet.append(row);
  }
  sec.append(doneDet);
  return sec;
}

/** 单条任务行（未完成状态）：条目 key、创建/领取/完成时间、失败原因 + 操作 */
function taskRow(t: Task): HTMLElement {
  const row = el('div', 'task-row');
  const info = el('div', 'task-info');
  const line1 = el('div');
  line1.append(el('span', 'mono', t.itemKey));
  line1.append(
    el('span', 'muted', `　创建 ${fmtTime(t.createdAt)} · 领取 ${fmtTime(t.claimedAt)} · 完成 ${fmtTime(t.completedAt)}`)
  );
  info.append(line1);
  if (t.lastError) {
    info.append(el('div', 'err-inline', `失败原因：${t.lastError}`));
  }
  row.append(info);

  const ops = el('div', 'ops');
  if (t.status === 'failed') {
    ops.append(opBtn('重试', () => retryTask(t.id)));
  }
  if (t.status !== 'done' && t.status !== 'cancelled') {
    ops.append(opBtn('取消', () => cancelTask(t.id), 'danger'));
  }
  row.append(ops);
  return row;
}

/** 重试失败任务（failed → pending） */
async function retryTask(id: string): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  try {
    await api.tasks.retry(id);
    await refreshTab('tasks');
  } catch (e) {
    showError(`重试失败：${errMsg(e)}`);
  }
}

/** 取消未完成任务 */
async function cancelTask(id: string): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  if (!window.confirm('确定取消该任务吗？取消后不再领取，已生成的数据保留。')) {
    return;
  }
  try {
    await api.tasks.cancel(id);
    await refreshTab('tasks');
  } catch (e) {
    showError(`取消失败：${errMsg(e)}`);
  }
}

/** 重新扫描技能组范围（显示 scanned/created 进度） */
async function rescan(skillGroupId: string): Promise<void> {
  if (!api || scanBusy) {
    return;
  }
  scanBusy = skillGroupId;
  clearError();
  const progEl = document.getElementById(`scan-prog-${skillGroupId}`);
  const btnEl = document.getElementById(`rescan-btn-${skillGroupId}`) as HTMLButtonElement | null;
  if (btnEl) {
    btnEl.disabled = true;
  }
  try {
    const result = await api.generator.scanSkillGroup(skillGroupId, {
      onProgress: (done, total) => {
        if (progEl) {
          progEl.textContent = `扫描中… ${done}/${total}`;
        }
      },
    });
    if (progEl) {
      progEl.textContent =
        `扫描完成：已扫描 ${result.scanned}，新建 ${result.created}，` +
        `跳过 ${result.skipped}，等待材料 ${result.waitingMaterial}，转为待领取 ${result.promoted}`;
    }
    await refreshTab('tasks');
    // refreshTab 重建了 DOM，重新定位进度元素以保留结果摘要
    const freshProg = document.getElementById(`scan-prog-${skillGroupId}`);
    if (freshProg) {
      freshProg.textContent =
        `扫描完成：已扫描 ${result.scanned}，新建 ${result.created}，` +
        `跳过 ${result.skipped}，等待材料 ${result.waitingMaterial}，转为待领取 ${result.promoted}`;
    }
  } catch (e) {
    showError(`扫描失败：${errMsg(e)}`);
  } finally {
    scanBusy = null;
    const freshBtn = document.getElementById(`rescan-btn-${skillGroupId}`) as HTMLButtonElement | null;
    if (freshBtn) {
      freshBtn.disabled = false;
    }
  }
}

// ══════════════════════════ MCP 服务选项卡 ══════════════════════════

/** 渲染 MCP 服务选项卡 */
function renderMcp(): void {
  if (!api) {
    return;
  }
  const root = $<HTMLElement>('tab-mcp');
  root.replaceChildren();
  const mcp = api.mcp;

  let enabled = false;
  let path = '/skilltask/mcp';
  let port: number | null = null;
  let token = '';
  try {
    const st = mcp.getStatus();
    enabled = st.enabled;
    path = st.path;
    port = st.port;
    token = mcp.ensureToken();
  } catch (e) {
    showError(`读取 MCP 状态失败：${errMsg(e)}`);
    return;
  }

  const card = el('div', 'card');

  // 启用开关
  const toggleRow = el('div', 'mcp-row');
  toggleRow.append(el('span', 'k', '服务开关'));
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.className = 'switch';
  toggle.checked = enabled;
  toggle.addEventListener('change', () => {
    void setMcpEnabled(toggle.checked);
  });
  toggleRow.append(toggle);
  toggleRow.append(el('span', '', enabled ? '已启用' : '已停用'));
  card.append(toggleRow);

  // 服务状态
  const statusRow = el('div', 'mcp-row');
  statusRow.append(el('span', 'k', '服务状态'));
  statusRow.append(
    el('span', `badge ${enabled ? 'ok' : 'muted'}`, enabled ? '运行中' : '已停止')
  );
  card.append(statusRow);

  // 监听路径 / 端口
  const pathRow = el('div', 'mcp-row');
  pathRow.append(el('span', 'k', '监听路径'));
  pathRow.append(el('span', 'mono', path));
  card.append(pathRow);

  const portRow = el('div', 'mcp-row');
  portRow.append(el('span', 'k', '端口'));
  portRow.append(el('span', 'mono', port === null ? '未知' : String(port)));
  card.append(portRow);

  // token 显示 + 重新生成
  const tokenRow = el('div', 'mcp-row');
  tokenRow.append(el('span', 'k', '访问 token'));
  tokenRow.append(el('div', 'token-box', token));
  tokenRow.append(opBtn('重新生成', () => regenerateToken()));
  card.append(tokenRow);
  card.append(
    el('div', 'hint', '领取与提交接口均需携带该 token；重新生成后旧 token 立即失效。')
  );

  // 关闭时的明确提示
  const notice = el('div', 'notice', 'MCP 服务已停止监听，不再接受外部领取与提交请求。');
  notice.id = 'mcp-stopped-notice';
  notice.hidden = enabled;
  card.append(notice);

  root.append(card);
}

/** 切换 MCP 服务开关 */
async function setMcpEnabled(v: boolean): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  try {
    api.mcp.setEnabled(v);
    renderMcp();
    if (!v) {
      // 关闭时明确提示"已停止监听"
      const notice = document.getElementById('mcp-stopped-notice');
      if (notice) {
        notice.hidden = false;
      }
    }
  } catch (e) {
    showError(`切换 MCP 服务失败：${errMsg(e)}`);
  }
}

/** 重新生成 token（操作前 confirm） */
async function regenerateToken(): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  if (
    !window.confirm('确定重新生成访问 token 吗？旧 token 将立即失效，外部 AI 客户端需要更新配置。')
  ) {
    return;
  }
  try {
    api.mcp.regenerateToken();
    renderMcp();
  } catch (e) {
    showError(`重新生成 token 失败：${errMsg(e)}`);
  }
}

// ────────────────────────── 启动 ──────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
