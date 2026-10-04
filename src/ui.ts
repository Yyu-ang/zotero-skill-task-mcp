/**
 * src/ui.ts — UI 管理
 *
 * 使用 Zotero 8+ 官方 MenuManager API 在“工具”菜单注册入口，
 * 点击打开占位管理面板（addon/content/panel.xhtml）。
 *
 * 约束：只用官方 API；禁用 Bluebird / Cu.import /
 * zotero-plugin-toolkit 的 Menu.register 等已废弃写法。
 */

import { log } from './utils';
import { isShortcutEnabled, getShortcutKey } from './prefs';

const FTL_FILE = 'skill-task.ftl';

/**
 * 打开管理面板的键盘快捷键（需求单 需求6：可配置化）。
 *
 * 默认 Ctrl+Shift+J（macOS ⌘+Shift+J）：已核对 Zotero 官方快捷键表，
 * Ctrl+Shift+S/N/O/I/A/C/K/T/R 等均被占用，J 未被占用。
 * 实际按键字母与启用开关走偏好（Mac/Win 分开存），设置页可改，修改实时生效。
 *
 * PANEL_SHORTCUT_LABEL* 保留作历史兼容（静态默认值）；运行时请用
 * getPanelShortcutLabel() 取当前配置。
 */
export const PANEL_SHORTCUT_LABEL = 'Ctrl+Shift+J';
export const PANEL_SHORTCUT_LABEL_MAC = '⌘+Shift+J';

/**
 * 已知被 Zotero 占用的 Ctrl/⌘+Shift+<key> 组合（尽力维护）。
 * 用户配到这些键时，设置页给出可见提示（不静默失效）；是否继续用由用户决定。
 */
export const RESERVED_SHORTCUT_KEYS = [
  'S',
  'N',
  'O',
  'I',
  'A',
  'C',
  'K',
  'T',
  'R',
] as const;

/** 指定按键字母是否与已知 Zotero 快捷键冲突 */
export function isShortcutKeyReserved(key: string): boolean {
  return (RESERVED_SHORTCUT_KEYS as readonly string[]).includes(
    String(key || '').toUpperCase()
  );
}

/** 当前配置的快捷键展示标签（如 "Ctrl+Shift+J" / "⌘+Shift+J"，按平台） */
export function getPanelShortcutLabel(): string {
  const key = getShortcutKey();
  try {
    const g = globalThis as any;
    const os = g.Services?.appinfo?.OS;
    if (os === 'Darwin' || /mac/i.test(String(g.navigator?.platform || ''))) {
      return `⌘+Shift+${key}`;
    }
  } catch {
    // ignore
  }
  return `Ctrl+Shift+${key}`;
}

const shortcutHandlers = new Map<Window, (e: KeyboardEvent) => void>();

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof (el as any).tagName !== 'string') return false;
  const tag = String((el as any).tagName).toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    !!(el as any).isContentEditable
  );
}

/**
 * 在主窗口注册打开管理面板的快捷键（Zotero 8+ 无官方快捷键 API，
 * 用窗口级 keydown 监听实现；捕获阶段注册，先于 Zotero 自有处理）。
 * 输入框内按键不触发，避免劫持用户输入。
 *
 * 需求4：handler 入口先查存活标志，已卸载则自移除监听并返回。
 * 需求6：按键字母与启用开关读偏好（handler 内实时读取，设置页修改即时生效，
 * 无需重新注册）。
 */
export function attachPanelShortcut(
  window: Window,
  rootURI: string,
  isAlive?: () => boolean
): void {
  if (shortcutHandlers.has(window)) return;
  const handler = (e: KeyboardEvent) => {
    // 需求4：长驻回调存活守卫
    if (isAlive && !isAlive()) {
      detachPanelShortcut(window);
      return;
    }
    // 需求6：开关关闭则不触发
    if (!isShortcutEnabled()) return;
    if (e.altKey || !(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if ((e.key || '').toUpperCase() !== getShortcutKey()) return;
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    openSkillTaskPanel(rootURI);
  };
  window.addEventListener('keydown', handler, true);
  shortcutHandlers.set(window, handler);
}

/** 移除某主窗口的面板快捷键监听。 */
export function detachPanelShortcut(window: Window): void {
  const h = shortcutHandlers.get(window);
  if (!h) return;
  try {
    window.removeEventListener('keydown', h, true);
  } catch {
    // ignore
  }
  shortcutHandlers.delete(window);
}

/** 移除所有主窗口的面板快捷键监听（shutdown 时调用，防泄漏）。 */
export function detachAllPanelShortcuts(): void {
  for (const [w, h] of Array.from(shortcutHandlers)) {
    try {
      w.removeEventListener('keydown', h, true);
    } catch {
      // ignore
    }
    shortcutHandlers.delete(w);
  }
}

/**
 * 在“工具”菜单注册“技能任务…”入口（Zotero 8+ API）。
 * @returns 注册的 menuID（用于取消注册），失败返回 null
 */
export function registerToolsMenu(
  pluginID: string,
  rootURI: string
): string | null {
  const menuManager = (Zotero as any).MenuManager;
  if (typeof menuManager?.registerMenu !== 'function') {
    log('MenuManager API not available, tools menu not registered');
    return null;
  }

  try {
    const id = menuManager.registerMenu({
      menuID: 'zotero-skill-task-tools-menu',
      pluginID,
      target: 'main/menubar/tools',
      menus: [
        {
          menuType: 'menuitem',
          l10nID: 'skill-task-menu-open-panel',
          onCommand: () => openSkillTaskPanel(rootURI),
        },
      ],
    });
    if (!id) {
      log('MenuManager.registerMenu rejected the registration');
      return null;
    }
    log(`Tools menu registered: ${id}`);
    return id as string;
  } catch (e) {
    log(`Failed to register tools menu: ${e}`);
    return null;
  }
}

/**
 * 取消注册“工具”菜单入口。
 */
export function unregisterToolsMenu(menuID: string | null): void {
  if (!menuID) return;
  const menuManager = (Zotero as any).MenuManager;
  if (typeof menuManager?.unregisterMenu !== 'function') return;
  try {
    menuManager.unregisterMenu(menuID);
    log(`Tools menu unregistered: ${menuID}`);
  } catch {
    // ignore
  }
}

/**
 * 向窗口注入 Fluent 本地化文件。
 */
export function insertFluent(window: Window): void {
  try {
    (window as any).MozXULElement?.insertFTLIfNeeded(FTL_FILE);
  } catch {
    // 非 XUL 窗口可能不支持
  }
}

/**
 * 移除窗口中的 Fluent 文件引用。
 */
export function removeFluent(window: Window): void {
  const link = window.document.querySelector(
    `link[href="${FTL_FILE}"]`
  ) as HTMLLinkElement | null;
  link?.remove();
}

/**
 * 打开技能任务管理面板（当前为占位页面，功能开发中）。
 */
export function openSkillTaskPanel(rootURI: string): void {
  const win = Zotero.getMainWindows()[0] as any;
  if (!win) {
    log('No main window available, cannot open panel');
    return;
  }
  win.openDialog(
    rootURI + 'content/panel.xhtml',
    'zotero-skill-task-panel',
    'chrome,resizable,centerscreen,width=760,height=560'
  );
}
