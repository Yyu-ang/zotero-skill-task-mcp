/**
 * src/index.ts — 插件打包入口（Green Frog 模式）
 *
 * esbuild 的打包入口文件。
 * bootstrap.js 用 Services.scriptloader.loadSubScript(url, ctx) 加载此文件的
 * 编译产物，ctx 会成为脚本的作用域。
 *
 * 插件实例挂在 Zotero.__addonInstance__['zotero-skill-task'] 上，
 * 通过 hooks 对象暴露生命周期方法，供 bootstrap.js 和 preferences.xhtml 调用。
 */

import { PluginCore } from './core';
import { log } from './utils';

// 创建插件核心实例
const plugin = new PluginCore();

// Green Frog 模式：插件实例挂在 Zotero.__addonInstance__ 上
// preferences.xhtml 用 onload="Zotero.__addonInstance__['zotero-skill-task'].hooks.onPrefsEvent('load', {window})"
// 回调到这里，避免单独的 preferences.js 沙箱问题。
try {
  // bootstrap.js 经 loadSubScript 的 ctx scope 把真实 Zotero 传进来（ctx.Zotero）
  // 直接用全局 Zotero（如果可用），否则用 scope 传入的
  const Z: any =
    (globalThis as any).Zotero ??
    (typeof Zotero !== 'undefined' ? (Zotero as any) : undefined);
  if (Z) {
    if (!Z.__addonInstance__) {
      Z.__addonInstance__ = {};
    }
    Z.__addonInstance__['zotero-skill-task'] = {
      plugin,
      hooks: {
        onStartup: (data: any) => plugin.startup(data),
        onShutdown: (data: any) => plugin.shutdown(data),
        onMainWindowLoad: (win: any) => plugin.onMainWindowLoad({ window: win }),
        onMainWindowUnload: (win: any) => plugin.onMainWindowUnload({ window: win }),
        onPrefsEvent: (type: string, data: any) => (plugin as any).onPrefsEvent?.(type, data),
      },
    };
    log('Skill Task: registered on Zotero.__addonInstance__');
  } else {
    log('Skill Task: Zotero global not found, __addonInstance__ not set');
  }
} catch (e) {
  log(`Skill Task: failed to register __addonInstance__: ${e}`);
}

// 保留旧的 PluginHook 兼容（bootstrap.js 不再使用，但防止外部依赖）
try {
  (globalThis as any).PluginHook = plugin;
} catch {
  // ignore
}

log('Skill Task module loaded');
