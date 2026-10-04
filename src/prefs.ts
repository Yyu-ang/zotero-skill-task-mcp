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
  /** 文件交付物大小上限（MB），默认 50，硬上限 200；修改实时生效 */
  DELIVERABLE_MAX_FILE_MB: 'extensions.zotero-skill-task.deliverable.maxFileMB',
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
 * 当前文件交付物大小上限（字节）：读偏好（MB），钳制在硬上限内。
 * 设置页修改后实时生效，无需重启。
 */
export function getDeliverableMaxBytes(): number {
  const hardCapMB = Math.floor(LIMITS.deliverableFileHardCapBytes / 1048576);
  const mb = Number(prefs.get(PREFS.DELIVERABLE_MAX_FILE_MB, 50));
  const safeMB =
    Number.isFinite(mb) && mb > 0 ? Math.min(mb, hardCapMB) : 50;
  return Math.floor(safeMB * 1048576);
}
