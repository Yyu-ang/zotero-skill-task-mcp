/**
 * src/core.ts — 插件核心类
 *
 * 管理插件生命周期（startup/shutdown/install/uninstall）与
 * 已打开 / 后续打开的主窗口的 Fluent 本地化注入。
 * 业务功能（技能组、任务队列、MCP）后续在此组合。
 */

import { log, IS_PRODUCTION } from './utils';
import {
  registerToolsMenu,
  unregisterToolsMenu,
  insertFluent,
  removeFluent,
  attachPanelShortcut,
  detachPanelShortcut,
  detachAllPanelShortcuts,
} from './ui';
import { SkillGroupStore } from './skillGroupStore';
import { TaskStore } from './taskStore';
import { TaskGenerator } from './taskGenerator';
import { McpServer } from './mcpServer';
import type { SkillTaskAPI } from './types';

export class PluginCore {
  // 插件元数据（由 bootstrap.js 传入）
  id: string = '';
  version: string = '';
  rootURI: string = '';

  // 子模块状态
  private initialized: boolean = false;
  private menuID: string | null = null;
  private windowListener: any = null;
  /** 设置面板 ID（PreferencePanes.register 返回） */
  private prefPaneID: string | null = null;

  /** MVP 业务模块（startup 时组装，面板经 Zotero.SkillTask 访问） */
  private api: SkillTaskAPI | null = null;
  /** 租约过期释放定时器（5 分钟） */
  private leaseTimer: any = null;
  /**
   * 存活标志（需求单 需求4：长驻回调存活守卫）。
   * startup 完成置 true；shutdown 入口置 false。
   * notifier 回调、租约 timer、快捷键回调入口先查此标志：
   * 已卸载则自注销监听/清除 timer 并直接返回，不操作已释放资源。
   */
  private alive: boolean = false;
  /** 开发模式热重载轮询定时器（仅 npm run dev 生效，生产包无此逻辑） */
  private devReloadTimer: any = null;

  // ──────────── 生命周期 ────────────

  /**
   * 插件 startup 时调用。初始化所有子模块。
   */
  async startup(data: {
    id: string;
    version: string;
    rootURI: string;
  }): Promise<void> {
    if (this.initialized) {
      log('Already initialized, skipping');
      return;
    }

    this.id = data.id;
    this.version = data.version;
    this.rootURI = data.rootURI;

    log(`Starting up v${this.version}`);
    log(`Zotero version: ${Zotero.version}`);

    // 需求单 需求3：等待 Zotero 完全就绪后再跑 store 加载，
    // 冷启动时序下避免踩空（各 Promise 做可用性检查，Zotero 9 兼容）。
    await this.waitForZoteroReady();

    // 注册“工具”菜单入口（Zotero 8+ 官方 MenuManager API）
    this.menuID = registerToolsMenu(this.id, this.rootURI);

    // ── MVP 业务模块接线 ──
    try {
      const skillGroups = await SkillGroupStore.load();
      const tasks = await TaskStore.load();
      // 启动时释放过期租约（重启可恢复，FR-10）
      await tasks.releaseExpiredLeases();
      const generator = new TaskGenerator({
        skillGroups,
        tasks,
        // 需求4：notifier 回调存活守卫
        isAlive: () => this.alive,
      });
      const mcp = new McpServer({
        skillGroups,
        tasks,
        version: this.version,
      });
      generator.registerNotifier();
      // 端点注册由 MCP 开关统一管理：启用时注册（setEnabled 幂等），
      // 停用时不注册/注销，无残留监听；handler 层的启用门禁同时保留作纵深防御
      if (mcp.isEnabled()) {
        mcp.register();
      }
      this.api = { skillGroups, tasks, generator, mcp, version: this.version };
      // 面板（panel.js）经 Zotero.SkillTask 访问业务 API
      (Zotero as any).SkillTask = this.api;
      // 定时释放过期租约（5 分钟），避免长会话中任务被租约卡住
      this.leaseTimer = setInterval(() => {
        // 需求4：插件已卸载则自清除 timer 并返回，不操作已释放资源
        if (!this.alive) {
          clearInterval(this.leaseTimer);
          this.leaseTimer = null;
          return;
        }
        tasks.releaseExpiredLeases().catch((e) => log(`Lease release failed: ${e}`));
      }, 5 * 60 * 1000);
      log('Skill Task business modules wired');
    } catch (e) {
      log(`Business modules failed to initialize: ${e}`);
      // 业务模块失败不影响菜单/面板框架本身
    }

    // 监听后续打开的主窗口，为其注入 Fluent 本地化
    // （否则“文件 → 新建窗口”打开的窗口里菜单标签为空）
    this.watchNewWindows();

    this.initialized = true;
    // 需求4：存活标志置 true（shutdown 入口置 false）
    this.alive = true;

    // P0 修复：startup() 是 async，bootstrap.js 里紧随其后的
    // addToAllWindows?.() 因 initialized 仍为 false 被全部跳过，
    // 导致初始主窗口从未注入 FTL、菜单 l10nID 无法解析。
    // 在此补调一次（bootstrap 那次 early-return，无害）。
    this.addToAllWindows();

    // 注册插件设置面板（Zotero 8+ PreferencePanes 官方 API）
    // 参照 Green Frog 模式：image（设置窗口左侧栏图标）+ defaultXUL（原生 XUL 默认样式）；
    // src 用 rootURI（已验证可工作）。设置项在编辑 → 设置 → 左侧"技能任务"。
    try {
      const PP = (Zotero as any).PreferencePanes;
      if (PP && typeof PP.register === 'function') {
        const locale = String((Zotero as any).locale || '');
        this.prefPaneID = await PP.register({
          pluginID: this.id,
          src: this.rootURI + 'content/preferences.xhtml',
          label: locale.toLowerCase().startsWith('zh') ? '技能任务' : 'Skill Task',
          image: this.rootURI + 'content/icons/icon-48.png',
          defaultXUL: true,
          scripts: [this.rootURI + 'content/preferences.js'],
        });
        log(`Preference pane registered: ${this.prefPaneID}`);
      } else {
        log('PreferencePanes API not available, settings pane skipped');
      }
    } catch (e) {
      log(`Preference pane registration failed: ${e}`);
    }

    log('Skill Task initialized successfully');

    // 开发模式热重载（npm run dev）：serve.mjs 重建后更新 trigger 文件时间戳，
    // 这里检测到变化即热重载插件，无需重启 Zotero。生产包 IS_PRODUCTION 为 true，直接跳过。
    this.startDevReloadWatcher();
  }

  /**
   * 开发模式热重载监听（仅 dev 构建）。
   * 约定：serve.mjs 在每次重建后 `touch <profile>/extensions/.skill-task-dev-reload`；
   * 本方法每秒检查该文件 mtime，变化即经 AddonManager.reload() 热重载。
   */
  private startDevReloadWatcher(): void {
    if (IS_PRODUCTION) return;
    try {
      // profile 目录：优先 Services.dirsvc（bootstrap 沙箱可用），兜底 Zotero.Profile
      let profileDir: string | null = null;
      try {
        const Svc = (globalThis as any).Services;
        const Ci = (globalThis as any).Ci;
        if (Svc?.dirsvc && Ci?.nsIFile) {
          profileDir = Svc.dirsvc.get('ProfD', Ci.nsIFile).path;
        }
      } catch {
        // ignore
      }
      if (!profileDir) {
        try {
          profileDir = (Zotero as any).Profile?.dir ?? null;
        } catch {
          // ignore
        }
      }
      if (!profileDir) return;
      const triggerPath = `${profileDir}/extensions/.skill-task-dev-reload`;

      const getMtime = (): number | null => {
        try {
          // bootstrap 沙箱有 Cc/Ci（官方文档），用 nsIFile 取 mtime
          const Cc = (globalThis as any).Cc;
          const Ci = (globalThis as any).Ci;
          if (Cc && Ci) {
            const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
            file.initWithPath(triggerPath);
            if (file.exists()) {
              return file.lastModifiedTime;
            }
          }
        } catch (e) {
          log(`[dev] stat failed: ${e}`);
        }
        return null;
      };

      let lastMtime = getMtime();
      if (lastMtime === null) return; // 无 trigger 文件，不启用
      log('[dev] hot-reload watcher enabled');

      this.devReloadTimer = setInterval(async () => {
        try {
          if (!this.alive) return;
          const mtime = getMtime();
          if (mtime !== null && mtime !== lastMtime) {
            lastMtime = mtime;
            log('[dev] change detected, hot-reloading plugin…');
            let AddonManager: any;
            try {
              ({ AddonManager } = (globalThis as any).ChromeUtils.importESModule(
                'resource://gre/modules/AddonManager.sys.mjs'
              ));
            } catch {
              ({ AddonManager } = (globalThis as any).ChromeUtils.import(
                'resource://gre/modules/AddonManager.jsm'
              ));
            }
            const addon = await AddonManager.getAddonByID(this.id);
            await addon?.reload();
          }
        } catch (e) {
          log(`[dev] hot-reload failed: ${e}`);
        }
      }, 1000);
      // 避免 timer 拖住进程退出（Node 语义；Zotero 下无害）
      try {
        (this.devReloadTimer as any)?.unref?.();
      } catch {
        // ignore
      }
    } catch {
      // 开发辅助逻辑永不影响主流程
    }
  }

  /**
   * 插件 shutdown 时调用。清理所有资源，确保插件可安全禁用/卸载。
   */
  shutdown(_data?: any): void {
    if (!this.initialized) return;

    // 需求4：先置存活标志为 false，长驻回调（notifier/timer/快捷键）
    // 在入口处自查并自注销，不再操作随后释放的资源
    this.alive = false;

    log('Shutting down Skill Task');

    // ── 业务模块清理（与 startup 对称）──
    try {
      this.api?.generator.unregisterNotifier();
    } catch {
      // ignore
    }
    try {
      this.api?.mcp.unregister();
    } catch {
      // ignore
    }
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    if (this.devReloadTimer) {
      clearInterval(this.devReloadTimer);
      this.devReloadTimer = null;
    }
    if ((Zotero as any).SkillTask === this.api) {
      delete (Zotero as any).SkillTask;
    }
    this.api = null;

    unregisterToolsMenu(this.menuID);
    this.menuID = null;

    // 注销设置面板（Zotero 也会在插件 shutdown 时自动注销，显式调用更稳妥）
    if (this.prefPaneID) {
      try {
        (Zotero as any).PreferencePanes?.unregister?.(this.prefPaneID);
      } catch {
        // ignore
      }
      this.prefPaneID = null;
    }

    // 移除所有主窗口的快捷键监听（防泄漏）
    detachAllPanelShortcuts();

    if (this.windowListener) {
      try {
        Services.wm.removeListener(this.windowListener);
      } catch {
        // ignore
      }
      this.windowListener = null;
    }

    this.initialized = false;
    log('Skill Task shutdown complete');
  }

  /**
   * 插件 install 时调用。只做一次性初始化，不要在此处修改 UI。
   */
  install(_data: any): void {
    log('Skill Task installed');
  }

  /**
   * 插件 uninstall 时调用。
   */
  uninstall(_data: any): void {
    log('Skill Task uninstalled');
  }

  // ──────────── 窗口管理 ────────────

  /**
   * 主窗口加载时调用：注入 Fluent 本地化 + 注册面板快捷键。
   */
  onMainWindowLoad({ window }: { window: Window }): void {
    if (!this.initialized) return;
    insertFluent(window);
    // 需求4：快捷键回调入口带存活守卫
    attachPanelShortcut(window, this.rootURI, () => this.alive);
  }

  /**
   * 主窗口卸载时调用：移除 Fluent 引用 + 快捷键监听。
   */
  onMainWindowUnload({ window }: { window: Window }): void {
    if (!this.initialized) return;
    detachPanelShortcut(window);
    removeFluent(window);
  }

  /**
   * 遍历所有已打开的窗口并注入本地化。
   */
  addToAllWindows(): void {
    const windows = Zotero.getMainWindows();
    for (const win of windows) {
      if ((win as any).ZoteroPane) {
        this.onMainWindowLoad({ window: win as unknown as Window });
      }
    }
  }

  /**
   * 遍历所有已打开的窗口并移除本地化引用。
   */
  removeFromAllWindows(): void {
    const windows = Zotero.getMainWindows();
    for (const win of windows) {
      if ((win as any).ZoteroPane) {
        this.onMainWindowUnload({ window: win as unknown as Window });
      }
    }
  }

  // ──────────── 内部方法 ────────────

  /**
   * 需求单 需求3：等待 Zotero 完全就绪。
   *
   * 只等 initializationPromise / unlockPromise（thenable 才等待），
   * 任一不可用直接跳过，不硬编码假设——兼容 Zotero 9+。
   *
   * 注意：不等待 uiReadyPromise。它在主窗口条目视图加载完成后才 resolve，
   * 而插件 startup（含菜单/设置页注册）不应依赖 UI 就绪；实测发现某些环境下
   * uiReadyPromise 迟迟不 resolve，会导致整个 startup 卡死、菜单和设置页
   * 无法注册。为保险起见，等待还设有超时兜底，超时后降级继续启动。
   */
  private async waitForZoteroReady(): Promise<void> {
    const Z: any = typeof Zotero !== 'undefined' ? Zotero : undefined;
    const pending: Array<Promise<unknown>> = [];
    for (const key of ['initializationPromise', 'unlockPromise']) {
      try {
        const p = Z?.[key];
        if (p && typeof p.then === 'function') {
          pending.push(p as Promise<unknown>);
        }
      } catch {
        // ignore：单个 Promise 不可读不影响其他
      }
    }
    if (!pending.length) {
      log('Zotero readiness promises 不可用，跳过等待（版本兼容）');
      return;
    }
    try {
      // 超时兜底：最多等 30 秒，避免某个 Promise 永久挂起卡死插件启动
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('waitForZoteroReady timeout')), 30000)
      );
      await Promise.race([Promise.all(pending), timeout]);
      log('Zotero ready, continuing startup');
    } catch (e) {
      log(`等待 Zotero 就绪时异常/超时，降级继续启动: ${e}`);
    }
  }

  /**
   * 监听后续打开的窗口，主窗口加载完成后注入 Fluent。
   */
  private watchNewWindows(): void {
    const listener = {
      onOpenWindow: (xulWindow: any) => {
        const domWindow = xulWindow.docShell?.domWindow;
        if (!domWindow) return;
        const onLoad = () => {
          domWindow.removeEventListener('load', onLoad);
          try {
            if ((domWindow as any).ZoteroPane) {
              insertFluent(domWindow);
            }
          } catch {
            // 非主窗口，忽略
          }
        };
        domWindow.addEventListener('load', onLoad);
      },
      onCloseWindow: (_xulWindow: any) => {
        // 无需处理
      },
    };
    Services.wm.addListener(listener);
    this.windowListener = listener;
  }
}
