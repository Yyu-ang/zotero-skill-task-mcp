/**
 * src/prefs.ts — 偏好设置管理器
 *
 * 封装 Zotero.Prefs API，提供类型安全的读写接口。
 * global=true：使用 "extensions.zotero-skill-task." 前缀（插件推荐）。
 */

/** 插件偏好设置键 */
export const PREFS = {
  ENABLED: 'extensions.zotero-skill-task.enabled',
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
