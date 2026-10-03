/**
 * src/core.ts — 插件核心类
 *
 * 管理插件生命周期（startup/shutdown/install/uninstall）与
 * 已打开 / 后续打开的主窗口的 Fluent 本地化注入。
 * 业务功能（技能组、任务队列、MCP）后续在此组合。
 */

import { log } from './utils';
import {
  registerToolsMenu,
  unregisterToolsMenu,
  insertFluent,
  removeFluent,
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

  /** MVP 业务模块（startup 时组装，面板经 Zotero.SkillTask 访问） */
  private api: SkillTaskAPI | null = null;
  /** 租约过期释放定时器（5 分钟） */
  private leaseTimer: any = null;

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

    // 注册“工具”菜单入口（Zotero 8+ 官方 MenuManager API）
    this.menuID = registerToolsMenu(this.id, this.rootURI);

    // ── MVP 业务模块接线 ──
    try {
      const skillGroups = await SkillGroupStore.load();
      const tasks = await TaskStore.load();
      // 启动时释放过期租约（重启可恢复，FR-10）
      await tasks.releaseExpiredLeases();
      const generator = new TaskGenerator({ skillGroups, tasks });
      const mcp = new McpServer({
        skillGroups,
        tasks,
        version: this.version,
      });
      generator.registerNotifier();
      // 端点常驻注册；是否生效由 handler 层的启用开关 + 鉴权决定（默认关闭）
      mcp.register();
      this.api = { skillGroups, tasks, generator, mcp, version: this.version };
      // 面板（panel.js）经 Zotero.SkillTask 访问业务 API
      (Zotero as any).SkillTask = this.api;
      // 定时释放过期租约（5 分钟），避免长会话中任务被租约卡住
      this.leaseTimer = setInterval(() => {
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
    log('Skill Task initialized successfully');
  }

  /**
   * 插件 shutdown 时调用。清理所有资源，确保插件可安全禁用/卸载。
   */
  shutdown(_data?: any): void {
    if (!this.initialized) return;

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
    if ((Zotero as any).SkillTask === this.api) {
      delete (Zotero as any).SkillTask;
    }
    this.api = null;

    unregisterToolsMenu(this.menuID);
    this.menuID = null;

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
   * 主窗口加载时调用：注入 Fluent 本地化。
   */
  onMainWindowLoad({ window }: { window: Window }): void {
    if (!this.initialized) return;
    insertFluent(window);
  }

  /**
   * 主窗口卸载时调用：移除 Fluent 引用。
   */
  onMainWindowUnload({ window }: { window: Window }): void {
    if (!this.initialized) return;
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
