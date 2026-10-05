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
 * 所有异步操作均 try/catch 并在面板顶部显示本地化错误提示（getString）。
 * 静态 xhtml 文案在 init() 经 applyStaticI18n() 本地化。
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
  SkillAssetManifest,
  SkillDeliverable,
  SkillGroup,
  SkillGroupCreateData,
  SkillMaterials,
  SkillScope,
  SkillTaskAPI,
  Task,
  TaskStatus,
} from './types';
import { deliverableLabel } from './deliverables';
import { initLocale, getString } from './utils/locale';
import {
  prefs,
  PREFS,
  isMacPlatform,
  normalizeShortcutKey,
  isShortcutEnabled,
} from './prefs';
import { getPanelShortcutLabel, isShortcutKeyReserved } from './ui';

/** 选项卡 id */
type TabId = 'skills' | 'tasks' | 'mcp' | 'settings';

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
  'external-link':
    '<path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
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
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.4 1.08V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8.6 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.08-.4H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .4-1.08V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15.4 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9"/>',
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
  'waiting-material': { label: getString('panel-status-waiting-material'), badge: 'warn', icon: 'clock' },
  pending: { label: getString('panel-status-pending'), badge: 'accent', icon: 'inbox' },
  claimed: { label: getString('panel-status-claimed'), badge: 'accent', icon: 'zap' },
  done: { label: getString('panel-status-done'), badge: 'ok', icon: 'check-circle' },
  failed: { label: getString('panel-status-failed'), badge: 'danger', icon: 'alert-circle' },
  cancelled: { label: getString('panel-status-cancelled'), badge: 'muted', icon: 'x-circle' },
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
  const text = sg.archived ? getString('panel-sg-archived') : sg.enabled ? getString('panel-sg-enabled') : getString('panel-sg-disabled');
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

function resolveTaskItem(itemKey: string): any | null {
  try {
    const Z: any = Zotero as any;
    const libs = Z?.Libraries?.getAll?.() ?? [];
    for (const lib of libs) {
      const item = Z?.Items?.getByLibraryAndKey?.(lib.libraryID, itemKey);
      if (item && item !== false && item.isRegularItem?.()) return item;
    }
  } catch {
    // ignore
  }
  return null;
}

async function revealTaskItem(itemKey: string): Promise<void> {
  const item = resolveTaskItem(itemKey);
  if (!item) throw new Error(getString('panel-detail-item-missing'));
  const Z: any = Zotero as any;
  const win = Z?.getMainWindow?.();
  const pane = win?.ZoteroPane ?? Z?.getActiveZoteroPane?.();
  if (!pane?.selectItem) throw new Error(getString('panel-detail-library-unavailable'));
  await pane.selectItem(item.id);
  try { win?.focus?.(); } catch { /* ignore */ }
}

/** 按 id 取元素（找不到直接抛错，属面板自身 bug） */
function $<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) {
    throw new Error(getString('panel-err-missing-element', { id }));
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
    return getString('panel-time-just-now');
  }
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) {
    return getString('panel-time-just-now');
  }
  if (minutes < 60) {
    return getString('panel-time-minutes-ago', { n: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return getString('panel-time-hours-ago', { n: hours });
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return getString('panel-time-days-ago', { n: days });
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
      .catch((e: unknown) => showError(getString('panel-err-op-failed', { error: errMsg(e) })));
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
      throw new Error(getString('panel-err-clipboard-unavailable'));
    }
    const orig = btn.innerHTML;
    btn.innerHTML = `${iconSVG('check', 'ic')}${getString('panel-copied')}`;
    btn.disabled = true;
    window.setTimeout(() => {
      btn.innerHTML = orig;
      btn.disabled = false;
    }, 1200);
  } catch (e) {
    showError(getString('panel-err-copy-failed-manual', { error: errMsg(e) }));
  }
}

/** 骨架屏：按目标选项卡的最终布局占位（加载中不用转圈） */
function renderSkeleton(tab: TabId): void {
  const root = $<HTMLElement>(`tab-${tab}`);
  root.replaceChildren();
  const wrap = el('div');
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', getString('panel-aria-loading'));
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
  } else if (tab === 'mcp') {
    wrap.append(card(['30%', '60%', '75%', '50%']));
  } else {
    wrap.append(card(['30%', '75%', '75%']));
    wrap.append(card(['30%', '65%', '65%']));
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
/** 任务状态大栏目的展开状态；重绘任务列表时必须保持用户当前折叠/展开选择 */
const taskStatusGroupOpen = new Map<string, boolean>();
/** MCP 审计视图展示的最近事件条数 */
const AUDIT_LIMIT = 20;

// ────────────────────────── 静态文案国际化 ──────────────────────────

/**
 * 替换"图标 + 文字"按钮里的文字节点（保留 inline SVG）。
 */
function setStaticText(id: string, text: string): void {
  const btn = document.getElementById(id);
  if (!btn) return;
  for (const child of Array.from(btn.childNodes)) {
    if (!child) continue;
    if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim()) {
      child.textContent = text;
      return;
    }
  }
  btn.textContent = text;
}

/**
 * panel.xhtml 里硬编码的静态文案（title/按钮/选项卡/降级提示）同样走 getString()，
 * 保证 Zotero 界面语言为英文时面板无中文残留（需求单 需求1 验收）。
 * 在 init() 最开头调用；任一元素缺失不抛错（防御性）。
 */
function applyStaticI18n(): void {
  try {
    document.title = getString('panel-doc-title');
  } catch {
    // ignore
  }
  try {
    const h1 = document.querySelector('header.top h1');
    if (h1) {
      for (const child of Array.from(h1.childNodes)) {
        if (!child) continue;
        if (
          child.nodeType === Node.TEXT_NODE &&
          (child.textContent ?? '').trim()
        ) {
          child.textContent = getString('panel-app-title');
          break;
        }
      }
    }
    const setTitle = (id: string, text: string): void => {
      const el = document.getElementById(id);
      if (el) el.title = text;
    };
    setTitle('btn-quick', getString('panel-qa-title-attr'));
    setTitle('btn-refresh', getString('panel-btn-refresh-title'));
    setTitle('btn-close', getString('panel-btn-close-title'));
    setTitle('error-close', getString('panel-err-close-title'));
    setTitle('global-close', getString('panel-prog-close-title'));
    setStaticText('btn-quick', getString('panel-qa-label'));
    setStaticText('qa-scan-all', getString('panel-qa-scan-all'));
    setStaticText('btn-refresh', getString('panel-btn-refresh'));
    setStaticText('btn-close', getString('panel-btn-close'));
    setStaticText('tabbtn-skills', getString('panel-tab-skills'));
    setStaticText('tabbtn-tasks', getString('panel-tab-tasks'));
    setStaticText('tabbtn-mcp', getString('panel-tab-mcp'));
    setStaticText('tabbtn-settings', getString('panel-tab-settings'));
    // 插件核心未挂载时的降级提示
    const nrTitle = document.querySelector('#not-ready h3');
    if (nrTitle) nrTitle.textContent = getString('panel-notready-title');
    const nrDesc = document.querySelector('#not-ready p');
    if (nrDesc) nrDesc.textContent = getString('panel-notready-desc');
    setStaticText('btn-notready-retry', getString('panel-notready-retry'));
  } catch {
    // 静态文案本地化失败不阻塞面板初始化
  }
}

// ────────────────────────── 初始化 ──────────────────────────

function init(): void {
  const bootStatus = document.getElementById('boot-status') as HTMLElement | null;
  if (bootStatus) {
    bootStatus.textContent = '面板脚本已启动，正在连接插件核心…';
  }

  // 需求单 需求1：JS 侧 Fluent 国际化（文案唯一来源为 ftl，构建时提取）
  initLocale();
  // panel.xhtml 里的静态文案（title/按钮/选项卡/降级提示）同样走 getString
  applyStaticI18n();

  // 静态按钮绑定
  $<HTMLButtonElement>('btn-refresh').addEventListener('click', () => {
    clearError();
    void refreshAll().catch((e: unknown) => showError(getString('panel-err-refresh-failed', { error: errMsg(e) })));
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
  for (const t of ['skills', 'tasks', 'mcp', 'settings'] as TabId[]) {
    $<HTMLButtonElement>(`tabbtn-${t}`).addEventListener('click', () => switchTab(t));
  }
  bindQuickActions();

  api = getAPI();
  if (!api) {
    // 插件核心未就绪：降级显示提示，主界面隐藏；若 startup 留下具体错误则一并展示。
    $<HTMLDivElement>('main-ui').hidden = true;
    $<HTMLDivElement>('not-ready').hidden = false;
    if (bootStatus) bootStatus.remove();
    try {
      const startupError = String((Zotero as any)?.SkillTaskStartupError ?? '').trim();
      if (startupError) {
        const desc = document.querySelector('#not-ready p');
        if (desc) {
          desc.textContent = `${getString('panel-notready-desc')}（${startupError}）`;
        }
      }
    } catch {
      // ignore
    }
    return;
  }
  $<HTMLSpanElement>('ver').textContent = `v${api.version}`;
  if (bootStatus) bootStatus.remove();
  // 先按最终布局占位骨架屏，再异步刷新真实数据
  renderSkeleton('skills');
  renderSkeleton('tasks');
  renderSkeleton('mcp');
  renderSkeleton('settings');
  void refreshAll().catch((e: unknown) => showError(getString('panel-err-load-failed', { error: errMsg(e) })));
}

/** 切换选项卡 */
function switchTab(tab: TabId): void {
  activeTab = tab;
  clearError();
  for (const t of ['skills', 'tasks', 'mcp', 'settings'] as TabId[]) {
    $<HTMLButtonElement>(`tabbtn-${t}`).classList.toggle('active', t === tab);
    $<HTMLElement>(`tab-${t}`).hidden = t !== tab;
  }
  void refreshTab(tab).catch((e: unknown) => showError(getString('panel-err-load-failed', { error: errMsg(e) })));
}

/** 刷新全部选项卡 */
async function refreshAll(): Promise<void> {
  await refreshTab('skills');
  await refreshTab('tasks');
  await refreshTab('mcp');
  await refreshTab('settings');
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
  } else if (tab === 'mcp') {
    renderMcp();
  } else {
    renderSettings();
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
    const ph = el('div', 'statbar-empty', getString('panel-statbar-empty'));
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
      ? getString('panel-statbar-empty')
      : STATBAR_ORDER.map((st) => `${STATUS_META[st].label} ${counts[st] ?? 0}`)
          .join('，');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', getString('panel-statbar-aria', { desc }));
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
  if (sg.description) {
    card.append(el('div', 'instruction', sg.description));
  } else if (sg.instruction) {
    card.append(el('div', 'instruction', sg.instruction));
  }
  const assetSummary = el('div', 'summary', getString('panel-sg-assets-loading'));
  card.append(assetSummary);
  void api!.skillGroups.getAssetManifest(sg.id).then((manifest) => {
    const skillPart = manifest.skillFile
      ? getString('panel-sg-skill-file-ready')
      : getString('panel-sg-skill-file-missing');
    const refsPart = sg.referencesEnabled
      ? getString('panel-sg-references-count', { n: manifest.references.length })
      : getString('panel-sg-references-off');
    assetSummary.textContent = `${skillPart} · ${refsPart}`;
  }).catch(() => {
    assetSummary.textContent = getString('panel-sg-assets-unavailable');
  });

  // 更新时间（相对时间，title 里放绝对时间）
  const meta = el('div', 'meta-line');
  meta.append(iconEl('clock', 'ic ic-sm'));
  const rel = el('span', 'reltime', getString('panel-sg-updated-at', { time: fmtRelative(sg.updatedAt) }));
  rel.title = fmtTime(sg.updatedAt);
  meta.append(rel);
  card.append(meta);

  const ops = el('div', 'ops');
  ops.append(
    opBtn(getString('panel-action-edit'), () => openForm(sg.id), { icon: 'edit', title: getString('panel-action-edit-sg-title') })
  );
  ops.append(
    opBtn(sg.enabled ? getString('panel-action-disable') : getString('panel-action-enable'), () => setSkillEnabled(sg, !sg.enabled), {
      icon: sg.enabled ? 'pause' : 'play',
      title: sg.enabled ? getString('panel-action-disable-title') : getString('panel-action-enable-title'),
      secondary: true,
    })
  );
  ops.append(
    opBtn(getString('panel-action-copy'), () => copySkillGroup(sg.id), {
      icon: 'copy',
      title: getString('panel-action-copy-sg-title'),
      secondary: true,
    })
  );
  if (!sg.archived) {
    ops.append(
      opBtn(getString('panel-action-archive'), () => archiveSkillGroup(sg.id), {
        icon: 'archive',
        title: getString('panel-action-archive-title'),
        secondary: true,
      })
    );
  } else {
    // 硬删除仅允许已归档的技能组（存储层同样约束，这里先做界面侧限制）
    ops.append(
      opBtn(getString('panel-action-delete'), () => deleteSkillGroup(sg.id), {
        cls: 'danger',
        icon: 'trash',
        title: getString('panel-action-delete-title'),
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
    return getString('panel-scope-all');
  }
  const n = sg.scope.collectionKeys.length;
  return getString('panel-scope-collections', {
    n,
    sub: getString(sg.scope.includeSubcollections ? 'panel-scope-with-sub' : 'panel-scope-without-sub'),
  });
}

/** 输入材料 + 交付物摘要 */
function materialsSummary(sg: SkillGroup): string {
  const m = sg.materials;
  const parts: string[] = [];
  if (m.includeMetadata) {
    parts.push(getString('panel-mat-metadata'));
  }
  if (m.includeAbstract) {
    parts.push(getString('panel-mat-abstract'));
  }
  if (m.includeNotes) {
    parts.push(getString('panel-mat-notes'));
  }
  if (m.pdf === 'earliest') {
    parts.push(getString('panel-mat-pdf-earliest'));
  }
  return getString('panel-sg-summary', {
    materials: parts.length ? parts.join(getString('panel-list-sep')) : getString('panel-summary-none'),
    deliverable: deliverableLabel(sg.deliverable),
  });
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
    opBtn(getString('panel-action-add'), () => openForm(null), {
      cls: 'primary',
      icon: 'plus',
      title: getString('panel-sg-add'),
    })
  );
  root.append(topRow);

  const groups = api.skillGroups.list(true);
  if (!groups.length) {
    root.append(
      emptyState(
        'package',
        getString('panel-empty-no-sg-title'),
        getString('panel-empty-no-sg-desc'),
        { label: getString('panel-sg-add'), icon: 'plus', onClick: () => openForm(null) }
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

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

interface SkillMarkdownMetadata {
  name?: string;
  description?: string;
}

function decodeYamlScalar(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return String(JSON.parse(value)).trim(); }
    catch { return value.slice(1, -1).trim(); }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'").trim();
  }
  return value;
}

function parseSkillMarkdownMetadata(markdown: string): SkillMarkdownMetadata {
  const text = String(markdown ?? '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  let bodyStart = 0;
  let frontMatter: string[] = [];
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) {
      frontMatter = lines.slice(1, end);
      bodyStart = end + 1;
    }
  }
  const readField = (key: string): string => {
    const re = new RegExp('^\\s*' + key + '\\s*:\\s*(.*)$', 'i');
    for (let i = 0; i < frontMatter.length; i++) {
      const match = frontMatter[i].match(re);
      if (!match) continue;
      const raw = match[1].trim();
      if (/^[>|][+-]?$/.test(raw)) {
        const block: string[] = [];
        for (let j = i + 1; j < frontMatter.length; j++) {
          const line = frontMatter[j];
          if (line.trim() === '') { block.push(''); continue; }
          if (!/^\s+/.test(line)) break;
          block.push(line.replace(/^\s+/, ''));
        }
        return raw.startsWith('>')
          ? block.join(' ').replace(/\s+/g, ' ').trim()
          : block.join('\n').trim();
      }
      return decodeYamlScalar(raw);
    }
    return '';
  };
  let name = readField('name');
  let description = readField('description');
  const body = lines.slice(bodyStart).join('\n');
  if (!name) {
    const heading = body.match(/^#\s+(.+?)\s*$/m);
    if (heading) name = heading[1].trim();
  }
  if (!description) {
    const paragraph: string[] = [];
    let seenHeading = false;
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) { if (paragraph.length) break; continue; }
      if (/^#\s+/.test(trimmed)) { seenHeading = true; continue; }
      if (!seenHeading && /^#{2,6}\s+/.test(trimmed)) continue;
      if (/^(?:[-*+]\s|\d+[.)]\s|>|~~~)/.test(trimmed)) {
        if (paragraph.length) break;
        continue;
      }
      paragraph.push(trimmed);
      if (paragraph.join(' ').length >= 1000) break;
    }
    description = paragraph.join(' ').trim();
  }
  return { name: name || undefined, description: description || undefined };
}


function bindFileDropZone(
  zone: HTMLElement,
  input: HTMLInputElement,
  onFiles: (files: File[]) => void
): void {
  const pick = (): void => input.click();
  zone.addEventListener('click', pick);
  zone.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      pick();
    }
  });
  input.addEventListener('change', () => {
    onFiles(Array.from(input.files ?? []));
    input.value = '';
  });
  zone.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    zone.classList.remove('dragging');
    onFiles(Array.from(ev.dataTransfer?.files ?? []));
  });
}


/** 渲染新增/编辑表单（页内表单，不弹窗） */
function renderForm(wrap: HTMLElement): void {
  if (!api || !formState) {
    return;
  }
  wrap.replaceChildren();
  const editing = formState.editingId ? api.skillGroups.get(formState.editingId) : undefined;
  wrap.append(el('h3', '', editing ? getString('panel-form-edit-title', { name: editing.name }) : getString('panel-sg-add')));

  // —— 名称 ——
  const nameField = el('div', 'field');
  nameField.append(formLabel(getString('panel-form-name'), true));
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.value = editing?.name ?? '';
  nameInput.placeholder = getString('panel-form-name-ph');
  nameField.append(nameInput);
  wrap.append(nameField);

  // —— 技能说明 ——
  const descField = el('div', 'field');
  descField.append(formLabel(getString('panel-form-description')));
  const descInput = el('textarea');
  descInput.value = editing?.description ?? '';
  descInput.placeholder = getString('panel-form-description-ph');
  descField.append(descInput);
  wrap.append(descField);

  // —— SKILL.md 技能文件 ——
  let pendingSkillFile: File | null = null;
  let pendingReferenceFiles: File[] = [];
  const removedReferenceNames = new Set<string>();
  let existingManifest: SkillAssetManifest | null = null;

  const skillFileField = el('div', 'field');
  skillFileField.append(formLabel(getString('panel-form-skill-file')));
  const skillInput = el('input');
  skillInput.type = 'file';
  skillInput.accept = '.md,text/markdown,text/plain';
  skillInput.hidden = true;
  const skillDrop = el('div', 'drop-zone');
  skillDrop.tabIndex = 0;
  skillDrop.setAttribute('role', 'button');
  skillDrop.setAttribute('aria-label', getString('panel-form-skill-file-drop'));
  skillDrop.innerHTML = `${iconSVG('file-text', 'ic')}<strong>${getString('panel-form-skill-file-drop')}</strong><span>${getString('panel-form-skill-file-hint')}</span>`;
  const skillFileStatus = el('div', 'upload-status', getString('panel-form-skill-file-none'));
  skillFileField.append(skillInput, skillDrop, skillFileStatus);
  wrap.append(skillFileField);

  bindFileDropZone(skillDrop, skillInput, (files) => {
    const file = files[0];
    if (!file) return;
    if (!/\.md$/i.test(file.name)) {
      showError(getString('panel-form-err-skill-md'));
      return;
    }
    pendingSkillFile = file;
    skillFileStatus.textContent = getString('panel-form-skill-file-selected', {
      name: file.name,
      size: formatFileSize(file.size),
    });
    void (async () => {
      try {
        const markdown = new TextDecoder('utf-8').decode(await fileToBytes(file));
        const metadata = parseSkillMarkdownMetadata(markdown);
        const loaded: string[] = [];
        if (metadata.name) {
          nameInput.value = metadata.name;
          loaded.push(getString('panel-form-skill-meta-name'));
        }
        if (metadata.description) {
          descInput.value = metadata.description;
          loaded.push(getString('panel-form-skill-meta-description'));
        }
        if (loaded.length) {
          skillFileStatus.textContent =
            getString('panel-form-skill-file-selected', {
              name: file.name,
              size: formatFileSize(file.size),
            }) +
            ' · ' +
            getString('panel-form-skill-meta-loaded', {
              fields: loaded.join(getString('panel-list-sep')),
            });
        }
      } catch (e) {
        showError(getString('panel-form-err-skill-metadata', { error: errMsg(e) }));
      }
    })();
  });

  // —— references/ 可选参考资料 ——
  const refsField = el('div', 'field');
  const refsToggleRow = el('div', 'check-row');
  const refsEnabled = el('input');
  refsEnabled.type = 'checkbox';
  refsEnabled.checked = editing?.referencesEnabled === true;
  refsToggleRow.append(
    refsEnabled,
    el('span', '', getString('panel-form-references-enable'))
  );
  refsField.append(refsToggleRow);

  const refsBox = el('div', 'references-box');
  const refsDesc = el('textarea');
  refsDesc.value = editing?.referencesDescription ?? '';
  refsDesc.placeholder = getString('panel-form-references-description-ph');

  const refsInput = el('input');
  refsInput.type = 'file';
  refsInput.multiple = true;
  refsInput.hidden = true;
  const refsDrop = el('div', 'drop-zone');
  refsDrop.tabIndex = 0;
  refsDrop.setAttribute('role', 'button');
  refsDrop.setAttribute('aria-label', getString('panel-form-references-drop'));
  refsDrop.innerHTML = `${iconSVG('package', 'ic')}<strong>${getString('panel-form-references-drop')}</strong><span>${getString('panel-form-references-hint')}</span>`;
  const refsList = el('div', 'upload-list');

  const renderReferenceList = (): void => {
    refsList.replaceChildren();
    const existing = (existingManifest?.references ?? []).filter(
      (f) => !removedReferenceNames.has(f.name)
    );
    for (const file of existing) {
      const row = el('div', 'upload-file');
      row.append(
        el('span', 'upload-name', file.name),
        el('span', 'muted', formatFileSize(file.size)),
        opBtn(
          getString('panel-action-remove'),
          () => {
            removedReferenceNames.add(file.name);
            renderReferenceList();
          },
          { icon: 'x', secondary: true, title: getString('panel-form-reference-remove-title') }
        )
      );
      refsList.append(row);
    }
    pendingReferenceFiles.forEach((file, index) => {
      const row = el('div', 'upload-file pending');
      row.append(
        el('span', 'upload-name', file.name),
        el('span', 'muted', formatFileSize(file.size)),
        opBtn(
          getString('panel-action-remove'),
          () => {
            pendingReferenceFiles.splice(index, 1);
            renderReferenceList();
          },
          { icon: 'x', secondary: true, title: getString('panel-form-reference-remove-title') }
        )
      );
      refsList.append(row);
    });
    if (!existing.length && !pendingReferenceFiles.length) {
      refsList.append(el('div', 'muted', getString('panel-form-references-empty')));
    }
  };

  bindFileDropZone(refsDrop, refsInput, (files) => {
    const byName = new Map(pendingReferenceFiles.map((file) => [file.name, file]));
    for (const file of files) {
      if (file.name && file.size > 0) byName.set(file.name, file);
    }
    pendingReferenceFiles = [...byName.values()];
    renderReferenceList();
  });

  const syncReferencesBox = (): void => {
    refsBox.hidden = !refsEnabled.checked;
  };
  refsEnabled.addEventListener('change', syncReferencesBox);
  refsBox.append(
    formLabel(getString('panel-form-references-description')),
    refsDesc,
    refsInput,
    refsDrop,
    refsList
  );
  refsField.append(refsBox);
  wrap.append(refsField);
  syncReferencesBox();
  renderReferenceList();

  if (editing) {
    void api.skillGroups
      .getAssetManifest(editing.id)
      .then((manifest) => {
        existingManifest = manifest;
        if (manifest.skillFile) {
          skillFileStatus.textContent = getString('panel-form-skill-file-existing', {
            path: manifest.skillFile.path,
            size: formatFileSize(manifest.skillFile.size),
          });
        }
        renderReferenceList();
      })
      .catch((e: unknown) => {
        showError(getString('panel-form-err-assets-load', { error: errMsg(e) }));
      });
  }

  // —— 任务指令 ——
  const instrField = el('div', 'field');
  instrField.append(formLabel(getString('panel-form-instruction'), true));
  const instrInput = el('textarea');
  instrInput.value = editing?.instruction ?? '';
  instrInput.placeholder = getString('panel-form-instruction-ph');
  instrField.append(instrInput);
  wrap.append(instrField);

  // —— 范围 ——
  const scopeField = el('div', 'field');
  scopeField.append(formLabel(getString('panel-form-scope')));
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
  rowAll.append(el('span', '', getString('panel-form-scope-all')));
  const rowColl = el('div', 'radio-row');
  rowColl.append(scopeColl);
  rowColl.append(el('span', '', getString('panel-form-scope-collections')));
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
  includeSubRow.append(el('span', '', getString('panel-form-include-sub')));
  collBox.append(collList, collHint, includeSubRow);
  collBox.hidden = currentScope.type !== 'collections';

  const renderCollList = (): void => {
    collList.replaceChildren();
    if (!collCache) {
      collCache = loadCollectionOptions();
    }
    if (!collCache.ok) {
      collHint.textContent = getString('panel-form-coll-unavailable');
      return;
    }
    if (!collCache.options.length) {
      collHint.textContent = getString('panel-form-coll-empty');
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
  matField.append(formLabel(getString('panel-form-materials')));
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
  rowMeta.append(matMeta, el('span', '', getString('panel-form-mat-metadata')));
  const rowAbs = el('div', 'check-row');
  rowAbs.append(matAbs, el('span', '', getString('panel-mat-abstract')));
  const rowNotes = el('div', 'check-row');
  rowNotes.append(matNotes, el('span', '', getString('panel-form-mat-notes')));
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
  rowPdf1.append(pdfEarliest, el('span', '', getString('panel-form-mat-pdf-earliest')));
  const rowPdf2 = el('div', 'radio-row');
  rowPdf2.append(pdfNone, el('span', '', getString('panel-form-mat-pdf-none')));
  matField.append(rowMeta, rowAbs, rowNotes, rowPdf1, rowPdf2);
  wrap.append(matField);

  // —— 交付物 ——
  const delField = el('div', 'field');
  delField.append(formLabel(getString('panel-form-deliverable')));
  const curDel: SkillDeliverable = editing?.deliverable ?? { type: 'note' };
  const delTypeCur = curDel.type === 'file' || curDel.type === 'markdown' ? curDel.type : 'note';
  const delNote = el('input');
  delNote.type = 'radio';
  delNote.name = 'deliverable-type';
  delNote.value = 'note';
  const delFile = el('input');
  delFile.type = 'radio';
  delFile.name = 'deliverable-type';
  delFile.value = 'file';
  const delMd = el('input');
  delMd.type = 'radio';
  delMd.name = 'deliverable-type';
  delMd.value = 'markdown';
  if (delTypeCur === 'file') {
    delFile.checked = true;
  } else if (delTypeCur === 'markdown') {
    delMd.checked = true;
  } else {
    delNote.checked = true;
  }
  const rowDelNote = el('div', 'radio-row');
  rowDelNote.append(delNote, el('span', '', getString('panel-form-del-note')));
  const rowDelFile = el('div', 'radio-row');
  rowDelFile.append(delFile, el('span', '', getString('panel-form-del-file')));
  const rowDelMd = el('div', 'radio-row');
  rowDelMd.append(delMd, el('span', '', getString('panel-form-del-markdown')));
  delField.append(rowDelNote, rowDelFile, rowDelMd);

  // 文件交付物选项
  const fileOpts = el('div', '');
  fileOpts.style.paddingLeft = '24px';
  const attachFile = el('input');
  attachFile.type = 'checkbox';
  attachFile.checked = curDel.type === 'file' && !!curDel.attachToItem;
  const rowAttachFile = el('div', 'check-row');
  rowAttachFile.append(attachFile, el('span', '', getString('panel-form-attach-file')));
  const extInput = el('input');
  extInput.type = 'text';
  extInput.placeholder = getString('panel-form-ext-ph');
  extInput.value =
    curDel.type === 'file' && curDel.allowedExtensions
      ? curDel.allowedExtensions.join(', ')
      : '';
  const maxMBInput = el('input');
  maxMBInput.type = 'text';
  maxMBInput.placeholder = getString('panel-form-maxmb-ph');
  maxMBInput.value =
    curDel.type === 'file' && curDel.maxBytes
      ? String(Math.round((curDel.maxBytes / 1048576) * 10) / 10)
      : '';
  const fileNameInput = el('input');
  fileNameInput.type = 'text';
  fileNameInput.placeholder = getString('panel-form-target-file-name-ph');
  fileNameInput.value =
    curDel.type === 'file' ? curDel.targetFileName ?? '' : '';
  const filePolicyRow = el('div', 'field-inline conflict-policy');
  filePolicyRow.append(el('span', 'muted', getString('panel-form-existing-attachment')));
  const filePolicy = el('select') as HTMLSelectElement;
  filePolicy.setAttribute(
    'aria-label',
    getString('panel-form-existing-attachment')
  );
  const fileSkip = document.createElement('option');
  fileSkip.value = 'skip';
  fileSkip.textContent = getString('panel-form-existing-skip');
  const fileOverwrite = document.createElement('option');
  fileOverwrite.value = 'overwrite';
  fileOverwrite.textContent = getString('panel-form-existing-overwrite');
  filePolicy.append(fileSkip, fileOverwrite);
  filePolicy.value =
    curDel.type === 'file' ? curDel.existingAttachmentPolicy ?? 'skip' : 'skip';
  filePolicyRow.append(filePolicy);
  fileOpts.append(rowAttachFile, fileNameInput, filePolicyRow, extInput, maxMBInput);

  // Markdown 交付物选项
  const mdOpts = el('div', '');
  mdOpts.style.paddingLeft = '24px';
  const mdTargetNote = el('input');
  mdTargetNote.type = 'radio';
  mdTargetNote.name = 'md-target';
  mdTargetNote.value = 'note';
  const mdTargetFile = el('input');
  mdTargetFile.type = 'radio';
  mdTargetFile.name = 'md-target';
  mdTargetFile.value = 'file';
  const mdTargetCur =
    curDel.type === 'markdown' && curDel.target === 'file' ? 'file' : 'note';
  if (mdTargetCur === 'file') {
    mdTargetFile.checked = true;
  } else {
    mdTargetNote.checked = true;
  }
  const rowMdNote = el('div', 'radio-row');
  rowMdNote.append(mdTargetNote, el('span', '', getString('panel-form-md-target-note')));
  const rowMdFile = el('div', 'radio-row');
  rowMdFile.append(mdTargetFile, el('span', '', getString('panel-form-md-target-file')));
  const attachMd = el('input');
  attachMd.type = 'checkbox';
  attachMd.checked = curDel.type === 'markdown' && !!curDel.attachToItem;
  const rowAttachMd = el('div', 'check-row');
  rowAttachMd.append(attachMd, el('span', '', getString('panel-form-attach-md')));
  const mdFileNameInput = el('input');
  mdFileNameInput.type = 'text';
  mdFileNameInput.placeholder = getString('panel-form-target-md-name-ph');
  mdFileNameInput.value =
    curDel.type === 'markdown' && curDel.target === 'file'
      ? curDel.targetFileName ?? ''
      : '';
  const mdPolicyRow = el('div', 'field-inline conflict-policy');
  mdPolicyRow.append(el('span', 'muted', getString('panel-form-existing-attachment')));
  const mdPolicy = el('select') as HTMLSelectElement;
  mdPolicy.setAttribute(
    'aria-label',
    getString('panel-form-existing-attachment')
  );
  const mdSkip = document.createElement('option');
  mdSkip.value = 'skip';
  mdSkip.textContent = getString('panel-form-existing-skip');
  const mdOverwrite = document.createElement('option');
  mdOverwrite.value = 'overwrite';
  mdOverwrite.textContent = getString('panel-form-existing-overwrite');
  mdPolicy.append(mdSkip, mdOverwrite);
  mdPolicy.value =
    curDel.type === 'markdown' && curDel.target === 'file'
      ? curDel.existingAttachmentPolicy ?? 'skip'
      : 'skip';
  mdPolicyRow.append(mdPolicy);
  mdOpts.append(rowMdNote, rowMdFile, rowAttachMd, mdFileNameInput, mdPolicyRow);

  const syncDelOpts = (): void => {
    const v = (
      delField.querySelector(
        'input[name="deliverable-type"]:checked'
      ) as HTMLInputElement
    )?.value;
    fileOpts.hidden = v !== 'file';
    mdOpts.hidden = v !== 'markdown';
    // 策略控件保持可见：未开启自动挂附件时禁用，而不是整行隐藏。
    filePolicy.disabled = !attachFile.checked;
    const mdToFile = v === 'markdown' && mdTargetFile.checked;
    rowAttachMd.hidden = !mdToFile;
    mdFileNameInput.hidden = !mdToFile;
    mdPolicyRow.hidden = !mdToFile;
    mdPolicy.disabled = !attachMd.checked;
  };
  for (const r of [delNote, delFile, delMd, mdTargetNote, mdTargetFile]) {
    r.addEventListener('change', syncDelOpts);
  }
  attachFile.addEventListener('change', syncDelOpts);
  attachMd.addEventListener('change', syncDelOpts);
  syncDelOpts();
  delField.append(fileOpts, mdOpts);
  wrap.append(delField);

  // —— 保存 / 取消 ——
  const btnRow = el('div', 'ops');
  btnRow.append(
    opBtn(
      getString('panel-action-save'),
      async () => {
        clearError();
        const name = nameInput.value.trim();
        if (!name) {
          showError(getString('panel-form-err-name-required'));
          return;
        }
        const description = descInput.value.trim();
        const instruction = instrInput.value.trim();
        if (!instruction) {
          showError(getString('panel-form-err-instruction-required'));
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
            showError(getString('panel-form-err-scope-empty'));
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
        // 交付物：按类型组装配置（store 层二次校验，非法时抛中文错）
        const delType = (
          wrap.querySelector(
            'input[name="deliverable-type"]:checked'
          ) as HTMLInputElement
        )?.value as 'note' | 'file' | 'markdown';
        let deliverable: SkillDeliverable;
        if (delType === 'file') {
          const d: Extract<SkillDeliverable, { type: 'file' }> = {
            type: 'file',
          };
          if (attachFile.checked) {
            d.attachToItem = true;
          }
          const exts = extInput.value
            .split(/[,，]/)
            .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
            .filter((s) => /^[a-z0-9]{1,10}$/.test(s));
          if (exts.length) {
            d.allowedExtensions = [...new Set(exts)];
          }
          const targetFileName = fileNameInput.value.trim();
          if (targetFileName) d.targetFileName = targetFileName;
          d.existingAttachmentPolicy =
            filePolicy.value === 'overwrite' ? 'overwrite' : 'skip';
          const mbText = maxMBInput.value.trim();
          if (mbText) {
            const mb = Number(mbText);
            if (!Number.isFinite(mb) || mb <= 0) {
              showError(getString('panel-form-err-maxmb'));
              return;
            }
            d.maxBytes = Math.floor(mb * 1048576);
          }
          deliverable = d;
        } else if (delType === 'markdown') {
          const target =
            (
              wrap.querySelector(
                'input[name="md-target"]:checked'
              ) as HTMLInputElement
            )?.value === 'file'
              ? 'file'
              : 'note';
          const d: Extract<SkillDeliverable, { type: 'markdown' }> = {
            type: 'markdown',
            target,
          };
          if (target === 'file') {
            const targetFileName = mdFileNameInput.value.trim();
            if (targetFileName) d.targetFileName = targetFileName;
            d.existingAttachmentPolicy =
              mdPolicy.value === 'overwrite' ? 'overwrite' : 'skip';
            if (attachMd.checked) {
              d.attachToItem = true;
            }
          }
          deliverable = d;
        } else {
          deliverable = { type: 'note' };
        }
        try {
          let saved: SkillGroup;
          if (editing) {
            saved = await api!.skillGroups.update(editing.id, {
              name,
              description,
              instruction,
              referencesEnabled: refsEnabled.checked,
              referencesDescription: refsDesc.value.trim(),
              scope,
              materials,
              deliverable,
            });
          } else {
            const data: SkillGroupCreateData = {
              name,
              description,
              instruction,
              referencesEnabled: refsEnabled.checked,
              referencesDescription: refsDesc.value.trim(),
              scope,
              materials,
              deliverable,
            };
            saved = await api!.skillGroups.create(data);
          }

          if (pendingSkillFile) {
            await api!.skillGroups.writeSkillFile(
              saved.id,
              await fileToBytes(pendingSkillFile)
            );
          }
          for (const fileName of removedReferenceNames) {
            await api!.skillGroups.removeReferenceFile(saved.id, fileName);
          }
          if (refsEnabled.checked && pendingReferenceFiles.length) {
            await api!.skillGroups.writeReferenceFiles(
              saved.id,
              await Promise.all(
                pendingReferenceFiles.map(async (file) => ({
                  name: file.name,
                  bytes: await fileToBytes(file),
                }))
              )
            );
          }
        } catch (e) {
          showError(e instanceof Error ? e.message : String(e));
          return;
        }
        closeForm();
        renderSkills();
      },
      { cls: 'primary', icon: 'check', title: getString('panel-action-save-sg-title') }
    )
  );
  btnRow.append(opBtn(getString('panel-action-cancel'), () => closeForm(), { icon: 'x', title: getString('panel-action-cancel-form-title') }));
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
    showError(getString(enabled ? 'panel-err-enable-failed' : 'panel-err-disable-failed', { error: errMsg(e) }));
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
    showError(getString('panel-err-copy-sg-failed', { error: errMsg(e) }));
  }
}

/** 归档技能组（软删除） */
async function archiveSkillGroup(id: string): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  if (!window.confirm(getString('panel-confirm-archive'))) {
    return;
  }
  try {
    await api.skillGroups.archive(id);
    await refreshTab(activeTab);
  } catch (e) {
    showError(getString('panel-err-archive-failed', { error: errMsg(e) }));
  }
}

/** 删除技能组（硬删除；存储层仅允许已归档的） */
async function deleteSkillGroup(id: string): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  if (!window.confirm(getString('panel-confirm-delete'))) {
    return;
  }
  try {
    await api.skillGroups.remove(id);
    await refreshTab(activeTab);
  } catch (e) {
    showError(getString('panel-err-delete-failed', { error: errMsg(e) }));
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
        getString('panel-empty-no-sg-title'),
        getString('panel-empty-no-sg-tasks-desc'),
        { label: getString('panel-action-goto-sg'), icon: 'layers', onClick: () => switchTab('skills') }
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
  searchInput.placeholder = getString('panel-task-search-ph');
  searchInput.setAttribute('aria-label', getString('panel-task-search-aria'));
  searchInput.value = taskSearch;
  const clearBtn = el('button', 'search-clear');
  clearBtn.innerHTML = iconSVG('x', 'ic ic-sm');
  clearBtn.title = getString('panel-task-search-clear-title');
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
  filterSel.setAttribute('aria-label', getString('panel-task-filter-aria'));
  filterSel.append(new Option(getString('panel-task-filter-all'), 'all'));
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
    opBtn(getString('panel-action-batch-retry'), () => batchRetry(), {
      id: 'batch-retry-btn',
      icon: 'rotate-ccw',
      title: getString('panel-action-batch-retry-title'),
    })
  );
  bbOps.append(
    opBtn(getString('panel-action-batch-cancel'), () => batchCancel(), {
      id: 'batch-cancel-btn',
      cls: 'danger',
      icon: 'x',
      title: getString('panel-action-batch-cancel-title'),
    })
  );
  bbOps.append(
    opBtn(getString('panel-action-clear-selection'), () => {
      selectedTasks.clear();
      renderTaskList();
    }, { icon: 'x', title: getString('panel-action-clear-selection-title'), secondary: true })
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
    info.textContent = filterActive ? getString('panel-task-showing', { matched, total }) : '';
  }

  if (filterActive && shownGroups === 0) {
    // 筛选无结果：带清除筛选的空状态
    wrap.append(
      emptyState('search', getString('panel-empty-no-match-title'), getString('panel-empty-no-match-desc'), {
        label: getString('panel-action-clear-filter'),
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
        getString('panel-empty-no-tasks-title'),
        getString('panel-empty-no-tasks-desc'),
        { label: getString('panel-action-goto-sg'), icon: 'search', onClick: () => switchTab('skills') }
      )
    );
  }
  updateBatchBar();
}

function taskStatusGroupKey(skillGroupId: string, status: string): string {
  return `${skillGroupId}::${status}`;
}

function bindTaskStatusGroupState(
  details: HTMLDetailsElement,
  key: string,
  defaultOpen: boolean
): void {
  details.open = taskStatusGroupOpen.has(key)
    ? taskStatusGroupOpen.get(key) === true
    : defaultOpen;
  details.addEventListener('toggle', () => {
    taskStatusGroupOpen.set(key, details.open);
  });
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
  countEl.append(getString('panel-task-count-done') + ' ', strongDone, ' · ' + getString('panel-task-count-undone') + ' ', strongUndone);
  head.append(countEl);
  sec.append(head);

  const ops = el('div', 'ops');
  ops.append(
    opBtn(sg.enabled ? getString('panel-action-pause') : getString('panel-action-resume'), () => setSkillEnabled(sg, !sg.enabled), {
      icon: sg.enabled ? 'pause' : 'play',
      title: sg.enabled ? getString('panel-action-pause-title') : getString('panel-action-resume-title'),
    })
  );
  const rescanBtn = opBtn(getString('panel-action-scan'), () => rescan(sg.id), {
    icon: 'search',
    title: getString('panel-action-scan-title'),
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
    const det = el('details', 'status-group') as HTMLDetailsElement;
    bindTaskStatusGroupState(
      det,
      taskStatusGroupKey(sg.id, st),
      items.length > 0 && st !== 'cancelled'
    );
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
      det.append(el('div', 'task-none', getString('panel-task-none')));
    }
    for (const t of items) {
      det.append(taskItem(t));
    }
    sec.append(det);
  }
  // 已完成：可折叠列表，支持展开详情
  const dones = tasks.filter((t) => t.status === 'done');
  if (!filtering || dones.length > 0) {
    const doneDet = el('details', 'status-group') as HTMLDetailsElement;
    bindTaskStatusGroupState(
      doneDet,
      taskStatusGroupKey(sg.id, 'done'),
      false
    );
    const doneSum = el('summary');
    const doneIc = el('span', 'sum-ic');
    doneIc.style.color = 'var(--ok)';
    doneIc.innerHTML = iconSVG('check-circle', 'ic ic-sm');
    doneSum.append(doneIc);
    doneSum.append(document.createTextNode(getString('panel-task-done-summary', { n: dones.length })));
    const doneChev = el('span', 'chev');
    doneChev.innerHTML = iconSVG('chevron-down', 'ic ic-sm');
    doneSum.append(doneChev);
    doneDet.append(doneSum);
    if (!dones.length) {
      doneDet.append(el('div', 'task-none', getString('panel-task-none')));
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
  expBtn.title = getString(expanded ? 'panel-task-collapse' : 'panel-task-expand');
  expBtn.setAttribute('aria-expanded', String(expanded));
  expBtn.setAttribute('aria-label', getString(expanded ? 'panel-task-collapse' : 'panel-task-expand'));
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
    cb.title = getString('panel-task-select-title');
    cb.setAttribute('aria-label', getString('panel-task-select-aria', { key: t.itemKey }));
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
  line1.append(el('span', 'muted', getString('panel-task-created-label') + ' '));
  line1.append(relTime(t.createdAt));
  line1.append(el('span', 'muted', ' · ' + getString('panel-task-claimed-label') + ' '));
  line1.append(relTime(t.claimedAt));
  line1.append(el('span', 'muted', ' · ' + getString('panel-task-completed-label') + ' '));
  line1.append(relTime(t.completedAt));
  info.append(line1);
  if (t.lastError) {
    const errLine = el('div', 'err-inline');
    errLine.append(iconEl('alert-circle', 'ic ic-sm'));
    errLine.append(document.createTextNode(getString('panel-task-fail-reason', { error: t.lastError })));
    info.append(errLine);
  }
  row.append(info);

  const ops = el('div', 'ops');
  if (t.status === 'failed') {
    ops.append(
      opBtn(getString('panel-action-retry'), () => retryTask(t.id), {
        icon: 'rotate-ccw',
        title: getString('panel-action-retry-title'),
        secondary: true,
      })
    );
  }
  if (t.status !== 'done' && t.status !== 'cancelled') {
    ops.append(
      opBtn(getString('panel-action-cancel'), () => cancelTask(t.id), {
        cls: 'danger',
        icon: 'x',
        title: getString('panel-action-cancel-task-title'),
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

  const item = resolveTaskItem(t.itemKey);
  const itemTitle =
    item?.getField?.('title') || item?.getDisplayTitle?.() || getString('panel-detail-item-untitled');

  const grid = el('div', 'detail-grid');
  grid.append(detailKV(getString('panel-detail-item-title'), String(itemTitle)));
  grid.append(detailKV(getString('panel-detail-item-key'), t.itemKey, true));
  grid.append(detailKV(getString('panel-detail-sg'), sg?.name ?? getString('panel-detail-sg-deleted')));
  grid.append(detailKV(getString('panel-detail-sg-version'), `v${t.skillGroupVersion}`));
  grid.append(detailKV(getString('panel-detail-attempts'), String(t.attempts)));
  d.append(grid);

  const itemOps = el('div', 'ops');
  const revealBtn = opBtn(
    getString('panel-detail-view-in-library'),
    () => revealTaskItem(t.itemKey),
    {
      icon: 'external-link',
      title: getString('panel-detail-view-in-library-title'),
      secondary: true,
    }
  );
  revealBtn.disabled = !item;
  itemOps.append(revealBtn);
  d.append(itemOps);

  // 领取时的指令快照
  const insSec = el('div', 'd-sec');
  insSec.append(el('h4', '', getString('panel-detail-instruction')));
  insSec.append(el('div', 'instruction', t.instructionSnapshot || getString('panel-detail-instruction-empty')));
  d.append(insSec);

  // 材料清单（按技能组当前 materials 配置逐项列出）
  const matSec = el('div', 'd-sec');
  matSec.append(el('h4', '', getString('panel-detail-materials')));
  if (sg) {
    const items = materialItems(sg.materials);
    const ul = el('ul', 'd-list');
    if (items.length) {
      for (const s of items) {
        ul.append(el('li', '', s));
      }
    } else {
      ul.append(el('li', '', getString('panel-detail-no-materials')));
    }
    matSec.append(ul);
  } else {
    matSec.append(el('div', 'muted', getString('panel-detail-sg-unavailable')));
  }
  d.append(matSec);

  // 交付物：类型 + 交付结果（笔记 key / 文件名 / 附件 key）
  const delSec = el('div', 'd-sec');
  delSec.append(el('h4', '', getString('panel-detail-deliverable')));
  const delGrid = el('div', 'detail-grid');
  delGrid.append(detailKV(getString('panel-detail-type'), deliverableLabel(sg?.deliverable)));
  if (t.status === 'done') {
    const dtype = t.deliverableType ?? (t.noteKey ? 'note' : null);
    if (dtype === 'file' || (dtype === 'markdown' && !t.noteKey)) {
      delGrid.append(detailKV(getString('panel-detail-file'), t.deliverableRef ?? '—', true));
    } else if (t.noteKey) {
      delGrid.append(detailKV(getString('panel-detail-note-key'), t.noteKey, true));
    }
    if (t.attachmentKey) {
      delGrid.append(detailKV(getString('panel-detail-attachment-key'), t.attachmentKey, true));
    }
    delGrid.append(detailKV(getString('panel-detail-write-status'), getString('panel-detail-delivered')));
  } else {
    delGrid.append(detailKV(getString('panel-detail-write-status'), getString('panel-detail-not-delivered')));
  }
  delSec.append(delGrid);
  d.append(delSec);

  // 时间线：创建 → 领取 → 完成
  const tlSec = el('div', 'd-sec');
  tlSec.append(el('h4', '', getString('panel-detail-timeline')));
  const tl = el('ul', 'timeline');
  tl.append(timelineStep(getString('panel-task-created-label'), t.createdAt));
  tl.append(timelineStep(getString('panel-task-claimed-label'), t.claimedAt));
  tl.append(timelineStep(getString('panel-task-completed-label'), t.completedAt));
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
    parts.push(getString('panel-form-mat-metadata'));
  }
  if (m.includeAbstract) {
    parts.push(getString('panel-mat-abstract'));
  }
  if (m.includeNotes) {
    parts.push(getString('panel-form-mat-notes'));
  }
  if (m.pdf === 'earliest') {
    parts.push(getString('panel-mat-detail-pdf'));
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
    cnt.textContent = getString('panel-batch-selected', { n });
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
      failedCount === 0 ? getString('panel-batch-retry-none-title') : getString('panel-batch-retry-title-n', { n: failedCount });
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
    showError(getString('panel-batch-retry-none-err'));
    return;
  }
  if (
    !window.confirm(
      getString('panel-confirm-batch-retry', { n: targets.length, total: selectedTasks.size })
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
    getString('panel-batch-retry-done', {
      ok,
      failPart: errs.length
        ? getString('panel-batch-fail-part', {
            n: errs.length,
            errs: errs.join(getString('panel-err-join-sep')),
          })
        : '',
    })
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
    showError(getString('panel-batch-cancel-none-err'));
    return;
  }
  if (
    !window.confirm(
      getString('panel-confirm-batch-cancel', { n: targets.length })
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
    getString('panel-batch-cancel-done', {
      ok,
      failPart: errs.length
        ? getString('panel-batch-fail-part', {
            n: errs.length,
            errs: errs.join(getString('panel-err-join-sep')),
          })
        : '',
    })
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
    showError(getString('panel-err-retry-failed', { error: errMsg(e) }));
  }
}

/** 取消未完成任务 */
async function cancelTask(id: string): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  if (!window.confirm(getString('panel-confirm-cancel-task'))) {
    return;
  }
  try {
    await api.tasks.cancel(id);
    await refreshTab('tasks');
  } catch (e) {
    showError(getString('panel-err-cancel-failed', { error: errMsg(e) }));
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
        setProg(done, total, getString('panel-scan-progress', { done, total }));
      },
    });
    const summary =
      getString('panel-scan-done', {
        scanned: result.scanned,
        created: result.created,
        skipped: result.skipped,
        waiting: result.waitingMaterial,
        promoted: result.promoted,
        completedExisting: result.completedExisting,
      });
    await refreshTab('tasks');
    // refreshTab 重建了 DOM，重新定位进度元素以保留结果摘要
    setProg(1, 1, summary);
  } catch (e) {
    showError(getString('panel-err-scan-failed', { error: errMsg(e) }));
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
    void scanAllGroups().catch((e: unknown) => showError(getString('panel-err-scan-all-failed', { error: errMsg(e) })));
  });
  $<HTMLButtonElement>('qa-pause-all').addEventListener('click', () => {
    qaMenu.hidden = true;
    qaBtn.setAttribute('aria-expanded', 'false');
    void togglePauseAll().catch((e: unknown) => showError(getString('panel-err-op-failed', { error: errMsg(e) })));
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
  item.innerHTML = `${iconSVG(anyEnabled ? 'pause' : 'play', 'ic')}<span>${getString(anyEnabled ? 'panel-action-pause-all' : 'panel-action-resume-all')}</span>`;
  item.title = getString(
    anyEnabled ? 'panel-action-pause-all-title' : 'panel-action-resume-all-title'
  );
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
  text.textContent = getString('panel-scan-all-progress');
  try {
    const results = await api.generator.scanAllEnabled({
      onProgress: (done, total) => {
        fill.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
        text.textContent = getString('panel-scan-all-progress-n', { done, total });
      },
    });
    const agg = results.reduce(
      (a, r) => ({
        scanned: a.scanned + r.scanned,
        created: a.created + r.created,
        skipped: a.skipped + r.skipped,
        waitingMaterial: a.waitingMaterial + r.waitingMaterial,
        promoted: a.promoted + r.promoted,
        completedExisting: a.completedExisting + r.completedExisting,
      }),
      {
        scanned: 0,
        created: 0,
        skipped: 0,
        waitingMaterial: 0,
        promoted: 0,
        completedExisting: 0,
      }
    );
    fill.style.width = '100%';
    text.textContent =
      getString('panel-scan-all-done', {
        n: results.length,
        scanned: agg.scanned,
        created: agg.created,
        skipped: agg.skipped,
        waiting: agg.waitingMaterial,
        promoted: agg.promoted,
        completedExisting: agg.completedExisting,
      });
    await refreshTab(activeTab);
  } catch (e) {
    bar.hidden = true;
    showError(getString('panel-err-scan-all-failed', { error: errMsg(e) }));
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
    showError(getString('panel-err-no-groups'));
    return;
  }
  const anyEnabled = groups.some((sg) => sg.enabled);
  const target = !anyEnabled;
  if (!target) {
    if (
      !window.confirm(
        getString('panel-confirm-pause-all', { n: groups.length })
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
    showError(getString(target ? 'panel-err-resume-all-failed' : 'panel-err-pause-all-failed', { error: errMsg(e) }));
  }
}

// ══════════════════════════ 设置选项卡 ══════════════════════════

function settingRow(
  label: string,
  desc: string,
  control: HTMLElement
): HTMLElement {
  const row = el('div', 'settings-row');
  const main = el('div', 'settings-main');
  main.append(el('div', 'settings-label', label));
  main.append(el('div', 'settings-desc', desc));
  row.append(main, control);
  return row;
}

function renderSettings(): void {
  const root = $<HTMLElement>('tab-settings');
  root.replaceChildren();

  const taskCard = el('div', 'card');
  const taskHead = el('div', 'card-head');
  const taskIcon = el('span', 'sg-ic');
  taskIcon.innerHTML = iconSVG('clock', 'ic');
  taskHead.append(taskIcon, el('h3', '', getString('panel-settings-task-title')));
  taskCard.append(taskHead);

  const leaseInput = el('input') as HTMLInputElement;
  leaseInput.type = 'number';
  leaseInput.min = '1';
  leaseInput.max = '1440';
  leaseInput.step = '1';
  leaseInput.className = 'settings-control';
  leaseInput.value = String(prefs.get(PREFS.TASK_LEASE_MINUTES, 30));
  leaseInput.addEventListener('change', () => {
    const value = Number(leaseInput.value);
    if (!Number.isFinite(value) || value < 1 || value > 1440) {
      showError(getString('panel-settings-lease-invalid'));
      leaseInput.value = String(prefs.get(PREFS.TASK_LEASE_MINUTES, 30));
      return;
    }
    prefs.set(PREFS.TASK_LEASE_MINUTES, Math.floor(value));
    clearError();
  });
  taskCard.append(
    settingRow(
      getString('panel-settings-lease-label'),
      getString('panel-settings-lease-desc'),
      leaseInput
    )
  );

  const maxFileInput = el('input') as HTMLInputElement;
  maxFileInput.type = 'number';
  maxFileInput.min = '1';
  maxFileInput.step = '1';
  maxFileInput.className = 'settings-control';
  maxFileInput.value = String(prefs.get(PREFS.DELIVERABLE_MAX_FILE_MB, 200));
  maxFileInput.addEventListener('change', () => {
    const value = Number(maxFileInput.value);
    if (!Number.isFinite(value) || value <= 0) {
      showError(getString('panel-settings-maxfile-invalid'));
      maxFileInput.value = String(
        prefs.get(PREFS.DELIVERABLE_MAX_FILE_MB, 200)
      );
      return;
    }
    prefs.set(PREFS.DELIVERABLE_MAX_FILE_MB, value);
    clearError();
  });
  taskCard.append(
    settingRow(
      getString('panel-settings-maxfile-label'),
      getString('panel-settings-maxfile-desc'),
      maxFileInput
    )
  );
  taskCard.append(el('div', 'hint', getString('panel-settings-live-hint')));
  root.append(taskCard);

  const shortcutCard = el('div', 'card');
  const shortcutHead = el('div', 'card-head');
  const shortcutIcon = el('span', 'sg-ic');
  shortcutIcon.innerHTML = iconSVG('key', 'ic');
  shortcutHead.append(
    shortcutIcon,
    el('h3', '', getString('panel-settings-shortcut-title'))
  );
  shortcutCard.append(shortcutHead);

  const enabled = el('input') as HTMLInputElement;
  enabled.type = 'checkbox';
  enabled.className = 'switch';
  enabled.checked = isShortcutEnabled();
  enabled.addEventListener('change', () => {
    prefs.set(PREFS.SHORTCUT_ENABLED, enabled.checked);
    renderSettings();
  });
  shortcutCard.append(
    settingRow(
      getString('panel-settings-shortcut-enable'),
      getString('panel-settings-shortcut-current', {
        shortcut: getPanelShortcutLabel(),
      }),
      enabled
    )
  );

  const warn = el('div', 'settings-warning');
  warn.hidden = true;

  const bindShortcutKey = (prefKey: string, platform: 'mac' | 'win'): HTMLInputElement => {
    const input = el('input') as HTMLInputElement;
    input.type = 'text';
    input.maxLength = 1;
    input.className = 'settings-control short-key';
    input.value = normalizeShortcutKey(prefs.get(prefKey, 'J'));
    const refreshWarn = () => {
      const value = normalizeShortcutKey(input.value);
      const activePlatform =
        (platform === 'mac' && isMacPlatform()) ||
        (platform === 'win' && !isMacPlatform());
      if (activePlatform && isShortcutKeyReserved(value)) {
        warn.textContent = getString('prefs-shortcut-conflict-warn', { key: value });
        warn.hidden = false;
      } else if (activePlatform) {
        warn.hidden = true;
        warn.textContent = '';
      }
    };
    input.addEventListener('input', refreshWarn);
    input.addEventListener('change', () => {
      const value = String(input.value ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]$/.test(value)) {
        showError(getString('prefs-shortcut-invalid'));
        input.value = normalizeShortcutKey(prefs.get(prefKey, 'J'));
        refreshWarn();
        return;
      }
      prefs.set(prefKey, value);
      input.value = value;
      clearError();
      renderSettings();
    });
    return input;
  };

  const macInput = bindShortcutKey(PREFS.SHORTCUT_KEY_MAC, 'mac');
  const winInput = bindShortcutKey(PREFS.SHORTCUT_KEY_WIN, 'win');
  shortcutCard.append(
    settingRow(
      getString('panel-settings-shortcut-mac'),
      getString('panel-settings-shortcut-mac-desc'),
      macInput
    )
  );
  shortcutCard.append(
    settingRow(
      getString('panel-settings-shortcut-win'),
      getString('panel-settings-shortcut-win-desc'),
      winInput
    )
  );

  const activeKey = normalizeShortcutKey(
    prefs.get(
      isMacPlatform() ? PREFS.SHORTCUT_KEY_MAC : PREFS.SHORTCUT_KEY_WIN,
      'J'
    )
  );
  if (isShortcutKeyReserved(activeKey)) {
    warn.textContent = getString('prefs-shortcut-conflict-warn', {
      key: activeKey,
    });
    warn.hidden = false;
  }
  shortcutCard.append(warn);
  shortcutCard.append(el('div', 'hint', getString('panel-settings-shortcut-hint')));
  root.append(shortcutCard);
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
  let host = '127.0.0.1';
  let port: number | null = null;
  let url: string | null = null;
  let lanAccessible = false;
  let tokenEnabled = false;
  let token = '';
  try {
    const st = mcp.getStatus();
    enabled = st.enabled;
    host = st.host;
    port = st.port;
    url = st.url;
    lanAccessible = st.lanAccessible;
    tokenEnabled = !!mcp.isTokenEnabled?.();
    token = tokenEnabled ? mcp.ensureToken() : '';
  } catch (e) {
    showError(getString('panel-err-mcp-status-failed', { error: errMsg(e) }));
    return;
  }

  const card = el('div', 'card');
  const head = el('div', 'card-head');
  const sgIcon = el('span', 'sg-ic');
  sgIcon.innerHTML = iconSVG('server', 'ic');
  head.append(sgIcon);
  head.append(el('h3', '', getString('panel-mcp-title')));
  const stBadge = el('span', `badge ${enabled ? 'ok' : 'muted'}`);
  stBadge.append(iconEl(enabled ? 'zap' : 'power', 'ic ic-sm'));
  stBadge.append(document.createTextNode(getString(enabled ? 'panel-mcp-running' : 'panel-mcp-stopped')));
  head.append(stBadge);
  card.append(head);

  // 启用开关
  const toggleRow = el('div', 'mcp-row');
  toggleRow.append(el('span', 'k', getString('panel-mcp-switch')));
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.className = 'switch';
  toggle.checked = enabled;
  toggle.title = getString(enabled ? 'panel-mcp-disable-title' : 'panel-mcp-enable-title');
  toggle.setAttribute('aria-label', getString('panel-mcp-switch-aria'));
  toggle.addEventListener('change', () => {
    void setMcpEnabled(toggle.checked);
  });
  toggleRow.append(toggle);
  toggleRow.append(el('span', '', getString(enabled ? 'panel-mcp-enabled' : 'panel-mcp-disabled')));
  card.append(toggleRow);

  // 主机与实际监听端口
  const hostRow = el('div', 'mcp-row');
  hostRow.append(el('span', 'k', getString('panel-mcp-host')));
  hostRow.append(el('div', 'url-box', host));
  card.append(hostRow);

  const portRow = el('div', 'mcp-row');
  portRow.append(el('span', 'k', getString('panel-mcp-port')));
  portRow.append(el('div', 'url-box', port !== null ? String(port) : '—'));
  card.append(portRow);

  // 服务端点（一键复制）
  const urlRow = el('div', 'mcp-row');
  urlRow.append(el('span', 'k', getString('panel-mcp-endpoint')));
  if (url) {
    const urlBox = el('div', 'url-box', url);
    urlBox.title = getString('panel-mcp-endpoint-title');
    urlRow.append(urlBox);
    urlRow.append(
      opBtn(getString('panel-action-copy'), (b) => copyText(url!, b), { icon: 'copy', title: getString('panel-mcp-copy-endpoint-title') })
    );
  } else {
    urlRow.append(el('span', 'muted', getString('panel-mcp-port-unknown')));
  }
  card.append(urlRow);

  if (!lanAccessible) {
    const localOnly = el('div', 'notice');
    localOnly.append(iconEl('alert-circle', 'ic'));
    localOnly.append(document.createTextNode(getString('panel-mcp-local-only')));
    card.append(localOnly);
  }

  // 访问凭据开关：原独立设置页配置合并到 MCP 模块。
  const tokenToggleRow = el('div', 'mcp-row');
  tokenToggleRow.append(el('span', 'k', getString('panel-mcp-token-switch')));
  const tokenToggle = el('input');
  tokenToggle.type = 'checkbox';
  tokenToggle.className = 'switch';
  tokenToggle.checked = tokenEnabled;
  tokenToggle.setAttribute('aria-label', getString('panel-mcp-token-switch'));
  tokenToggle.addEventListener('change', () => {
    try {
      mcp.setTokenEnabled(tokenToggle.checked);
      renderMcp();
    } catch (e) {
      showError(getString('panel-err-mcp-token-toggle-failed', { error: errMsg(e) }));
    }
  });
  tokenToggleRow.append(tokenToggle);
  tokenToggleRow.append(
    el(
      'span',
      '',
      getString(tokenEnabled ? 'panel-mcp-token-enabled' : 'panel-mcp-token-disabled-short')
    )
  );
  card.append(tokenToggleRow);

  // token：默认关闭，仅在用户显式启用访问凭据后生成/展示。
  const tokenRow = el('div', 'mcp-row');
  tokenRow.append(el('span', 'k', getString('panel-mcp-token')));
  if (tokenEnabled) {
    const tokenBox = el('div', 'token-box', token);
    tokenBox.title = getString('panel-mcp-token-title');
    tokenRow.append(tokenBox);
    tokenRow.append(
      opBtn(getString('panel-action-copy'), (b) => copyText(token, b), {
        icon: 'copy',
        title: getString('panel-mcp-copy-token-title'),
        secondary: true,
      })
    );
    tokenRow.append(
      opBtn(getString('panel-action-regen'), () => regenerateToken(), {
        icon: 'key',
        title: getString('panel-mcp-regen-title'),
        secondary: true,
      })
    );
  } else {
    tokenRow.append(el('span', 'muted', getString('panel-mcp-token-disabled')));
  }
  card.append(tokenRow);
  card.append(
    el('div', 'hint', getString(tokenEnabled ? 'panel-mcp-token-hint' : 'panel-mcp-token-disabled-hint'))
  );

  // 关闭时的明确提示
  const notice = el('div', 'notice');
  notice.append(iconEl('alert-circle', 'ic'));
  notice.append(
    document.createTextNode(getString('panel-mcp-stopped-notice'))
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
  head.append(el('h3', '', getString('panel-audit-title')));
  head.append(el('span', 'count', getString('panel-audit-recent', { n: AUDIT_LIMIT })));
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
    card.append(el('div', 'muted', getString('panel-audit-empty')));
    return card;
  }
  const KIND_META = {
    claim: { label: getString('panel-audit-claim'), cls: 'accent', icon: 'zap' },
    done: { label: getString('panel-audit-done'), cls: 'ok', icon: 'check-circle' },
    fail: { label: getString('panel-audit-fail'), cls: 'danger', icon: 'alert-circle' },
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
    const sgName = api!.skillGroups.get(ev.task.skillGroupId)?.name ?? getString('panel-detail-sg-deleted');
    let sub = sgName;
    if (ev.kind === 'done') {
      const t = ev.task;
      const dtype = t.deliverableType ?? (t.noteKey ? 'note' : null);
      if (dtype === 'file' || (dtype === 'markdown' && !t.noteKey)) {
        sub += ` · ${getString('panel-audit-file')} ${t.deliverableRef ?? ''}`;
      } else if (t.noteKey) {
        sub += ` · ${getString('panel-audit-note')} ${t.noteKey}`;
      }
      if (t.attachmentKey) {
        sub += ` · ${getString('panel-audit-attachment')} ${t.attachmentKey}`;
      }
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
    showError(getString('panel-err-mcp-toggle-failed', { error: errMsg(e) }));
  }
}

/** 重新生成 token（操作前 confirm） */
async function regenerateToken(): Promise<void> {
  if (!api) {
    return;
  }
  clearError();
  if (
    !window.confirm(getString('panel-confirm-regen-token'))
  ) {
    return;
  }
  try {
    api.mcp.regenerateToken();
    renderMcp();
  } catch (e) {
    showError(getString('panel-err-regen-token-failed', { error: errMsg(e) }));
  }
}

// ────────────────────────── 启动 ──────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
