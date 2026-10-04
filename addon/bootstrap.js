/* ==========================================================================
 * bootstrap.js — Zotero 插件生命周期入口
 *
 * 参照 Green Frog (redleafnew/zotero-updateifsE) 的成熟模式：
 * - startup 解构 { id, version, rootURI }
 * - 等待 Zotero.initializationPromise
 * - 用 ctx 对象作为 loadSubScript 的 scope，插件实例单层挂在 Zotero['zotero-skill-task']
 *  （对标 Green Frog 的 Zotero.greenfrog / AI-Butler 的 Zotero.AIButler）
 * - 通过 hooks.onStartup() / hooks.onShutdown() 调用插件逻辑
 * ========================================================================== */

function install(data, reason) {}

async function startup({ id, version, rootURI }, reason) {
  // 等待 Zotero 初始化完成（Green Frog 模式）
  try {
    await Zotero.initializationPromise;
  } catch (e) {
    // Zotero 9 之前可能没有 initializationPromise，继续
  }

  /**
   * 插件代码的全局变量容器。
   * loadSubScript 的第二个参数会成为被加载脚本的作用域，
   * 脚本内所有顶层变量都会挂到这个对象上。
   * 插件实例单层挂在 Zotero['zotero-skill-task'] 上（{ plugin, hooks }），
   * bootstrap.js 直接调用其 hooks；设置页的 preferences.js 经 Zotero.SkillTask
   * 单通道访问业务 API（preferences.xhtml 无 onload 回调）。
   *
   * 注意：scope 里没有真实的 Zotero 全局（globalThis 是 ctx 自身），
   * 所以把 bootstrap 作用域的 Zotero/Services 等显式传进去。
   */
  const ctx = { rootURI };
  ctx._globalThis = ctx;
  // 把真实的全局对象传进 scope（Green Frog 用 toolkit.getGlobal，这里直接传）
  try {
    ctx.Zotero = Zotero;
  } catch {
    // ignore
  }
  try {
    ctx.Services = Services;
  } catch {
    // ignore
  }

  try {
    Services.scriptloader.loadSubScript(rootURI + 'content/plugin.js', ctx);
  } catch (e) {
    Components.utils.reportError(
      `[zotero-skill-task] Failed to load plugin script: ${e.message}\n${e.stack}`
    );
    return;
  }

  // 调用插件的启动钩子（Zotero['zotero-skill-task'].hooks.onStartup()）
  try {
    const inst = Zotero['zotero-skill-task'];
    if (inst && inst.hooks && typeof inst.hooks.onStartup === 'function') {
      await inst.hooks.onStartup({ id, version, rootURI }, reason);
    }
  } catch (e) {
    Components.utils.reportError(
      `[zotero-skill-task] onStartup failed: ${e.message}\n${e.stack}`
    );
  }
}

async function onMainWindowLoad({ window }, reason) {
  try {
    const inst = Zotero['zotero-skill-task'];
    if (inst && inst.hooks && typeof inst.hooks.onMainWindowLoad === 'function') {
      await inst.hooks.onMainWindowLoad(window, reason);
    }
  } catch (e) {
    Components.utils.reportError(
      `[zotero-skill-task] onMainWindowLoad failed: ${e.message}\n${e.stack}`
    );
  }
}

async function onMainWindowUnload({ window }, reason) {
  try {
    const inst = Zotero['zotero-skill-task'];
    if (inst && inst.hooks && typeof inst.hooks.onMainWindowUnload === 'function') {
      await inst.hooks.onMainWindowUnload(window, reason);
    }
  } catch (e) {
    // ignore
  }
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  try {
    const inst = Zotero['zotero-skill-task'];
    if (inst && inst.hooks && typeof inst.hooks.onShutdown === 'function') {
      inst.hooks.onShutdown(data, reason);
    }
  } catch (e) {
    // ignore
  }
}

function uninstall(data, reason) {}
