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
   * 单通道访问业务 API，并由 preferences.xhtml 的 pane onload 触发初始化。
   *
   * 注意：scope 里没有真实的 Zotero 全局（globalThis 是 ctx 自身），
   * 所以把 bootstrap 作用域的 Zotero/Services 等显式传进去。
   */
  const ctx = { rootURI };
  // loadSubScript(target) 会把 target 作为脚本全局；显式补齐 globalThis/_globalThis，
  // 避免 bundle 内通过 globalThis 访问宿主对象时落到空 scope。
  ctx._globalThis = ctx;
  ctx.globalThis = ctx;

  // 把插件运行时实际使用的 Zotero/Gecko 宿主全局显式传入 scope。
  // 不能只传 Zotero/Services：store 初始化会直接使用 PathUtils/IOUtils，
  // 缺失时会导致业务 API 初始化失败，最终表现为面板/设置页拿不到 Zotero.SkillTask。
  try { ctx.Zotero = Zotero; } catch {}
  try { ctx.Services = Services; } catch {}
  try { ctx.PathUtils = PathUtils; } catch {}
  try { ctx.IOUtils = IOUtils; } catch {}
  try { ctx.Components = Components; } catch {}
  try { ctx.ChromeUtils = ChromeUtils; } catch {}
  try { ctx.Cc = Cc; } catch {}
  try { ctx.Ci = Ci; } catch {}
  try { ctx.DOMParser = DOMParser; } catch {}
  try { ctx.TextEncoder = TextEncoder; } catch {}
  try { ctx.URL = URL; } catch {}
  try { ctx.atob = atob; } catch {}
  try { ctx.btoa = btoa; } catch {}
  try { ctx.crypto = crypto; } catch {}
  try { ctx.setTimeout = setTimeout; } catch {}
  try { ctx.clearTimeout = clearTimeout; } catch {}
  try { ctx.setInterval = setInterval; } catch {}
  try { ctx.clearInterval = clearInterval; } catch {}

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
    if (!inst || !inst.hooks || typeof inst.hooks.onStartup !== 'function') {
      throw new Error('plugin.js loaded but did not register startup hooks');
    }
    await inst.hooks.onStartup({ id, version, rootURI }, reason);
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
