/**
 * src/prefs.ts — 偏好设置管理器
 *
 * 封装 Zotero.Prefs API，提供类型安全的读写接口。
 * global=true：使用 "extensions.zotero-skill-task." 前缀（插件推荐）。
 */

import { DEFAULT_LEASE_MS } from './types';
import { LIMITS } from './utils';

/** 插件偏好设置键 */
export const PREFS = {
  ENABLED: 'extensions.zotero-skill-task.enabled',
  /** 任务领取租约时长（分钟），默认 30；修改实时生效 */
  TASK_LEASE_MINUTES: 'extensions.zotero-skill-task.task.leaseMinutes',
  /** 文件交付物大小上限（MB），默认 200；修改实时生效 */
  DELIVERABLE_MAX_FILE_MB: 'extensions.zotero-skill-task.deliverable.maxFileMB',
  /** 面板快捷键总开关，默认 true；修改实时生效（需求单 需求6） */
  SHORTCUT_ENABLED: 'extensions.zotero-skill-task.shortcut.enabled',
  /** 面板快捷键字母（macOS），默认 'J'；修改实时生效 */
  SHORTCUT_KEY_MAC: 'extensions.zotero-skill-task.shortcut.keyMac',
  /** 面板快捷键字母（Windows/Linux），默认 'J'；修改实时生效 */
  SHORTCUT_KEY_WIN: 'extensions.zotero-skill-task.shortcut.keyWin',
} as const;

export type PrefKey = (typeof PREFS)[keyof typeof PREFS];

export class PrefsManager {
  private observerSymbols: symbol[] = [];

  /**
   * 获取偏好值（未设置时返回默认值）。
   */
  get(key: string, defaultValue?: any): any {
    try {
      const val = Zotero.Prefs.get(key, true);
      return val !== undefined ? val : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  /**
   * 设置偏好值。
   */
  set(key: string, value: boolean | string | number): void {
    Zotero.Prefs.set(key, value, true);
  }

  /**
   * 监听偏好变化。返回 symbol，用于取消监听。
   */
  observe(key: string, callback: (value: any) => void): symbol {
    const sym = Zotero.Prefs.registerObserver(key, callback, true);
    this.observerSymbols.push(sym);
    return sym;
  }

  /**
   * 取消监听。
   */
  unobserve(sym: symbol): void {
    try {
      Zotero.Prefs.unregisterObserver(sym);
    } finally {
      this.observerSymbols = this.observerSymbols.filter((s) => s !== sym);
    }
  }

  /**
   * 取消所有监听（插件关闭时调用）。
   */
  unobserveAll(): void {
    for (const sym of this.observerSymbols) {
      try {
        Zotero.Prefs.unregisterObserver(sym);
      } catch {
        // ignore
      }
    }
    this.observerSymbols = [];
  }
}

export const prefs = new PrefsManager();

/**
 * 当前租约时长（毫秒）：读偏好（分钟），非法值回退编译期默认值。
 * 每次领取时调用，设置页修改后实时生效，无需重启。
 */
export function getLeaseMs(): number {
  const mins = Number(prefs.get(PREFS.TASK_LEASE_MINUTES, 30));
  if (Number.isFinite(mins) && mins > 0) {
    return Math.floor(mins * 60 * 1000);
  }
  return DEFAULT_LEASE_MS;
}

/**
 * 当前文件交付物大小上限（字节）：读偏好（MB）。
 * 设置页修改后实时生效，无需重启。
 */
export function getDeliverableMaxBytes(): number {
  const mb = Number(prefs.get(PREFS.DELIVERABLE_MAX_FILE_MB, 200));
  const safeMB = Number.isFinite(mb) && mb > 0 ? Math.min(mb, 200) : 200;
  return Math.floor(safeMB * 1048576);
}

// ──────────── 面板快捷键配置（需求单 需求6） ────────────

/** 快捷键字母的默认值（J：已核对未被 Zotero 官方快捷键占用） */
export const DEFAULT_SHORTCUT_KEY = 'J';

/** 当前是否为 macOS（决定读 Mac 还是 Win 的按键偏好） */
export function isMacPlatform(): boolean {
  try {
    const g = globalThis as any;
    const os = g.Services?.appinfo?.OS;
    if (typeof os === 'string') return os === 'Darwin';
    const plat = g.navigator?.platform ?? g.Zotero?.platform ?? '';
    if (/mac/i.test(String(plat))) return true;
    if (typeof g.Zotero?.isMac === 'boolean') return g.Zotero.isMac;
  } catch {
    // ignore
  }
  return false;
}

/** 面板快捷键是否启用（默认 true；设置页修改后实时生效） */
export function isShortcutEnabled(): boolean {
  const v = prefs.get(PREFS.SHORTCUT_ENABLED, true);
  // Zotero.Prefs 可能返回字符串 "false"，做一次规范化
  if (typeof v === 'string') return v.toLowerCase() !== 'false';
  return !!v;
}

/**
 * 规范化快捷键字母：取首字符转大写，仅接受 A-Z / 0-9，
 * 非法值回退 DEFAULT_SHORTCUT_KEY（绝不抛错，保证快捷键不静默失效）。
 */
export function normalizeShortcutKey(raw: unknown): string {
  const c = String(raw ?? '').trim().charAt(0).toUpperCase();
  return /^[A-Z0-9]$/.test(c) ? c : DEFAULT_SHORTCUT_KEY;
}

/** 当前平台配置的快捷键字母（大写单字符） */
export function getShortcutKey(): string {
  const key = isMacPlatform() ? PREFS.SHORTCUT_KEY_MAC : PREFS.SHORTCUT_KEY_WIN;
  return normalizeShortcutKey(prefs.get(key, DEFAULT_SHORTCUT_KEY));
}
