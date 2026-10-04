/**
 * src/index.ts — 插件打包入口
 *
 * esbuild 的打包入口文件。
 * 职责：实例化 PluginCore 并暴露为全局变量 PluginHook，
 * 供 addon/bootstrap.js 调用。
 */

import { PluginCore } from './core';
import { log } from './utils';

// 创建插件核心实例
const plugin = new PluginCore();

// 暴露到 bootstrap 作用域，供 addon/bootstrap.js 调用。
// bootstrap.js 通过 Services.scriptloader.loadSubScript() 加载此文件的
// 编译产物；注意 bootstrap 沙箱里没有 `window`（实测 typeof window ===
// 'undefined'），必须用 globalThis 挂载，否则 PluginHook 取不到，
// 插件 startup() 永远不会被调用（菜单/设置页无入口）。
(globalThis as any).PluginHook = plugin;

log('Skill Task module loaded');
