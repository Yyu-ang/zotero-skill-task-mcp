/**
 * scripts/release.mjs — 发布脚本
 *
 * 1. 生产构建（含 XPI）
 * 2. 计算 SHA-256 哈希
 * 3. 生成 update.json（供 Zotero 插件自动更新）
 * 4. 可选：--publish 创建 GitHub Release
 *
 * 用法：
 *   node scripts/release.mjs            # 打包 XPI + 生成 update.json
 *   node scripts/release.mjs --publish  # 同时发布 GitHub Release
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const manifest = JSON.parse(
  readFileSync(resolve(ROOT, 'addon/manifest.json'), 'utf-8')
);

const VERSION = pkg.version;
const PLUGIN_ID = manifest.applications.zotero.id;
const XPI_NAME = `${pkg.name}-${VERSION}.xpi`;
const DIST_DIR = resolve(ROOT, 'dist');

async function main() {
  console.log(`\n🔨 发布 Skill Task v${VERSION}\n`);

  // 1. 生产构建
  console.log('📦 Step 1: Building...');
  execSync('node scripts/build.mjs', { cwd: ROOT, stdio: 'inherit' });

  const xpiPath = resolve(DIST_DIR, XPI_NAME);
  if (!existsSync(xpiPath)) {
    throw new Error(`XPI not found: ${xpiPath}`);
  }

  // 2. 计算 SHA-256 哈希
  console.log('🔐 Step 2: Computing hash...');
  const hash = execSync(`shasum -a 256 "${xpiPath}"`, {
    encoding: 'utf-8',
    cwd: ROOT,
  }).split(' ')[0];
  console.log(`   SHA-256: ${hash}`);

  // 3. 生成 update.json
  console.log('📝 Step 3: Generating update.json...');
  const updateJson = {
    addons: {
      [PLUGIN_ID]: {
        updates: [
          {
            version: VERSION,
            update_link: `https://github.com/Yyu-ang/zotero-skill-task-mcp/releases/download/v${VERSION}/${XPI_NAME}`,
            update_hash: `sha256:${hash}`,
            applications: {
              zotero: {
                strict_min_version:
                  manifest.applications.zotero.strict_min_version,
                strict_max_version:
                  manifest.applications.zotero.strict_max_version,
              },
            },
          },
        ],
      },
    },
  };
  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(
    resolve(DIST_DIR, 'update.json'),
    JSON.stringify(updateJson, null, 2)
  );
  // 仓库根目录的 update.json 供本地开发调试（构建产物，不进仓库）
  writeFileSync(
    resolve(ROOT, 'update.json'),
    JSON.stringify(updateJson, null, 2)
  );

  console.log(`\n✅ 发布完成！`);

  // 4. 可选：发布到 GitHub
  if (process.argv.includes('--publish')) {
    console.log('\n🚀 Step 4: Publishing to GitHub...');
    execSync(
      `gh release create v${VERSION} "${xpiPath}" "${resolve(DIST_DIR, 'update.json')}" --generate-notes`,
      { cwd: ROOT, stdio: 'inherit' }
    );
    console.log('✅ Published to GitHub!');
  }

  console.log(`\n📋 输出文件：`);
  console.log(`   ${xpiPath}`);
  console.log(`   ${resolve(DIST_DIR, 'update.json')}`);
  console.log(`   ${resolve(ROOT, 'update.json')} (dev 用)`);
  console.log(`\n📌 更新 URL：${updateJson.addons[PLUGIN_ID].updates[0].update_link}`);
}

main().catch((e) => {
  console.error('Release failed:', e);
  process.exit(1);
});
