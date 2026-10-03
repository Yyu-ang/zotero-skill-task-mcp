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
