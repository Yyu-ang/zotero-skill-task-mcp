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
 *
 * 视觉体系（与 panel.xhtml 设计令牌配套）：
 * - 图标：单一 feather 风格 inline SVG（1.5px 描边，currentColor），
 *   按钮一律图标+文字，不做纯图标谜语按钮；禁用 emoji。
 * - 状态徽章颜色+图标双通道：ok=绿 warn=琥珀 danger=红 muted=灰，
 *   accent(蓝)只用于"待领取/已领取"两类进行中状态。
 * - 动效仅 transform/opacity 的 transition（反馈/状态变化/层级引导），
 *   prefers-reduced-motion 下由 CSS 统一关闭。
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

// ────────────────────────── 图标体系（feather 风格，单一系列） ──────────────────────────

/** 图标名 → svg 内部 path 数据（1.5px 描边，currentColor） */
const ICONS: Record<string, string> = {
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  edit: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  pause:
    '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  archive:
    '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  trash:
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  refresh:
    '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  search:
    '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  'check-circle':
    '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  'alert-circle':
    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  'x-circle':
    '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  slash: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
  'rotate-ccw': '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  layers:
    '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  server:
    '<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  package:
    '<path d="M16.5 9.4L7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
  'file-text':
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
};

/** 图标 svg 字符串（cls 控制尺寸：默认 .ic 15px，徽章内用 .ic-sm 12px） */
function iconSVG(name: string, cls = 'ic'): string {
  const body = ICONS[name] ?? '';
  return (
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  );
}

/** 图标元素（包一层 span 以便 flex 对齐） */
function iconEl(name: string, cls = 'ic'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'ic-wrap';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = iconSVG(name, cls);
  return s;
}

// ────────────────────────── 状态语义（颜色+图标双通道） ──────────────────────────

/** 任务状态元信息：中文标签 / 徽章颜色类 / 图标 */
const STATUS_META: Record<TaskStatus, { label: string; badge: string; icon: string }> = {
  'waiting-material': { label: '等待材料', badge: 'warn', icon: 'clock' },
  pending: { label: '待领取', badge: 'accent', icon: 'inbox' },
  claimed: { label: '已领取', badge: 'accent', icon: 'zap' },
  done: { label: '已完成', badge: 'ok', icon: 'check-circle' },
  failed: { label: '失败待重试', badge: 'danger', icon: 'alert-circle' },
  cancelled: { label: '已取消', badge: 'muted', icon: 'x-circle' },
};

/** 非已完成状态的展示顺序 */
const ACTIVE_STATUS_ORDER: TaskStatus[] = [
  'pending',
  'claimed',
  'waiting-material',
  'failed',
  'cancelled',
];

/** 统计条分段顺序（与 ACTIVE_STATUS_ORDER 对齐，已完成放末尾） */
const STATBAR_ORDER: TaskStatus[] = [
  'pending',
  'claimed',
  'waiting-material',
  'failed',
  'cancelled',
  'done',
];

/** 状态徽章（图标+文字） */
function statusBadge(st: TaskStatus): HTMLElement {
  const m = STATUS_META[st];
  const b = el('span', `badge ${m.badge}`);
  b.append(iconEl(m.icon, 'ic ic-sm'), document.createTextNode(m.label));
  return b;
}

/** 技能组状态徽章（图标+文字） */
function groupBadge(sg: SkillGroup): HTMLElement {
  const kind = sg.archived ? 'warn' : sg.enabled ? 'ok' : 'muted';
  const text = sg.archived ? '已归档' : sg.enabled ? '启用中' : '已停用';
  const icon = sg.archived ? 'archive' : sg.enabled ? 'check-circle' : 'pause';
  const b = el('span', `badge ${kind}`);
  b.append(iconEl(icon, 'ic ic-sm'), document.createTextNode(text));
  return b;
}

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

/** 毫秒时间戳 → 本地时间字符串（绝对时间，配在 title/提示里） */
function fmtTime(ts: number | null | undefined): string {
  if (!ts) {
    return '—';
  }
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 毫秒时间戳 → 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前；超过 30 天回绝对时间） */
function fmtRelative(ts: number | null | undefined): string {
  if (!ts) {
    return '—';
  }
  const diff = Date.now() - ts;
  if (diff < 0) {
    return '刚刚';
  }
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) {
    return '刚刚';
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} 天前`;
  }
  return fmtTime(ts);
}

/** 全局错误提示 */
function showError(msg: string): void {
  const box = $<HTMLDivElement>('error-box');
  $<HTMLSpanElement>('error-text').textContent = msg;
  box.hidden = false;
}

/** 清除全局错误提示 */
function clearError(): void {
  $<HTMLDivElement>('error-box').hidden = true;
}

/** 操作按钮：图标+文字，title 为 tooltip；点击回调内部自行 try/catch，这里只防未捕获的 Promise 抛错 */
function opBtn(
  label: string,
  onClick: (btn: HTMLButtonElement) => void | Promise<void>,
  opts: {
    cls?: string;
    icon?: string;
    title?: string;
    id?: string;
    /** 次要操作：默认弱化，hover 时显形 */
    secondary?: boolean;
  } = {}
): HTMLButtonElement {
  const b = el('button', `btn ${opts.cls ?? ''} ${opts.secondary ? 'op-sec' : ''}`.trim());
  if (opts.icon) {
    b.append(iconEl(opts.icon));
  }
  b.append(document.createTextNode(label));
  if (opts.title) {
    b.title = opts.title;
  }
  if (opts.id) {
    b.id = opts.id;
  }
  b.addEventListener('click', () => {
    void Promise.resolve()
      .then(() => onClick(b))
      .catch((e: unknown) => showError(`操作失败：${errMsg(e)}`));
  });
  return b;
}

/** 空状态块：图标 + 标题 + 引导文案 + 行动按钮 */
function emptyState(
  icon: string,
  title: string,
  desc: string,
  action?: { label: string; icon?: string; onClick: () => void }
): HTMLElement {
  const wrap = el('div', 'empty-state');
  const ic = el('span', 'empty-ic');
  ic.innerHTML = iconSVG(icon, 'ic');
  wrap.append(ic);
  wrap.append(el('h3', '', title));
  wrap.append(el('p', '', desc));
  if (action) {
    const btn = opBtn(action.label, action.onClick, { cls: 'primary', icon: action.icon });
    wrap.append(btn);
  }
  return wrap;
}

/** 复制文本到剪贴板（clipboard API 不可用时退回 execCommand）；成功给按钮"已复制"反馈 */
async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  try {
    let ok = false;
    const nav = navigator as Navigator & {
      clipboard?: { writeText(t: string): Promise<void> };
    };
    if (nav.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      ok = true;
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    }
    if (!ok) {
      throw new Error('剪贴板不可用');
    }
    const orig = btn.innerHTML;
    btn.innerHTML = `${iconSVG('check', 'ic')}已复制`;
    btn.disabled = true;
    window.setTimeout(() => {
      btn.innerHTML = orig;
      btn.disabled = false;
    }, 1200);
  } catch (e) {
    showError(`复制失败：${errMsg(e)}，请手动复制。`);
  }
}

/** 骨架屏：按目标选项卡的最终布局占位（加载中不用转圈） */
function renderSkeleton(tab: TabId): void {
  const root = $<HTMLElement>(`tab-${tab}`);
  root.replaceChildren();
  const wrap = el('div');
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', '加载中');
  const bar = (w: string, h = 14): HTMLElement => {
    const b = el('div', 'skel');
    b.style.width = w;
    b.style.height = `${h}px`;
    return b;
  };
  const card = (lines: string[]): HTMLElement => {
    const c = el('div', 'card');
    for (const w of lines) {
      const r = el('div', 'skel-row');
      r.append(bar(w));
      c.append(r);
    }
    return c;
  };
  if (tab === 'skills') {
    const r = el('div', 'skel-row');
    r.append(bar('120px', 30));
    wrap.append(r);
    wrap.append(card(['45%', '80%', '60%']));
    wrap.append(card(['40%', '70%', '55%']));
  } else if (tab === 'tasks') {
    wrap.append(card(['35%', '90%', '90%', '70%']));
  } else {
    wrap.append(card(['30%', '60%', '75%', '50%']));
  }
  root.append(wrap);
}

// ────────────────────────── 模块状态 ──────────────────────────

let api: SkillTaskAPI | undefined;
let activeTab: TabId = 'skills';
/** 新增/编辑表单状态：null = 未打开；{ editingId: null } = 新增；否则为编辑目标 id */
let formState: { editingId: string | null } | null = null;
/** 正在执行重新扫描的技能组 id（防重复点击） */
let scanBusy: string | null = null;
/** 正在执行全部重新扫描（快捷操作，防重复点击） */
let scanAllRunning = false;
/** 集合选项缓存（表单内用） */
let collCache: { ok: boolean; options: Array<{ key: string; name: string; depth: number }> } | null =
  null;
/** 任务 tab 搜索关键词（按条目 key 模糊匹配，client-side） */
let taskSearch = '';
/** 任务 tab 状态筛选（'all' = 全部状态，client-side） */
let taskStatusFilter: TaskStatus | 'all' = 'all';
/** 已选中的任务 id（批量操作） */
const selectedTasks = new Set<string>();
/** 已展开详情的任务 id */
const expandedTasks = new Set<string>();
/** MCP 审计视图展示的最近事件条数 */
const AUDIT_LIMIT = 20;

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
  $<HTMLButtonElement>('error-close').addEventListener('click', () => {
    clearError();
  });
  $<HTMLButtonElement>('btn-notready-retry').addEventListener('click', () => {
    window.location.reload();
  });
  for (const t of ['skills', 'tasks', 'mcp'] as TabId[]) {
    $<HTMLButtonElement>(`tabbtn-${t}`).addEventListener('click', () => switchTab(t));
  }
  bindQuickActions();

  api = getAPI();
  if (!api) {
    // 插件核心未就绪：降级显示提示，主界面隐藏
    $<HTMLDivElement>('main-ui').hidden = true;
    $<HTMLDivElement>('not-ready').hidden = false;
    return;
  }
  $<HTMLSpanElement>('ver').textContent = `v${api.version}`;
  // 先按最终布局占位骨架屏，再异步刷新真实数据
  renderSkeleton('skills');
  renderSkeleton('tasks');
  renderSkeleton('mcp');
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

/** 任务统计 mini 条：各状态计数一段堆叠条 + 图例（颜色+图标双通道） */
function statBar(counts: Record<TaskStatus, number>): HTMLElement {
  const wrap = el('div', 'statbar-wrap');
  const total = STATBAR_ORDER.reduce((a, s) => a + (counts[s] ?? 0), 0);
  const bar = el('div', 'statbar');
  const segClass: Record<TaskStatus, string> = {
    'waiting-material': 'st-waiting',
    pending: 'st-pending',
    claimed: 'st-claimed',
    done: 'st-done',
    failed: 'st-failed',
    cancelled: 'st-cancelled',
  };
  if (total === 0) {
    const ph = el('div', 'statbar-empty', '暂无任务');
    bar.append(ph);
  } else {
    for (const st of STATBAR_ORDER) {
      const n = counts[st] ?? 0;
      if (!n) {
        continue;
      }
      const seg = el('div', `stat-seg ${segClass[st]}`);
      seg.style.flexGrow = String(n);
      seg.title = `${STATUS_META[st].label} ${n}`;
      bar.append(seg);
    }
  }
  const desc =
    total === 0
      ? '暂无任务'
      : STATBAR_ORDER.map((st) => `${STATUS_META[st].label} ${counts[st] ?? 0}`)
          .join('，');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `任务状态分布：${desc}`);
  wrap.append(bar);

  // 图例：色点 + 图标 + 标签 + 计数
  const legend = el('div', 'stat-legend');
  const dotColor: Record<TaskStatus, string> = {
    'waiting-material': 'var(--warn)',
    pending: 'var(--accent)',
    claimed: 'var(--accent-mid)',
    done: 'var(--ok)',
    failed: 'var(--danger)',
    cancelled: 'var(--muted)',
  };
  for (const st of STATBAR_ORDER) {
    const item = el('span', 'lg-item');
    const dot = el('span', 'dot');
    dot.style.background = dotColor[st];
    item.append(dot);
    item.append(iconEl(STATUS_META[st].icon, 'ic ic-sm'));
    item.append(document.createTextNode(STATUS_META[st].label));
    item.append(el('span', 'n', String(counts[st] ?? 0)));
    legend.append(item);
  }
  wrap.append(legend);
  return wrap;
}

/** 技能组卡片 */
function skillCard(sg: SkillGroup): HTMLElement {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  const sgIcon = el('span', 'sg-ic');
  sgIcon.innerHTML = iconSVG(sg.archived ? 'archive' : 'layers', 'ic');
  head.append(sgIcon);
  head.append(el('h3', '', sg.name));
  head.append(groupBadge(sg));
  head.append(el('span', 'ver', `v${sg.version}`));
  card.append(head);

  // 任务统计 mini 条（调 tasks.countsBySkill，与任务页明细一致）
  const counts = api!.tasks.countsBySkill(sg.id);
  card.append(statBar(counts));

  card.append(summaryLine('search', scopeSummary(sg)));
  card.append(summaryLine('file-text', materialsSummary(sg)));
  if (sg.instruction) {
    card.append(el('div', 'instruction', sg.instruction));
  }

  // 更新时间（相对时间，title 里放绝对时间）
  const meta = el('div', 'meta-line');
  meta.append(iconEl('clock', 'ic ic-sm'));
  const rel = el('span', 'reltime', `更新于 ${fmtRelative(sg.updatedAt)}`);
  rel.title = fmtTime(sg.updatedAt);
  meta.append(rel);
  card.append(meta);

  const ops = el('div', 'ops');
  ops.append(
    opBtn('编辑', () => openForm(sg.id), { icon: 'edit', title: '编辑技能组' })
  );
  ops.append(
    opBtn(sg.enabled ? '停用' : '启用', () => setSkillEnabled(sg, !sg.enabled), {
      icon: sg.enabled ? 'pause' : 'play',
      title: sg.enabled ? '停用后不再生成新任务并暂停领取' : '重新启用技能组',
      secondary: true,
    })
  );
  ops.append(
    opBtn('复制', () => copySkillGroup(sg.id), {
      icon: 'copy',
      title: '复制为新的技能组',
      secondary: true,
    })
  );
  if (!sg.archived) {
    ops.append(
      opBtn('归档', () => archiveSkillGroup(sg.id), {
        icon: 'archive',
        title: '归档后不再生成新任务，历史任务与笔记保留',
        secondary: true,
      })
    );
  } else {
    // 硬删除仅允许已归档的技能组（存储层同样约束，这里先做界面侧限制）
    ops.append(
      opBtn('删除', () => deleteSkillGroup(sg.id), {
        cls: 'danger',
        icon: 'trash',
        title: '永久删除，不可恢复',
        secondary: true,
      })
    );
  }
  card.append(ops);
  return card;
}

/** 摘要行（小图标 + 文案） */
function summaryLine(icon: string, text: string): HTMLElement {
  const d = el('div', 'summary');
  d.append(iconEl(icon, 'ic ic-sm'));
  d.append(document.createTextNode(text));
  return d;
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
  topRow.append(
    opBtn('新增', () => openForm(null), {
      cls: 'primary',
      icon: 'plus',
      title: '新增技能组',
    })
  );
  root.append(topRow);

  const groups = api.skillGroups.list(true);
  if (!groups.length) {
    root.append(
      emptyState(
        'package',
        '还没有技能组',
        '创建第一个技能组，为符合范围的文献批量生成 AI 任务。',
        { label: '新增技能组', icon: 'plus', onClick: () => openForm(null) }
      )
    );
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

/** 表单 label（含必填星号） */
function formLabel(text: string, required = false): HTMLElement {
  const l = el('label', '', text);
  if (required) {
    l.append(el('span', 'req', '*'));
  }
  return l;
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
  nameField.append(formLabel('名称', true));
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.value = editing?.name ?? '';
  nameInput.placeholder = '例如：文献综述初稿';
  nameField.append(nameInput);
  wrap.append(nameField);

  // —— 任务指令 ——
  const instrField = el('div', 'field');
  instrField.append(formLabel('任务指令', true));
  const instrInput = el('textarea');
  instrInput.value = editing?.instruction ?? '';
  instrInput.placeholder = '发给 AI 的任务说明，例如：阅读 PDF 并撰写 300 字中文摘要…';
  instrField.append(instrInput);
  wrap.append(instrField);

  // —— 范围 ——
  const scopeField = el('div', 'field');
  scopeField.append(formLabel('适用范围'));
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
  matField.append(formLabel('输入材料'));
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
  delField.append(formLabel('交付物'));
  delField.append(el('div', 'fixed-note', '内建笔记（v1 唯一支持的交付物类型）'));
  wrap.append(delField);

  // —— 保存 / 取消 ——
  const btnRow = el('div', 'ops');
  btnRow.append(
    opBtn(
      '保存',
      async () => {
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
        const scopeType = (
          wrap.querySelector('input[name="scope-type"]:checked') as HTMLInputElement
        )?.value as 'all' | 'collections';
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
      },
      { cls: 'primary', icon: 'check', title: '保存技能组' }
    )
  );
  btnRow.append(opBtn('取消', () => closeForm(), { icon: 'x', title: '关闭表单，不保存' }));
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

/** 任务是否匹配当前搜索/筛选（client-side，不过滤数据源本身） */
function taskMatches(t: Task): boolean {
  if (taskStatusFilter !== 'all' && t.status !== taskStatusFilter) {
    return false;
  }
  const q = taskSearch.trim().toLowerCase();
  if (q && !t.itemKey.toLowerCase().includes(q)) {
    return false;
  }
  return true;
}

/** 渲染任务选项卡：工具栏（搜索+筛选）/ 批量操作条 / 列表容器 */
function renderTasks(): void {
  if (!api) {
    return;
  }
  const root = $<HTMLElement>('tab-tasks');
  root.replaceChildren();
  const groups = api.skillGroups.list(true);
  if (!groups.length) {
    root.append(
      emptyState(
        'package',
        '还没有技能组',
        '先创建技能组，扫描后生成的任务会在这里按状态分组展示。',
        { label: '去技能组', icon: 'layers', onClick: () => switchTab('skills') }
      )
    );
    return;
  }

  // ── 工具栏：搜索框 + 状态筛选器 ──
  const toolbar = el('div', 'toolbar');
  const searchBox = el('div', 'search-box');
  searchBox.append(iconEl('search'));
  const searchInput = el('input');
  searchInput.type = 'text';
  searchInput.placeholder = '按条目 key 搜索任务…';
  searchInput.setAttribute('aria-label', '按条目 key 搜索任务');
  searchInput.value = taskSearch;
  const clearBtn = el('button', 'search-clear');
  clearBtn.innerHTML = iconSVG('x', 'ic ic-sm');
  clearBtn.title = '清除搜索';
  clearBtn.hidden = !taskSearch;
  clearBtn.addEventListener('click', () => {
    taskSearch = '';
    const inp = document.getElementById('task-search-input') as HTMLInputElement | null;
    if (inp) {
      inp.value = '';
      inp.focus();
    }
    clearBtn.hidden = true;
    renderTaskList();
  });
  searchInput.id = 'task-search-input';
  searchInput.addEventListener('input', () => {
    taskSearch = searchInput.value;
    clearBtn.hidden = !taskSearch;
    renderTaskList();
  });
  searchBox.append(searchInput, clearBtn);
  toolbar.append(searchBox);

  const filterSel = el('select', 'filter-select') as HTMLSelectElement;
  filterSel.id = 'task-status-filter';
  filterSel.setAttribute('aria-label', '按任务状态筛选');
  filterSel.append(new Option('全部状态', 'all'));
  for (const st of [...ACTIVE_STATUS_ORDER, 'done' as TaskStatus]) {
    filterSel.append(new Option(STATUS_META[st].label, st));
  }
  filterSel.value = taskStatusFilter;
  filterSel.addEventListener('change', () => {
    taskStatusFilter = filterSel.value as TaskStatus | 'all';
    renderTaskList();
  });
  toolbar.append(filterSel);
  const filterInfo = el('span', 'muted', '');
  filterInfo.id = 'task-filter-info';
  toolbar.append(filterInfo);
  root.append(toolbar);

  // ── 批量操作条（有选中项时显示） ──
  const batchBar = el('div', 'batchbar');
  batchBar.id = 'task-batchbar';
  batchBar.hidden = true;
  batchBar.append(el('span', 'cnt', ''));
  const bbOps = el('div', 'ops');
  bbOps.append(
    opBtn('批量重试', () => batchRetry(), {
      id: 'batch-retry-btn',
      icon: 'rotate-ccw',
      title: '重试选中的失败任务（仅失败状态可重试）',
    })
  );
  bbOps.append(
    opBtn('批量取消', () => batchCancel(), {
      id: 'batch-cancel-btn',
      cls: 'danger',
      icon: 'x',
      title: '取消选中的未完成任务',
    })
  );
  bbOps.append(
    opBtn('清除选择', () => {
      selectedTasks.clear();
      renderTaskList();
    }, { icon: 'x', title: '清除已选任务', secondary: true })
  );
  batchBar.append(bbOps);
  root.append(batchBar);

  // 批量操作结果提示（成功/失败汇总）
  const batchResult = el('div');
  batchResult.id = 'task-batch-result';
  root.append(batchResult);

  // ── 列表容器（搜索输入时只重建这里，不丢输入焦点） ──
  const listWrap = el('div');
  listWrap.id = 'task-list';
  root.append(listWrap);

  renderTaskList();
}

/** 渲染任务列表区（只重建列表容器；保留工具栏与输入焦点） */
function renderTaskList(): void {
  if (!api) {
    return;
  }
  const wrap = document.getElementById('task-list');
  if (!wrap) {
    return;
  }
  wrap.replaceChildren();
  const groups = api.skillGroups.list(true);

  // 修剪已选：任务已不存在或已变为不可选（已完成/已取消）时移出选择
  const stillSelectable = new Set<string>();
  for (const sg of groups) {
    for (const t of api.tasks.list({ skillGroupId: sg.id })) {
      if (t.status !== 'done' && t.status !== 'cancelled') {
        stillSelectable.add(t.id);
      }
    }
  }
  for (const id of [...selectedTasks]) {
    if (!stillSelectable.has(id)) {
      selectedTasks.delete(id);
    }
  }

  const filterActive = taskSearch.trim() !== '' || taskStatusFilter !== 'all';
  let matched = 0;
  let total = 0;
  let shownGroups = 0;
  for (const sg of groups) {
    const all = api.tasks.list({ skillGroupId: sg.id });
    total += all.length;
    const shown = all.filter(taskMatches);
    matched += shown.length;
    // 筛选时隐藏无匹配的技能组，保持紧凑
    if (filterActive && shown.length === 0) {
      continue;
    }
    shownGroups++;
    wrap.append(taskGroupSection(sg, filterActive ? shown : undefined));
  }

  const info = document.getElementById('task-filter-info');
  if (info) {
    info.textContent = filterActive ? `显示 ${matched} / ${total} 条` : '';
  }

  if (filterActive && shownGroups === 0) {
    // 筛选无结果：带清除筛选的空状态
    wrap.append(
      emptyState('search', '没有匹配的任务', '尝试调整关键词或更换状态筛选。', {
        label: '清除筛选',
        icon: 'x',
        onClick: () => {
          taskSearch = '';
          taskStatusFilter = 'all';
          renderTasks();
        },
      })
    );
  } else if (!filterActive && total === 0) {
    // 全部技能组都没有任务：整体空状态（原有行为）
    wrap.replaceChildren();
    wrap.append(
      emptyState(
        'inbox',
        '还没有任务',
        '技能组已就绪。点击「扫描」为符合范围的文献生成任务，任务会在这里按状态分组展示。',
        { label: '去技能组', icon: 'search', onClick: () => switchTab('skills') }
      )
    );
  }
  updateBatchBar();
}

/** 单个技能组的任务分组块；filtered 传入时只展示其中任务（搜索/筛选命中） */
function taskGroupSection(sg: SkillGroup, filtered?: Task[]): HTMLElement {
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
  const sgIcon = el('span', 'sg-ic');
  sgIcon.innerHTML = iconSVG('layers', 'ic');
  head.append(sgIcon);
  head.append(el('h3', '', sg.name));
  head.append(groupBadge(sg));
  const countEl = el('span', 'count', '');
  const strongDone = el('strong', '', String(done));
  const strongUndone = el('strong', '', String(undone));
  countEl.append('完成 ', strongDone, ' · 未完成 ', strongUndone);
  head.append(countEl);
  sec.append(head);

  const ops = el('div', 'ops');
  ops.append(
    opBtn(sg.enabled ? '暂停' : '恢复', () => setSkillEnabled(sg, !sg.enabled), {
      icon: sg.enabled ? 'pause' : 'play',
      title: sg.enabled ? '暂停领取：不再生成新任务并暂停外部领取' : '恢复领取',
    })
  );
  const rescanBtn = opBtn('扫描', () => rescan(sg.id), {
    icon: 'search',
    title: '重新扫描该技能组范围，生成新任务',
  });
  rescanBtn.id = `rescan-btn-${sg.id}`;
  ops.append(rescanBtn);
  sec.append(ops);

  // 扫描进度条（扫描时显示 done/total + 进度）
  const prog = el('div', 'scan-prog');
  prog.id = `scan-prog-${sg.id}`;
  prog.hidden = true;
  const track = el('div', 'prog-track');
  const fill = el('div', 'prog-fill');
  fill.id = `scan-fill-${sg.id}`;
  track.append(fill);
  const ptext = el('span', 'prog-text');
  ptext.id = `scan-text-${sg.id}`;
  prog.append(track, ptext);
  sec.append(prog);

  // —— 明细：各状态分组（图标+标签+计数；筛选时只展示有命中的分组） ——
  const tasks = filtered ?? api!.tasks.list({ skillGroupId: sg.id });
  const filtering = filtered !== undefined;
  for (const st of ACTIVE_STATUS_ORDER) {
    const items = tasks.filter((t) => t.status === st);
    if (filtering && items.length === 0) {
      continue;
    }
    const det = el('details', 'status-group');
    det.open = items.length > 0 && st !== 'cancelled';
    const sum = el('summary');
    const sumIc = el('span', 'sum-ic');
    sumIc.style.color = `var(--${STATUS_META[st].badge === 'accent' ? 'accent' : STATUS_META[st].badge})`;
    sumIc.innerHTML = iconSVG(STATUS_META[st].icon, 'ic ic-sm');
    sum.append(sumIc);
    sum.append(document.createTextNode(`${STATUS_META[st].label}（${items.length}）`));
    const chev = el('span', 'chev');
    chev.innerHTML = iconSVG('chevron-down', 'ic ic-sm');
    sum.append(chev);
    det.append(sum);
    if (!items.length) {
      det.append(el('div', 'task-none', '暂无'));
    }
    for (const t of items) {
      det.append(taskItem(t));
    }
    sec.append(det);
  }
  // 已完成：可折叠列表，支持展开详情
  const dones = tasks.filter((t) => t.status === 'done');
  if (!filtering || dones.length > 0) {
    const doneDet = el('details', 'status-group');
    const doneSum = el('summary');
    const doneIc = el('span', 'sum-ic');
    doneIc.style.color = 'var(--ok)';
    doneIc.innerHTML = iconSVG('check-circle', 'ic ic-sm');
    doneSum.append(doneIc);
    doneSum.append(document.createTextNode(`已完成（${dones.length}）`));
    const doneChev = el('span', 'chev');
    doneChev.innerHTML = iconSVG('chevron-down', 'ic ic-sm');
    doneSum.append(doneChev);
    doneDet.append(doneSum);
    if (!dones.length) {
      doneDet.append(el('div', 'task-none', '暂无'));
    }
    for (const t of dones) {
      doneDet.append(taskItem(t));
    }
    sec.append(doneDet);
  }
  return sec;
}

/** 相对时间小标签（悬停显示绝对时间） */
function relTime(ts: number | null | undefined): HTMLElement {
  const s = el('span', 'muted reltime', fmtRelative(ts));
  s.title = fmtTime(ts);
  return s;
}

/** 单条任务（含展开详情）外层容器：展开按钮 + 多选框 + 任务行 + 详情区 */
function taskItem(t: Task): HTMLElement {
  const item = el('div', 'task-item');
  const expanded = expandedTasks.has(t.id);
  if (expanded) {
    item.classList.add('expanded');
  }
  const row = el('div', 'task-row');

  // 展开/收起详情
  const expBtn = el('button', 'exp-btn');
  expBtn.innerHTML = iconSVG('chevron-down', 'ic ic-sm');
  expBtn.title = expanded ? '收起任务详情' : '展开任务详情';
  expBtn.setAttribute('aria-expanded', String(expanded));
  expBtn.setAttribute('aria-label', expanded ? '收起任务详情' : '展开任务详情');
  expBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTaskDetail(t.id);
  });
  row.append(expBtn);

  // 多选框：仅未完成且未取消的任务可参与批量操作
  if (t.status !== 'done' && t.status !== 'cancelled') {
    const cb = el('input', 'task-check');
    cb.type = 'checkbox';
    cb.checked = selectedTasks.has(t.id);
    cb.title = '选中该任务以批量操作';
    cb.setAttribute('aria-label', `选中任务 ${t.itemKey}`);
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) {
        selectedTasks.add(t.id);
      } else {
        selectedTasks.delete(t.id);
      }
      updateBatchBar();
    });
    row.append(cb);
  }

  const info = el('div', 'task-info');
  const line1 = el('div');
  line1.append(el('span', 'mono', t.itemKey));
  line1.append(document.createTextNode('　'));
  line1.append(el('span', 'muted', '创建 '));
  line1.append(relTime(t.createdAt));
  line1.append(el('span', 'muted', ' · 领取 '));
  line1.append(relTime(t.claimedAt));
  line1.append(el('span', 'muted', ' · 完成 '));
  line1.append(relTime(t.completedAt));
  info.append(line1);
  if (t.lastError) {
    const errLine = el('div', 'err-inline');
    errLine.append(iconEl('alert-circle', 'ic ic-sm'));
    errLine.append(document.createTextNode(`失败原因：${t.lastError}`));
    info.append(errLine);
  }
  row.append(info);

  const ops = el('div', 'ops');
  if (t.status === 'failed') {
    ops.append(
      opBtn('重试', () => retryTask(t.id), {
        icon: 'rotate-ccw',
        title: '将任务放回待领取队列',
        secondary: true,
      })
    );
  }
  if (t.status !== 'done' && t.status !== 'cancelled') {
    ops.append(
      opBtn('取消', () => cancelTask(t.id), {
        cls: 'danger',
        icon: 'x',
        title: '取消该任务，不再领取',
        secondary: true,
      })
    );
  }
  row.append(ops);

  // 点击行空白处（非交互元素）切换详情展开
  row.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, select, textarea')) {
      return;
    }
    toggleTaskDetail(t.id);
  });

  item.append(row);
  if (expanded) {
    item.append(taskDetail(t));
  }
  return item;
}

/** 切换任务详情展开/收起 */
function toggleTaskDetail(id: string): void {
  if (expandedTasks.has(id)) {
    expandedTasks.delete(id);
  } else {
    expandedTasks.add(id);
  }
  renderTaskList();
}

/** 任务详情区：指令快照 / 技能组版本 / 材料清单 / 交付物 / 时间线 / 尝试次数 */
function taskDetail(t: Task): HTMLElement {
  const d = el('div', 'task-detail');
  const sg = api?.skillGroups.get(t.skillGroupId);

  const grid = el('div', 'detail-grid');
  grid.append(detailKV('技能组', sg?.name ?? '（技能组已删除）'));
  grid.append(detailKV('技能组版本', `v${t.skillGroupVersion}`));
  grid.append(detailKV('尝试次数', String(t.attempts)));
  d.append(grid);

  // 领取时的指令快照
  const insSec = el('div', 'd-sec');
  insSec.append(el('h4', '', '领取时指令快照'));
  insSec.append(el('div', 'instruction', t.instructionSnapshot || '（空）'));
  d.append(insSec);

  // 材料清单（按技能组当前 materials 配置逐项列出）
  const matSec = el('div', 'd-sec');
  matSec.append(el('h4', '', '材料清单（按技能组当前配置）'));
  if (sg) {
    const items = materialItems(sg.materials);
    const ul = el('ul', 'd-list');
    if (items.length) {
      for (const s of items) {
        ul.append(el('li', '', s));
      }
    } else {
      ul.append(el('li', '', '未配置输入材料'));
    }
    matSec.append(ul);
  } else {
    matSec.append(el('div', 'muted', '技能组信息不可用'));
  }
  d.append(matSec);

  // 交付物（v1 固定为内建笔记）
  const delSec = el('div', 'd-sec');
  delSec.append(el('h4', '', '交付物'));
  const delGrid = el('div', 'detail-grid');
  delGrid.append(detailKV('类型', '内建笔记'));
  delGrid.append(detailKV('笔记 key', t.noteKey ?? '尚未写入', !!t.noteKey));
  delGrid.append(detailKV('写入状态', t.noteKey ? '已写入' : '—'));
  delSec.append(delGrid);
  d.append(delSec);

  // 时间线：创建 → 领取 → 完成
  const tlSec = el('div', 'd-sec');
  tlSec.append(el('h4', '', '时间线'));
  const tl = el('ul', 'timeline');
  tl.append(timelineStep('创建', t.createdAt));
  tl.append(timelineStep('领取', t.claimedAt));
  tl.append(timelineStep('完成', t.completedAt));
  tlSec.append(tl);
  d.append(tlSec);

  return d;
}

/** 详情键值行 */
function detailKV(k: string, v: string, mono = false): HTMLElement {
  const d = el('div', 'd-kv');
  d.append(el('span', 'k', `${k}：`));
  d.append(el('span', mono ? 'mono' : '', v));
  return d;
}

/** 时间线步骤（无时间则置灰显示"—"） */
function timelineStep(label: string, ts: number | null | undefined): HTMLElement {
  const li = el('li');
  if (!ts) {
    li.classList.add('miss');
  }
  li.append(el('span', 't-dot'));
  li.append(el('span', '', label));
  li.append(el('span', 'muted', ts ? `${fmtRelative(ts)}（${fmtTime(ts)}）` : '—'));
  return li;
}

/** 技能组 materials 配置 → 中文材料项列表 */
function materialItems(m: SkillMaterials): string[] {
  const parts: string[] = [];
  if (m.includeMetadata) {
    parts.push('文献基本信息（标题/作者/年份/条目 key）');
  }
  if (m.includeAbstract) {
    parts.push('摘要');
  }
  if (m.includeNotes) {
    parts.push('已有笔记（标题 + 文本）');
  }
  if (m.pdf === 'earliest') {
    parts.push('最早加入的本地 PDF 路径');
  }
  return parts;
}

/** 刷新批量操作条（选中计数 + 按钮可用性） */
function updateBatchBar(): void {
  const bar = document.getElementById('task-batchbar');
  if (!bar || !api) {
    return;
  }
  const n = selectedTasks.size;
  bar.hidden = n === 0;
  const cnt = bar.querySelector('.cnt');
  if (cnt) {
    cnt.textContent = `已选 ${n} 项`;
  }
  // 批量重试仅当选中包含失败任务时可用
  let failedCount = 0;
  for (const id of selectedTasks) {
    if (api.tasks.get(id)?.status === 'failed') {
      failedCount++;
    }
  }
  const retryBtn = document.getElementById('batch-retry-btn') as HTMLButtonElement | null;
  if (retryBtn) {
    retryBtn.disabled = failedCount === 0;
    retryBtn.title =
      failedCount === 0 ? '选中的任务中没有失败待重试的任务' : `重试选中的 ${failedCount} 条失败任务`;
  }
}

/** 批量重试：仅 failed 可选；操作前 confirm；逐条调用后汇总结果 */
async function batchRetry(): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  const targets: Task[] = [];
  for (const id of selectedTasks) {
    const t = api.tasks.get(id);
    if (t && t.status === 'failed') {
      targets.push(t);
    }
  }
  if (!targets.length) {
    showError('选中的任务中没有失败待重试的任务。');
    return;
  }
  if (
    !window.confirm(
      `确定重试选中的 ${targets.length} 条失败任务吗？（共选中 ${selectedTasks.size} 项）\n重试后任务将回到待领取队列。`
    )
  ) {
    return;
  }
  let ok = 0;
  const errs: string[] = [];
  for (const t of targets) {
    try {
      await api.tasks.retry(t.id);
      ok++;
    } catch (e) {
      errs.push(`${t.itemKey}：${errMsg(e)}`);
    }
  }
  selectedTasks.clear();
  await refreshTab('tasks');
  showBatchResult(
    errs.length === 0,
    `批量重试完成：成功 ${ok} 条${errs.length ? `，失败 ${errs.length} 条（${errs.join('；')}）` : ''}。`
  );
}

/** 批量取消：未完成可选；操作前 confirm；逐条调用后汇总结果 */
async function batchCancel(): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  const targets: Task[] = [];
  for (const id of selectedTasks) {
    const t = api.tasks.get(id);
    if (t && t.status !== 'done' && t.status !== 'cancelled') {
      targets.push(t);
    }
  }
  if (!targets.length) {
    showError('选中的任务中没有可取消的未完成任务。');
    return;
  }
  if (
    !window.confirm(
      `确定取消选中的 ${targets.length} 条未完成任务吗？\n取消后任务不再被领取，已生成的数据保留。`
    )
  ) {
    return;
  }
  let ok = 0;
  const errs: string[] = [];
  for (const t of targets) {
    try {
      await api.tasks.cancel(t.id);
      ok++;
    } catch (e) {
      errs.push(`${t.itemKey}：${errMsg(e)}`);
    }
  }
  selectedTasks.clear();
  await refreshTab('tasks');
  showBatchResult(
    errs.length === 0,
    `批量取消完成：成功 ${ok} 条${errs.length ? `，失败 ${errs.length} 条（${errs.join('；')}）` : ''}。`
  );
}

/** 批量操作结果提示（8 秒后自动消失） */
function showBatchResult(ok: boolean, text: string): void {
  const box = document.getElementById('task-batch-result');
  if (!box) {
    return;
  }
  box.replaceChildren();
  const n = el('div', `notice ${ok ? 'ok' : 'danger'}`);
  n.append(iconEl(ok ? 'check-circle' : 'alert-circle', 'ic'));
  n.append(document.createTextNode(text));
  box.append(n);
  window.setTimeout(() => {
    box.replaceChildren();
  }, 8000);
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

/** 重新扫描技能组范围（进度条显示 scanned/created 进度） */
async function rescan(skillGroupId: string): Promise<void> {
  if (!api || scanBusy) {
    return;
  }
  scanBusy = skillGroupId;
  clearError();
  const setProg = (done: number, total: number, text: string): void => {
    const progEl = document.getElementById(`scan-prog-${skillGroupId}`);
    const fillEl = document.getElementById(`scan-fill-${skillGroupId}`);
    const textEl = document.getElementById(`scan-text-${skillGroupId}`);
    if (progEl) {
      progEl.hidden = false;
    }
    if (fillEl) {
      fillEl.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
    }
    if (textEl) {
      textEl.textContent = text;
    }
  };
  const btnEl = document.getElementById(`rescan-btn-${skillGroupId}`) as HTMLButtonElement | null;
  if (btnEl) {
    btnEl.disabled = true;
  }
  try {
    const result = await api.generator.scanSkillGroup(skillGroupId, {
      onProgress: (done, total) => {
        setProg(done, total, `扫描中… ${done}/${total}`);
      },
    });
    const summary =
      `扫描完成：已扫描 ${result.scanned}，新建 ${result.created}，` +
      `跳过 ${result.skipped}，等待材料 ${result.waitingMaterial}，转为待领取 ${result.promoted}`;
    await refreshTab('tasks');
    // refreshTab 重建了 DOM，重新定位进度元素以保留结果摘要
    setProg(1, 1, summary);
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

// ════════════════════════ 顶栏快捷操作 ════════════════════════

/** 绑定顶栏"快捷操作"下拉菜单（点击外部 / Esc 关闭） */
function bindQuickActions(): void {
  const qaBtn = $<HTMLButtonElement>('btn-quick');
  const qaMenu = $<HTMLDivElement>('qa-menu');
  qaBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = qaMenu.hidden;
    if (opening) {
      refreshQuickMenu();
    }
    qaMenu.hidden = !opening;
    qaBtn.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', (e) => {
    if (!qaMenu.hidden && !(e.target as HTMLElement).closest('.qa-wrap')) {
      qaMenu.hidden = true;
      qaBtn.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !qaMenu.hidden) {
      qaMenu.hidden = true;
      qaBtn.setAttribute('aria-expanded', 'false');
      qaBtn.focus();
    }
  });
  $<HTMLButtonElement>('qa-scan-all').addEventListener('click', () => {
    qaMenu.hidden = true;
    qaBtn.setAttribute('aria-expanded', 'false');
    void scanAllGroups().catch((e: unknown) => showError(`全部扫描失败：${errMsg(e)}`));
  });
  $<HTMLButtonElement>('qa-pause-all').addEventListener('click', () => {
    qaMenu.hidden = true;
    qaBtn.setAttribute('aria-expanded', 'false');
    void togglePauseAll().catch((e: unknown) => showError(`操作失败：${errMsg(e)}`));
  });
  $<HTMLButtonElement>('global-close').addEventListener('click', () => {
    $<HTMLDivElement>('global-scan').hidden = true;
  });
}

/** 打开菜单前刷新"暂停/恢复全部领取"标签（按当前技能组启停状态决定） */
function refreshQuickMenu(): void {
  if (!api) {
    return;
  }
  const groups = api.skillGroups.list(true).filter((sg) => !sg.archived);
  const anyEnabled = groups.some((sg) => sg.enabled);
  const item = $<HTMLButtonElement>('qa-pause-all');
  item.innerHTML = `${iconSVG(anyEnabled ? 'pause' : 'play', 'ic')}<span>${anyEnabled ? '暂停全部领取' : '恢复全部领取'}</span>`;
  item.title = anyEnabled
    ? '停用全部未归档技能组：不再生成新任务、外部 AI 无法领取'
    : '恢复全部未归档技能组的领取';
}

/** 全部技能组重新扫描（调 generator.scanAllEnabled；语义与单组"扫描"一致） */
async function scanAllGroups(): Promise<void> {
  if (!api || scanAllRunning || scanBusy) {
    return;
  }
  scanAllRunning = true;
  clearError();
  const bar = $<HTMLDivElement>('global-scan');
  const fill = $<HTMLDivElement>('global-fill');
  const text = $<HTMLSpanElement>('global-text');
  bar.hidden = false;
  fill.style.width = '0%';
  text.textContent = '全部扫描中…';
  try {
    const results = await api.generator.scanAllEnabled({
      onProgress: (done, total) => {
        fill.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
        text.textContent = `全部扫描中… ${done}/${total}`;
      },
    });
    const agg = results.reduce(
      (a, r) => ({
        scanned: a.scanned + r.scanned,
        created: a.created + r.created,
        skipped: a.skipped + r.skipped,
        waitingMaterial: a.waitingMaterial + r.waitingMaterial,
        promoted: a.promoted + r.promoted,
      }),
      { scanned: 0, created: 0, skipped: 0, waitingMaterial: 0, promoted: 0 }
    );
    fill.style.width = '100%';
    text.textContent =
      `全部扫描完成（${results.length} 个技能组）：已扫描 ${agg.scanned}，` +
      `新建 ${agg.created}，跳过 ${agg.skipped}，等待材料 ${agg.waitingMaterial}，转为待领取 ${agg.promoted}`;
    await refreshTab(activeTab);
  } catch (e) {
    bar.hidden = true;
    showError(`全部扫描失败：${errMsg(e)}`);
  } finally {
    scanAllRunning = false;
  }
}

/** 一键暂停/恢复全部领取：有任一启用则全部停用，否则全部恢复（暂停前 confirm） */
async function togglePauseAll(): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  const groups = api.skillGroups.list(true).filter((sg) => !sg.archived);
  if (!groups.length) {
    showError('没有可操作的技能组。');
    return;
  }
  const anyEnabled = groups.some((sg) => sg.enabled);
  const target = !anyEnabled;
  if (!target) {
    if (
      !window.confirm(
        `确定暂停全部 ${groups.length} 个技能组的领取吗？\n暂停后不再生成新任务、外部 AI 无法领取，已有任务保留，可随时恢复。`
      )
    ) {
      return;
    }
  }
  try {
    for (const sg of groups) {
      if (sg.enabled !== target) {
        await api.skillGroups.setEnabled(sg.id, target);
      }
    }
    await refreshTab(activeTab);
  } catch (e) {
    showError(`${target ? '恢复' : '暂停'}全部领取失败：${errMsg(e)}`);
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
  const head = el('div', 'card-head');
  const sgIcon = el('span', 'sg-ic');
  sgIcon.innerHTML = iconSVG('server', 'ic');
  head.append(sgIcon);
  head.append(el('h3', '', 'MCP 服务'));
  const stBadge = el('span', `badge ${enabled ? 'ok' : 'muted'}`);
  stBadge.append(iconEl(enabled ? 'zap' : 'power', 'ic ic-sm'));
  stBadge.append(document.createTextNode(enabled ? '运行中' : '已停止'));
  head.append(stBadge);
  card.append(head);

  // 启用开关
  const toggleRow = el('div', 'mcp-row');
  toggleRow.append(el('span', 'k', '服务开关'));
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.className = 'switch';
  toggle.checked = enabled;
  toggle.title = enabled ? '停用 MCP 服务' : '启用 MCP 服务';
  toggle.setAttribute('aria-label', 'MCP 服务开关');
  toggle.addEventListener('change', () => {
    void setMcpEnabled(toggle.checked);
  });
  toggleRow.append(toggle);
  toggleRow.append(el('span', '', enabled ? '已启用' : '已停用'));
  card.append(toggleRow);

  // 服务端点（一键复制）
  const urlRow = el('div', 'mcp-row');
  urlRow.append(el('span', 'k', '服务端点'));
  if (port !== null) {
    const url = `http://127.0.0.1:${port}${path}`;
    const urlBox = el('div', 'url-box', url);
    urlBox.title = 'MCP HTTP 端点（仅本机可访问）';
    urlRow.append(urlBox);
    urlRow.append(
      opBtn('复制', (b) => copyText(url, b), { icon: 'copy', title: '复制服务端点 URL' })
    );
  } else {
    urlRow.append(el('span', 'muted', '端口未知（Zotero 服务端口未检出）'));
  }
  card.append(urlRow);

  // token 显示 + 复制 + 重新生成
  const tokenRow = el('div', 'mcp-row');
  tokenRow.append(el('span', 'k', '访问 token'));
  const tokenBox = el('div', 'token-box', token);
  tokenBox.title = '领取与提交接口需携带该 token（Bearer）';
  tokenRow.append(tokenBox);
  const tokenCopyBtn = opBtn('复制', (b) => copyText(token, b), {
    icon: 'copy',
    title: '复制访问 token',
    secondary: true,
  });
  tokenRow.append(tokenCopyBtn);
  const regenBtn = opBtn('更换', () => regenerateToken(), {
    icon: 'key',
    title: '重新生成访问 token，旧 token 立即失效',
    secondary: true,
  });
  tokenRow.append(regenBtn);
  card.append(tokenRow);
  card.append(
    el('div', 'hint', '领取与提交接口均需携带该 token；更换后旧 token 立即失效，外部 AI 客户端需要更新配置。')
  );

  // 关闭时的明确提示
  const notice = el('div', 'notice');
  notice.append(iconEl('alert-circle', 'ic'));
  notice.append(
    document.createTextNode('MCP 服务已停止监听，不再接受外部领取与提交请求。')
  );
  notice.id = 'mcp-stopped-notice';
  notice.hidden = enabled;
  card.append(notice);

  root.append(card);
  root.append(auditCard());
}

/** 领取/提交记录卡片：从任务的 claimedAt/completedAt/attempts/lastError/noteKey
 *  派生最近 AUDIT_LIMIT 条事件（领取/完成/失败），只读展示 */
function auditCard(): HTMLElement {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  const sgIcon = el('span', 'sg-ic');
  sgIcon.innerHTML = iconSVG('activity', 'ic');
  head.append(sgIcon);
  head.append(el('h3', '', '领取/提交记录'));
  head.append(el('span', 'count', `最近 ${AUDIT_LIMIT} 条`));
  card.append(head);

  interface AuditEvent {
    ts: number;
    kind: 'claim' | 'done' | 'fail';
    task: Task;
  }
  const events: AuditEvent[] = [];
  for (const t of api!.tasks.list()) {
    if (t.claimedAt) {
      events.push({ ts: t.claimedAt, kind: 'claim', task: t });
    }
    if (t.completedAt) {
      events.push({ ts: t.completedAt, kind: 'done', task: t });
    }
    if (t.status === 'failed') {
      // 失败事件时间取领取时间（失败发生在领取之后），从未领取则回退创建时间
      events.push({ ts: t.claimedAt ?? t.createdAt, kind: 'fail', task: t });
    }
  }
  events.sort((a, b) => b.ts - a.ts);
  const recent = events.slice(0, AUDIT_LIMIT);

  if (!recent.length) {
    card.append(el('div', 'muted', '暂无领取/提交记录。'));
    return card;
  }
  const KIND_META = {
    claim: { label: '领取任务', cls: 'accent', icon: 'zap' },
    done: { label: '提交完成', cls: 'ok', icon: 'check-circle' },
    fail: { label: '任务失败', cls: 'danger', icon: 'alert-circle' },
  } as const;
  const list = el('div', 'audit-list');
  for (const ev of recent) {
    const km = KIND_META[ev.kind];
    const row = el('div', 'audit-row');
    const aic = el('span', `audit-ic ${km.cls}`);
    aic.innerHTML = iconSVG(km.icon, 'ic');
    row.append(aic);
    const info = el('div', 'task-info');
    const l1 = el('div');
    l1.append(el('span', '', km.label));
    l1.append(document.createTextNode('　'));
    l1.append(el('span', 'mono', ev.task.itemKey));
    info.append(l1);
    const sgName = api!.skillGroups.get(ev.task.skillGroupId)?.name ?? '（技能组已删除）';
    let sub = sgName;
    if (ev.kind === 'done' && ev.task.noteKey) {
      sub += ` · 笔记 ${ev.task.noteKey}`;
    }
    if (ev.kind === 'fail' && ev.task.lastError) {
      sub += ` · ${ev.task.lastError}`;
    }
    info.append(el('div', 'muted', sub));
    row.append(info);
    row.append(relTime(ev.ts));
    list.append(row);
  }
  card.append(list);
  return card;
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
