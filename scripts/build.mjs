/**
 * scripts/build.mjs — esbuild 构建脚本
 *
 * 1. 将 src/ 下的 TypeScript 打包为单个 addon/content/plugin.js
 * 2. 把 addon/ 打包为 dist/<name>-<version>.xpi（构建产物，不进仓库）
 *
 * 用法：
 *   node scripts/build.mjs          # 生产构建
 *   node scripts/build.mjs --dev    # 开发构建（含 sourcemap）
 */

import * as esbuild from 'esbuild';
import { execSync } from 'child_process';
import {
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  rmSync,
} from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));

const isDev = process.argv.includes('--dev');
const DIST_DIR = resolve(ROOT, 'dist');
const XPI_NAME = `${pkg.name}-${pkg.version}.xpi`;

async function main() {
  const start = Date.now();

  // ── Step 0: 生成 JS 侧国际化数据（src/utils/locale-data.ts）──
  // 需求单 需求1：JS 动态文案以 addon/locale/*/skill-task.ftl 为唯一来源，
  // 构建时提取并做 key 一致性校验（无死 key、无缺 key），getString() 保持同步调用。
  execSync(`"${process.execPath}" "${resolve(ROOT, 'scripts/gen-locale.mjs')}"`, {
    stdio: 'inherit',
  });

  // ── 构建环境标识（需求单 需求2：生产环境日志收敛）──
  // esbuild `define` 在编译期把 __SKILLTASK_ENV__ 替换为字面量；
  // src/utils.ts 据此在生产构建下静默 log()（info/debug 级），error() 保留。
  const envDefine = {
    __SKILLTASK_ENV__: JSON.stringify(isDev ? 'development' : 'production'),
  };

  // ── Step 1: esbuild 打包 ──
  const result = await esbuild.build({
    entryPoints: [resolve(ROOT, 'src/index.ts')],
    outfile: resolve(ROOT, 'addon/content/plugin.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    treeShaking: true,
    legalComments: 'inline',
    define: envDefine,
    // zotero-types 仅提供类型定义，不参与运行时打包
    external: [],
  });

  if (result.errors.length) {
    console.error('Build failed:', result.errors);
    process.exit(1);
  }

  // ── Step 1b: esbuild 打包管理面板前端（模块 E：src/panel.ts → addon/content/panel.js）──
  const panelResult = await esbuild.build({
    entryPoints: [resolve(ROOT, 'src/panel.ts')],
    outfile: resolve(ROOT, 'addon/content/panel.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    treeShaking: true,
    legalComments: 'inline',
    define: envDefine,
    // zotero-types 仅提供类型定义，不参与运行时打包
    external: [],
  });

  if (panelResult.errors.length) {
    console.error('Panel build failed:', panelResult.errors);
    process.exit(1);
  }

  // ── Step 1c: esbuild 打包设置面板前端（src/preferences.ts → addon/content/preferences.js）──
  const prefsResult = await esbuild.build({
    entryPoints: [resolve(ROOT, 'src/preferences.ts')],
    outfile: resolve(ROOT, 'addon/content/preferences.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: isDev ? 'inline' : false,
    minify: !isDev,
    treeShaking: true,
    legalComments: 'inline',
    define: envDefine,
  });

  if (prefsResult.errors.length) {
    console.error('Preferences build failed:', prefsResult.errors);
    process.exit(1);
  }

  // 生成构建信息文件（构建产物，不进仓库）
  writeFileSync(
    resolve(ROOT, 'addon/content/build-info.json'),
    JSON.stringify(
      {
        version: pkg.version,
        buildTime: new Date().toISOString(),
        mode: isDev ? 'development' : 'production',
      },
      null,
      2
    )
  );

  const jsStats = statSync(resolve(ROOT, 'addon/content/plugin.js'));
  const panelJsStats = statSync(resolve(ROOT, 'addon/content/panel.js'));
  const prefsJsStats = statSync(resolve(ROOT, 'addon/content/preferences.js'));
  console.log(
    `✓ esbuild complete (${isDev ? 'dev' : 'production'}) — plugin.js (${formatSize(jsStats.size)}), panel.js (${formatSize(panelJsStats.size)}), preferences.js (${formatSize(prefsJsStats.size)})`
  );

  // ── Step 2: 打包 XPI ──
  // 版本号同步：把 package.json 的版本写入 manifest 的暂存副本再打包，
  // 保持源码树 addon/manifest.json 不被修改（git 树干净）。
  // 背景：曾出现 XPI 文件名/Release 是 0.3.0 但包内 manifest 仍写 0.1.0 的问题。
  const STAGE_DIR = resolve(DIST_DIR, '.stage');
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });
  execSync(`cp -r "${resolve(ROOT, 'addon')}/." "${STAGE_DIR}/"`, {
    stdio: 'pipe',
  });
  const stageManifestPath = resolve(STAGE_DIR, 'manifest.json');
  const stageManifest = JSON.parse(readFileSync(stageManifestPath, 'utf-8'));
  stageManifest.version = pkg.version;
  writeFileSync(stageManifestPath, JSON.stringify(stageManifest, null, 2) + '\n');

  mkdirSync(DIST_DIR, { recursive: true });
  const xpiPath = resolve(DIST_DIR, XPI_NAME);
  rmSync(xpiPath, { force: true });
  execSync(`cd "${STAGE_DIR}" && zip -qr "${xpiPath}" . -x "*.DS_Store"`, {
    stdio: 'pipe',
  });
  rmSync(STAGE_DIR, { recursive: true, force: true });
  const xpiStats = statSync(xpiPath);

  const elapsed = Date.now() - start;
  console.log(`✓ XPI packaged: dist/${XPI_NAME} (${formatSize(xpiStats.size)})`);
  console.log(`✓ Build done in ${elapsed}ms`);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

main().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
