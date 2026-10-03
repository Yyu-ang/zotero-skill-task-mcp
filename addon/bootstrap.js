/* ==========================================================================
 * bootstrap.js — Zotero 插件生命周期入口（Zotero 9/10 兼容）
 *
 * 这是 Zotero 加载插件时调用的第一个文件。
 * 职责仅限于：加载主插件代码 → 转发生命周期事件。
 * 保持此文件精简和稳定，不做任何业务逻辑。
 * ========================================================================== */

/* 在 bootstrap 作用域中可直接使用以下全局对象（无需 import）：
 *   Zotero, ZoteroPane, Services, Cc, Ci, Cr, Components, rootURI
 */

const PLUGIN_ID = 'zotero-skill-task@example.com';
const PLUGIN_URI = rootURI; // 由 Zotero 注入的插件根 URI

/**
 * 加载编译后的主插件脚本。
 * 生成的 plugin.js 文件位于 addon/content/ 下，
 * 包含了 src/ 中所有 TS 源文件的编译产物。
 */
function loadPluginScript() {
  try {
    Services.scriptloader.loadSubScript(PLUGIN_URI + 'content/plugin.js');
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
  loadPluginScript();
  if (typeof PluginHook?.install === 'function') {
    PluginHook.install(data, reason);
  }
}

/**
 * 插件启动时调用（Zotero 启动/插件启用）。
 * @param {Object} data   - { id, version, rootURI }
 * @param {number} reason - APP_STARTUP | ADDON_ENABLE | ADDON_UPGRADE | ADDON_DOWNGRADE
 */
function startup(data, reason) {
  loadPluginScript();
  if (typeof PluginHook?.startup === 'function') {
    PluginHook.startup(data, reason);
    PluginHook.addToAllWindows?.();
  }
}

/**
 * 插件关闭时调用（Zotero 关闭/插件禁用）。
 * @param {Object} data   - { id, version, rootURI }
 * @param {number} reason - APP_SHUTDOWN | ADDON_DISABLE
 */
function shutdown(data, reason) {
  if (typeof PluginHook?.shutdown === 'function') {
    PluginHook.removeFromAllWindows?.();
    PluginHook.shutdown(data, reason);
  }
}

/**
 * 插件卸载时调用。
 * @param {Object} data   - { id, version, rootURI }
 * @param {number} reason - APP_UNINSTALL | ADDON_UNINSTALL | ADDON_UPGRADE | ADDON_DOWNGRADE
 */
function uninstall(data, reason) {
  if (typeof PluginHook?.uninstall === 'function') {
    PluginHook.uninstall(data, reason);
  }
}
