/**
 * src/utils.ts — 日志工具
 *
 * 日志分级（需求单 需求2：生产环境日志收敛）：
 * - log()    = info/debug 级：生产构建下静默（构建期经 esbuild define 注入 __SKILLTASK_ENV__）
 * - error()  = 错误级：始终输出，保证生产环境仍可定位问题
 */

// 构建期由 scripts/build.mjs 经 esbuild `define` 注入；tsc/测试等未注入场景视为开发环境
declare const __SKILLTASK_ENV__: string | undefined;

/** 当前构建环境（'production' | 'development'） */
function currentEnv(): string {
  try {
    if (
      typeof __SKILLTASK_ENV__ !== 'undefined' &&
      __SKILLTASK_ENV__
    ) {
      return __SKILLTASK_ENV__;
    }
  } catch {
    // ignore
  }
  return 'development';
}

/** 是否为生产构建 */
export const IS_PRODUCTION: boolean = currentEnv() === 'production';

const PREFIX = '[SkillTask]';

/** bootstrap 沙箱里没有 console（实测 ReferenceError），用 Zotero.debug 兜底 */
function zoteroDebugAvailable(): boolean {
  try {
    const Z: any = typeof Zotero !== 'undefined' ? Zotero : undefined;
    return !!Z && typeof Z.debug === 'function';
  } catch {
    return false;
  }
}

function consoleAvailable(): boolean {
  try {
    return typeof console !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * 普通日志（info/debug 级）。
 * 生产构建下静默，避免生产包刷屏控制台；错误请用 error()。
 * 兼容 bootstrap 沙箱（无 console）与窗口作用域。
 */
export function log(...args: any[]): void {
  if (IS_PRODUCTION) return;
  const msg = `${PREFIX} ${args.map((a) => String(a)).join(' ')}`;
  try {
    if (zoteroDebugAvailable()) {
      (Zotero as any).debug(msg);
      return;
    }
  } catch {
    // ignore，继续尝试 console
  }
  try {
    if (consoleAvailable()) {
      // eslint-disable-next-line no-console
      console.log(PREFIX, ...args);
    }
  } catch {
    // ignore：日志永不抛错
  }
}

/**
 * 错误日志（生产环境也保留）。
 * 优先走 Zotero.logError（bootstrap 沙箱可用），否则 console.error。
 */
export function error(...args: any[]): void {
  const msg = `${PREFIX} ${args.map((a) => String(a)).join(' ')}`;
  try {
    const Z: any = typeof Zotero !== 'undefined' ? Zotero : undefined;
    if (Z && typeof Z.logError === 'function') {
      const first = args[0];
      Z.logError(first instanceof Error ? first : new Error(msg));
      return;
    }
  } catch {
    // ignore，继续尝试 console
  }
  try {
    if (consoleAvailable()) {
      // eslint-disable-next-line no-console
      console.error(PREFIX, ...args);
    }
  } catch {
    // ignore：日志永不抛错
  }
}

// ──────────── 输入长度上限（集中定义，便于统一调整） ────────────

/** 各类文本输入的长度上限 */
export const LIMITS = {
  /** 技能组名称最大字符数 */
  skillGroupName: 200,
  /** 任务指令最大字符数 */
  instruction: 20000,
  /** 任务失败原因（lastError）最大字符数 */
  failReason: 1000,
  /** MCP 提交的笔记 HTML 最大字符数（防超大提交卡死清理流程） */
  noteHtml: 2_000_000,
  /** 错误信息中展示的 id/片段最大长度（防超长 key/路径刷屏日志与报错） */
  displayId: 64,
  /** 返回给 MCP 客户端的错误片段最大长度 */
  mcpErrorSnippet: 300,
  /** 文件交付物默认单文件最大字节数（200MB） */
  deliverableFileBytes: 200 * 1024 * 1024,
    /** 交付物文件名最大字符数 */
  deliverableFileName: 120,
} as const;

/**
 * 把过长文本截断为可展示的摘要（保留头尾，中间用 … 代替）。
 * 用于错误信息与日志，避免超长的外部 key/路径污染输出。
 * 注意：只用于"展示"，不截断任何功能性数据（如真正要用的文件路径）。
 */
export function truncateForDisplay(
  value: unknown,
  max: number = LIMITS.displayId
): string {
  const s = String(value ?? '');
  if (s.length <= max) {
    return s;
  }
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}
