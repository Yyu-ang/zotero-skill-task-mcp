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
    // zotero-types 仅提供类型定义，不参与运行时打包
    external: [],
  });

  if (panelResult.errors.length) {
    console.error('Panel build failed:', panelResult.errors);
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
  console.log(
    `✓ esbuild complete (${isDev ? 'dev' : 'production'}) — plugin.js (${formatSize(jsStats.size)}), panel.js (${formatSize(panelJsStats.size)})`
  );

  // ── Step 2: 打包 XPI ──
  mkdirSync(DIST_DIR, { recursive: true });
  const xpiPath = resolve(DIST_DIR, XPI_NAME);
  rmSync(xpiPath, { force: true });
  execSync(
    `cd "${resolve(ROOT, 'addon')}" && zip -qr "${xpiPath}" . -x "*.DS_Store"`,
    { stdio: 'pipe' }
  );
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
