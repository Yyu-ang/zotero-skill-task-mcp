/**
 * src/utils/locale.ts — JS 侧 Fluent 国际化（需求单 需求1）
 *
 * 封装 initLocale() / getString(key, args?)，供面板（panel.ts）与
 * 设置页（preferences.ts）的 JS 动态文案调用。
 *
 * 设计（参考 Green Frog「用 Localization 实例供 JS 调用」的模式，
 * 按本仓库约束做了同步化改造）：
 * - 文案唯一来源仍是 addon/locale/{zh-CN,en-US}/skill-task.ftl（与 XUL 静态文案同一文件）；
 * - 构建时由 scripts/gen-locale.mjs 提取为 src/utils/locale-data.ts
 *   （同步字典），getString() 保持同步签名，避免 200+ 调用点异步化；
 * - 构建期强制校验：无缺 key、无死 key、中英对齐。
 *
 * 语言判定：Zotero.locale 以 zh 开头 → 中文，否则英文（与 preferences.ts
 * 原有逻辑一致；Zotero 切换语言需重启，故首次使用后缓存）。
 * 缺 key 时逐级回退：当前语言 → 中文 → key 本身，绝不抛错。
 */

import { LOCALE_STRINGS } from './locale-data';

export type LocaleArgs = Record<string, string | number>;

let current: 'zh' | 'en' = 'zh';
let initialized = false;

function detectLang(): 'zh' | 'en' {
  try {
    const g = globalThis as any;
    const loc = String(g.Zotero?.locale ?? '').toLowerCase();
    // Zotero 外（如 Node 测试）locale 为空时默认中文，与旧硬编码行为一致
    if (!loc) return 'zh';
    return loc.startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

/**
 * 初始化语言。插件/面板入口调用一次即可；重复调用幂等。
 * getString() 内部也会惰性初始化，故漏调不致命。
 */
export function initLocale(): void {
  current = detectLang();
  initialized = true;
}

/** 当前语言（主要供测试/诊断用） */
export function getLocale(): 'zh' | 'en' {
  if (!initialized) initLocale();
  return current;
}

/**
 * 取本地化字符串。args 中的 {name} 占位按名替换；
 * 未提供的占位原样保留（便于发现漏传）。
 */
export function getString(key: string, args?: LocaleArgs): string {
  if (!initialized) initLocale();
  const dict = LOCALE_STRINGS[current] ?? LOCALE_STRINGS.zh;
  let s: string | undefined = dict[key] ?? LOCALE_STRINGS.zh[key];
  if (s === undefined) return key;
  if (args) {
    s = s.replace(/\{(\w+)\}/g, (m, name: string) =>
      args[name] !== undefined ? String(args[name]) : m
    );
  }
  return s;
}
