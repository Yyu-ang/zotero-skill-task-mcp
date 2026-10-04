/**
 * scripts/serve.mjs — 开发模式：源码代理安装 + 文件监听 + 热重载
 *
 * 对标 cookjohn/zotero-mcp 的 `npm run start`（zotero-plugin serve）：
 *   npm run dev   # 或 npm start
 *
 * 流程：
 *  1. dev 构建（node scripts/build.mjs --dev，产物写入 addon/content/*.js）
 *  2. 在开发 profile 的 extensions/ 下写代理文件 `<plugin-id>`（内容为 addon/ 绝对路径），
 *     Zotero 直接从源码加载插件，无需打包 XPI
 *  3. 启动 Zotero（-purgecaches -ZoteroDebugText -jsconsole）
 *  4. 监听 src/、addon/（xhtml/locale/静态资源）变化 → 自动重建 →
 *     touch <profile>/extensions/.skill-task-dev-reload 触发插件内热重载（AddonManager.reload()）
 *
 * 用法：
 *   node scripts/serve.mjs [--profile <dir>] [--zotero <bin>] [--no-launch]
 *
 * 环境变量：
 *   ZOTERO_BIN      Zotero 可执行文件路径（优先于自动探测）
 *   ZOTERO_PROFILE  开发 profile 目录（优先于 --profile）
 */

import { spawn, execSync } from 'child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  watch,
  utimesSync,
  openSync,
  closeSync,
} from 'fs';
import { resolve, dirname, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ADDON_DIR = resolve(ROOT, 'addon');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const manifest = JSON.parse(readFileSync(resolve(ADDON_DIR, 'manifest.json'), 'utf-8'));
const PLUGIN_ID = manifest.applications.zotero.id;

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// ── Zotero 可执行文件探测 ──
function detectZoteroBin() {
  if (process.env.ZOTERO_BIN && existsSync(process.env.ZOTERO_BIN)) {
    return process.env.ZOTERO_BIN;
  }
  const p = platform();
  const candidates =
    p === 'win32'
      ? [
          'C:\\Program Files\\Zotero\\zotero.exe',
          'C:\\Program Files (x86)\\Zotero\\zotero.exe',
        ]
      : p === 'darwin'
        ? ['/Applications/Zotero.app/Contents/MacOS/zotero']
        : [
            '/usr/bin/zotero',
            '/usr/local/bin/zotero',
            '/opt/zotero/zotero',
            join(process.env.HOME || '~', '.local/bin/zotero'),
          ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ── 开发 profile ──
function defaultProfileDir() {
  if (process.env.ZOTERO_PROFILE) return resolve(process.env.ZOTERO_PROFILE);
  // 默认放在仓库外，避免污染：~/.zotero-dev/<plugin-id>
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return join(home, '.zotero-dev', PLUGIN_ID);
}

const zoteroBin = argValue('--zotero') || detectZoteroBin();
const profileDir = resolve(argValue('--profile') || defaultProfileDir());
const noLaunch = args.includes('--no-launch');
const TRIGGER = join(profileDir, 'extensions', '.skill-task-dev-reload');

if (!zoteroBin) {
  console.error(
    '❌ 找不到 Zotero 可执行文件。请用 --zotero <路径> 指定，或设置环境变量 ZOTERO_BIN。'
  );
  process.exit(1);
}

function build() {
  console.log('🔨 Building (dev)…');
  execSync('node scripts/build.mjs --dev', { cwd: ROOT, stdio: 'inherit' });
}

function touchTrigger() {
  try {
    mkdirSync(dirname(TRIGGER), { recursive: true });
    if (!existsSync(TRIGGER)) {
      closeSync(openSync(TRIGGER, 'w'));
    }
    const now = new Date();
    utimesSync(TRIGGER, now, now);
  } catch (e) {
    console.warn('⚠️  trigger 文件写入失败:', String(e));
  }
}

function setupProfile() {
  mkdirSync(join(profileDir, 'extensions'), { recursive: true });
  // 代理文件：文件名 = 插件 ID，内容 = addon/ 源码绝对路径
  writeFileSync(join(profileDir, 'extensions', PLUGIN_ID), ADDON_DIR + '\n');
  // 清掉版本缓存标记，避免 Zotero 跳过重扫
  const prefsJs = join(profileDir, 'prefs.js');
  if (existsSync(prefsJs)) {
    const lines = readFileSync(prefsJs, 'utf-8').split('\n');
    const filtered = lines.filter(
      (l) => !l.includes('extensions.lastAppBuildId') && !l.includes('extensions.lastAppVersion')
    );
    if (filtered.length !== lines.length) {
      writeFileSync(prefsJs, filtered.join('\n'));
    }
  }
  console.log(`📁 Dev profile: ${profileDir}`);
  console.log(`🔗 Proxy: extensions/${PLUGIN_ID} → ${ADDON_DIR}`);
}

// ── 主流程 ──
build();
setupProfile();
touchTrigger(); // 首次创建 trigger 文件，插件启动后即启用热重载监听

let zoteroProc = null;
if (!noLaunch) {
  console.log(`🚀 Launching Zotero…`);
  zoteroProc = spawn(zoteroBin, ['-profile', profileDir, '-purgecaches', '-ZoteroDebugText', '-jsconsole'], {
    stdio: 'inherit',
    detached: false,
  });
  zoteroProc.on('exit', (code) => {
    console.log(`\n👋 Zotero 已退出 (code ${code})，serve 结束。`);
    process.exit(0);
  });
} else {
  console.log('⏭️  --no-launch：跳过启动 Zotero，仅监听重建。');
}

// ── 文件监听 ──
const WATCH_DIRS = ['src', 'addon'];
let rebuildTimer = null;
let building = false;

function scheduleRebuild(changedPath) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    if (building) {
      scheduleRebuild(changedPath);
      return;
    }
    building = true;
    try {
      console.log(`\n📝 检测到变化: ${changedPath}`);
      build();
      touchTrigger();
      console.log('♻️  已重建并触发热重载（插件约 1 秒内自动 reload，无需重启 Zotero）');
    } catch (e) {
      console.error('❌ 重建失败:', String(e));
    } finally {
      building = false;
    }
  }, 400); // 防抖
}

for (const dir of WATCH_DIRS) {
  const absDir = resolve(ROOT, dir);
  if (!existsSync(absDir)) continue;
  try {
    watch(absDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      // 构建产物本身不触发（避免自循环）：addon/content/*.js 是 esbuild 产物，跳过
      if (dir === 'addon' && String(filename).startsWith(`content${sep}`) && String(filename).endsWith('.js')) {
        return;
      }
      scheduleRebuild(join(dir, String(filename)));
    });
    console.log(`👀 Watching: ${absDir}`);
  } catch (e) {
    console.warn(`⚠️  监听 ${absDir} 失败:`, String(e));
  }
}

console.log('\n✅ dev 服务运行中。改代码保存后会自动重建 + 热重载。Ctrl+C 退出。\n');

process.on('SIGINT', () => {
  console.log('\n🛑 正在退出…');
  if (zoteroProc && !zoteroProc.killed) {
    zoteroProc.kill();
  }
  process.exit(0);
});
