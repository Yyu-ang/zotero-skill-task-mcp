/**
 * src/index.ts — 插件打包入口（Green Frog 模式）
 *
 * esbuild 的打包入口文件。
 * bootstrap.js 用 Services.scriptloader.loadSubScript(url, ctx) 加载此文件的
 * 编译产物，ctx 会成为脚本的作用域。
 *
 * 插件实例挂在 Zotero['zotero-skill-task'] 上（单层，与 Green Frog 的 Zotero.greenfrog /
 * AI-Butler 的 Zotero.AIButler 一致），通过 hooks 对象暴露生命周期方法。
 */

import { PluginCore } from './core';
import { log } from './utils';

// 创建插件核心实例
const plugin = new PluginCore();

// Green Frog 模式：插件实例单层挂在 Zotero['zotero-skill-task'] 上
// （对标 Zotero.greenfrog / Zotero.AIButler），bootstrap.js 直接调用其 hooks；
// 设置页走 PreferencePanes.register 加载的 preferences.js，经 Zotero.SkillTask
// 单通道访问业务 API（xhtml 无 onload 回调）。
try {
  // bootstrap.js 经 loadSubScript 的 ctx scope 把真实 Zotero 传进来（ctx.Zotero）
  // 直接用全局 Zotero（如果可用），否则用 scope 传入的
  // Green Frog/AI-Butler 模式：单层挂载 Zotero['zotero-skill-task']（对标 Zotero.greenfrog / Zotero.AIButler）
  const Z: any =
    (globalThis as any).Zotero ??
    (typeof Zotero !== 'undefined' ? (Zotero as any) : undefined);
  if (Z) {
    Z['zotero-skill-task'] = {
      plugin,
      hooks: {
        onStartup: (data: any) => plugin.startup(data),
        onShutdown: (data: any) => plugin.shutdown(data),
        onMainWindowLoad: (win: any) => plugin.onMainWindowLoad({ window: win }),
        onMainWindowUnload: (win: any) => plugin.onMainWindowUnload({ window: win }),
      },
    };
    log("Skill Task: registered on Zotero['zotero-skill-task']");
  } else {
    log('Skill Task: Zotero global not found, instance not set');
  }
} catch (e) {
  log(`Skill Task: failed to register instance: ${e}`);
}

// 保留旧的 PluginHook 兼容（bootstrap.js 不再使用，但防止外部依赖）
try {
  (globalThis as any).PluginHook = plugin;
} catch {
  // ignore
}

log('Skill Task module loaded');
