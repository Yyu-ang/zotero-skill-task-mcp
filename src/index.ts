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

// 暴露到全局作用域，供 bootstrap.js 使用
// bootstrap.js 通过 Services.scriptloader.loadSubScript()
// 加载此文件的编译产物。执行后，PluginHook 会作为 window
// 的属性存在，bootstrap.js 中的全局引用即可访问到。
(window as any).PluginHook = plugin;

log('Skill Task module loaded');
