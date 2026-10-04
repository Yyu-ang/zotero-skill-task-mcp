/**
 * scripts/gen-locale.mjs — JS 侧国际化数据生成器（需求单 需求1）
 *
 * 把 addon/locale/{zh-CN,en-US}/skill-task.ftl 中 "JS 动态文案" 节
 *（`# >>> JS-STRINGS` 标记之后的内容）提取为 src/utils/locale-data.ts，
 * 供 src/utils/locale.ts 的 getString() 同步调用。
 *
 * 设计说明：
 * - 文案以 .ftl 为唯一来源（与 XUL 静态文案同一文件），构建时提取；
 *   同步 getString() 无需 async/await，避免 200+ 调用点异步化改造。
 * - 每次构建前运行（scripts/build.mjs Step 0），并做一致性校验：
 *   ① 代码里 getString() 用到的 key 必须在 zh-CN 存在（无缺 key）
 *   ② JS 节定义的 key 必须都被代码用到（无死 key）
 *   ③ en-US 必须覆盖全部 zh-CN key（无缺翻译）
 *   任一失败即中断构建。
 *
 * 用法：
 *   node scripts/gen-locale.mjs          # 生成 src/utils/locale-data.ts
 *   node scripts/gen-locale.mjs --check # 只校验不写文件（CI/完工检查用）
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'src/utils/locale-data.ts');
const SECTION_MARKER = '# >>> JS-STRINGS';
const CHECK = process.argv.includes('--check');

/** 解析 ftl 的 JS 节：key = value（单行；续行以缩进续接，\\n 转义为换行） */
function parseJsSection(ftlPath) {
  const text = readFileSync(ftlPath, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === SECTION_MARKER);
  if (start === -1) {
    throw new Error(`JS 节标记 ${SECTION_MARKER} 不存在：${ftlPath}`);
  }
  const dict = new Map();
  let cur = null;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (m) {
      cur = m[1];
      if (dict.has(cur)) {
        throw new Error(`重复的 key "${cur}"：${ftlPath}`);
      }
      dict.set(cur, unescape(m[2].trim()));
    } else if (cur && /^\s/.test(line)) {
      dict.set(cur, dict.get(cur) + '\n' + unescape(trimmed));
    } else {
      throw new Error(`无法解析的行：${line}\n  (${ftlPath})`);
    }
  }
  return dict;
}

/** 把 \n 转义还原为换行；{$var}（Fluent 变量语法）归一为 {var} */
function unescape(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\{\$([A-Za-z0-9_]+)\}/g, '{$1}');
}

/** 粗略去注释后扫描源码里的 getString('key') / getString("key") */
function scanUsedKeys() {
  /** 递归收集 src 下的 .ts 文件（直接走文件系统，不依赖 git，覆盖未追踪文件） */
  function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p, out);
      } else if (name.endsWith('.ts')) {
        out.push(p);
      }
    }
    return out;
  }
  const files = walk(resolve(ROOT, 'src'));
  const used = new Set();
  // 收集 getString(...) 整个调用（含三元选 key：getString(c ? 'a' : 'b')）内的全部 key 字面量；
  // 只认 panel-/prefs- 前缀，避免把 'note' 之类的比较字面量误判为 key
  const keyRe = /['"]((?:panel|prefs)-[A-Za-z0-9_-]+)['"]/g;
  for (const f of files) {
    let src = readFileSync(f, 'utf8');
    // 去掉行注释与块注释，避免注释里的示例被误判
    src = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    let idx = 0;
    while ((idx = src.indexOf('getString(', idx)) !== -1) {
      let depth = 0;
      let end = -1;
      for (let j = idx + 'getString('.length - 1; j < src.length; j++) {
        const ch = src[j];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end === -1) break;
      const callText = src.slice(idx, end + 1);
      let m;
      keyRe.lastIndex = 0;
      while ((m = keyRe.exec(callText))) used.add(m[1]);
      idx = end + 1;
    }
  }
  return used;
}

function main() {
  const zh = parseJsSection(resolve(ROOT, 'addon/locale/zh-CN/skill-task.ftl'));
  const en = parseJsSection(resolve(ROOT, 'addon/locale/en-US/skill-task.ftl'));
  const used = scanUsedKeys();

  const zhKeys = new Set(zh.keys());
  const enKeys = new Set(en.keys());
  const fail = (msg) => {
    console.error(`[gen-locale] 校验失败：${msg}`);
    process.exit(1);
  };

  // ① 无缺 key
  const missing = [...used].filter((k) => !zhKeys.has(k)).sort();
  if (missing.length) fail(`代码用到的 key 在 zh-CN 缺失：${missing.join(', ')}`);
  // ② 无死 key
  const dead = [...zhKeys].filter((k) => !used.has(k)).sort();
  if (dead.length) fail(`zh-CN 定义了但代码未用的 key（死 key）：${dead.join(', ')}`);
  // ③ en 全覆盖
  const untranslated = [...zhKeys].filter((k) => !enKeys.has(k)).sort();
  if (untranslated.length) {
    fail(`en-US 缺少翻译：${untranslated.join(', ')}`);
  }

  const toTs = (dict) => {
    const entries = [...dict.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    return `{\n${entries.join('\n')}\n  }`;
  };
  const content =
    `/**\n` +
    ` * src/utils/locale-data.ts — 由 scripts/gen-locale.mjs 自动生成，请勿手改。\n` +
    ` * 来源：addon/locale/{zh-CN,en-US}/skill-task.ftl（JS 动态文案节）。\n` +
    ` */\n` +
    `export const LOCALE_STRINGS: Record<'zh' | 'en', Record<string, string>> = {\n` +
    `  zh: ${toTs(zh)},\n` +
    `  en: ${toTs(en)},\n` +
    `};\n`;

  if (CHECK) {
    const current = readFileSync(OUT, 'utf8');
    if (current !== content) {
      fail('locale-data.ts 与 ftl 不一致，请运行 node scripts/gen-locale.mjs 重新生成');
    }
    console.log(
      `[gen-locale] OK — ${zhKeys.size} keys（zh/en 对齐，无死 key、无缺 key）`
    );
    return;
  }
  writeFileSync(OUT, content);
  console.log(`[gen-locale] 生成 ${OUT}（${zhKeys.size} keys）`);
}

main();
