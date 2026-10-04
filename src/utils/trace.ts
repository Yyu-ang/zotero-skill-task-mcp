/**
 * src/utils/trace.ts — 方法级统一日志装饰器（需求单 需求5）
 *
 * `@traced`：自动记录"类名.方法名"的进入日志与异常日志（异常带堆栈）。
 * 进入日志走 log()（info 级，生产构建自动收敛）；异常日志走 error()（始终保留）。
 * 同步抛错与异步 reject 都会被捕获记录后重新抛出，不改变原有语义。
 *
 * 用法：
 *   import { traced } from './utils/trace';
 *   class Foo {
 *     @traced
 *     async bar() { ... }
 *   }
 *
 * 约束：零第三方依赖；需 tsconfig 开启 experimentalDecorators（传统装饰器语义，
 * esbuild 会按 tsconfig 自动采用对应语义编译）。
 */

import { log, error } from '../utils';

/**
 * 方法装饰器：统一记录进入与异常。
 */
export function traced(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
): PropertyDescriptor {
  const original = descriptor.value;
  if (typeof original !== 'function') {
    return descriptor;
  }
  const className =
    (target && target.constructor && target.constructor.name) || 'unknown';
  const label = `${className}.${propertyKey}`;
  descriptor.value = function (this: unknown, ...args: unknown[]) {
    log(`[trace] ${label} enter`);
    let result: unknown;
    try {
      result = Reflect.apply(original, this, args);
    } catch (e) {
      // 同步抛错：带堆栈记录后原样抛出
      error(`[trace] ${label} threw:`, e);
      throw e;
    }
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as Promise<unknown>).then === 'function'
    ) {
      return (result as Promise<unknown>).catch((e: unknown) => {
        error(`[trace] ${label} rejected:`, e);
        throw e;
      });
    }
    return result;
  };
  return descriptor;
}
