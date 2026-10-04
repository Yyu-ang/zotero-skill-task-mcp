/* ==========================================================================
 * bootstrap.js — Zotero 插件生命周期入口（Zotero 9/10 兼容）
 *
 * 这是 Zotero 加载插件时调用的第一个文件。
 * 职责仅限于：加载主插件代码 → 转发生命周期事件。
 * 保持此文件精简和稳定，不做任何业务逻辑。
 * ========================================================================== */

/* 在 bootstrap 作用域中可直接使用以下全局对象（无需 import）：
 *   Zotero, ZoteroPane, Services, Cc, Ci, Cr, Components
 * 注意：
 * - 没有 `window`（typeof window === 'undefined'），不要用 window 挂载全局。
 * - 没有全局 `rootURI`；插件根 URI 从各生命周期函数的 data.rootURI 取。
 */

const PLUGIN_ID = 'zotero-skill-task@example.com';

/**
 * 安全获取 PluginHook（plugin.js 加载失败时返回 undefined，不抛错）。
 * 注意：不能用 typeof PluginHook?.x 写法——PluginHook 未声明时 ?. 仍会抛 ReferenceError。
 */
function getHook() {
  try {
    return globalThis.PluginHook ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 加载编译后的主插件脚本。
 * 生成的 plugin.js 文件位于 addon/content/ 下，
 * 包含了 src/ 中所有 TS 源文件的编译产物。
 * plugin.js 用 globalThis.PluginHook 暴露实例（bootstrap 沙箱无 window）。
 */
function loadPluginScript(rootURI) {
  try {
    Services.scriptloader.loadSubScript(rootURI + 'content/plugin.js');
  } catch (e) {
    Components.utils.reportError(
      `[${PLUGIN_ID}] Failed to load plugin script: ${e.message}\n${e.stack}`
    );
  }
}

/**
 * 插件安装/更新时调用。
 * @param {Object}   data   - { id, version, rootURI }
 * @param {number}   reason - APP_STARTUP | ADDON_INSTALL | ADDON_UPGRADE | ADDON_DOWNGRADE
 */
function install(data, reason) {
  loadPluginScript(data.rootURI);
  const hook = getHook();
  if (hook && typeof hook.install === 'function') {
    hook.install(data, reason);
  }
}

/**
 * 插件启动时调用（Zotero 启动/插件启用）。
 * @param {Object} data   - { id, version, rootURI }
 * @param {number} reason - APP_STARTUP | ADDON_ENABLE | ADDON_UPGRADE | ADDON_DOWNGRADE
 */
function startup(data, reason) {
  loadPluginScript(data.rootURI);
  const hook = getHook();
  if (hook && typeof hook.startup === 'function') {
    hook.startup(data, reason);
    if (typeof hook.addToAllWindows === 'function') {
      hook.addToAllWindows();
    }
  }
}

/**
 * 插件关闭时调用（Zotero 关闭/插件禁用）。
 * @param {Object} data   - { id, version, rootURI }
 * @param {number} reason - APP_SHUTDOWN | ADDON_DISABLE
 */
function shutdown(data, reason) {
  const hook = getHook();
  if (hook && typeof hook.shutdown === 'function') {
    if (typeof hook.removeFromAllWindows === 'function') {
      hook.removeFromAllWindows();
    }
    hook.shutdown(data, reason);
  }
}

/**
 * 插件卸载时调用。
 * @param {Object} data   - { id, version, rootURI }
 * @param {number} reason - APP_UNINSTALL | ADDON_UNINSTALL | ADDON_DOWNGRADE
 */
function uninstall(data, reason) {
  const hook = getHook();
  if (hook && typeof hook.uninstall === 'function') {
    hook.uninstall(data, reason);
  }
}
