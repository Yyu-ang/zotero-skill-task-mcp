/**
 * src/utils.ts — 日志工具
 */

const PREFIX = '[SkillTask]';

/**
 * 普通日志。
 */
export function log(...args: any[]): void {
  // eslint-disable-next-line no-console
  console.log(PREFIX, ...args);
}

/**
 * 错误日志。
 */
export function error(...args: any[]): void {
  // eslint-disable-next-line no-console
  console.error(PREFIX, ...args);
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
  /** 文件交付物默认单文件最大字节数（50MB，可被技能组配置覆盖） */
  deliverableFileBytes: 50 * 1024 * 1024,
  /** 文件交付物单文件硬上限（200MB，技能组自定义不得超过） */
  deliverableFileHardCapBytes: 200 * 1024 * 1024,
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
