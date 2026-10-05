# Zotero Skill Task MCP（插件）

Zotero 桌面端插件：用户在 Zotero 内维护“技能组”（AI 任务模板：技能说明、任务指令、SKILL.md、可选 references/、范围、输入材料、交付物定义），
每个技能拥有独立目录 `skilltask/skills/<技能ID>/`；插件按范围扫描文献生成可持久化任务；外部 AI 通过 MCP HTTP 接口可注入技能组/技能文件、被动单条领取任务（租约防并发），
并提交交付物，由插件校验后写回 Zotero 条目笔记/文件并更新任务状态。

插件不内置 AI、不推送任务。需求基线见 [`需求计划书.md`](./需求计划书.md)。

> MCP 默认启用，访问凭据默认关闭；默认单文件交付上限为 200MB，可由用户自行调高。

## 版本要求

- Zotero **9.0** 及以上（`strict_min_version: "9.0"`，`strict_max_version: "10.*"`）
- 构建需要 Node.js 18+

## 构建

```bash
npm install      # 安装构建依赖（仅 devDependencies）
npm run typecheck  # TypeScript 类型检查
npm run build      # 构建 → dist/zotero-skill-task-mcp-<版本>.xpi
npm run release    # 构建 + 生成 update.json（供插件自动更新）
```

## 开发调试（对标 cookjohn/zotero-mcp 的 `npm run start`）

```bash
# 开发模式：源码代理安装 + 文件监听 + 热重载
npm run dev   # 或 npm start
```

流程：
1. dev 构建（产物写入 `addon/content/*.js`，含 sourcemap）
2. 在开发 profile（默认 `~/.zotero-dev/<plugin-id>`）的 `extensions/` 下写代理文件，
   Zotero 直接从 `addon/` 源码加载插件，无需打包 XPI
3. 启动 Zotero（带 `-purgecaches -ZoteroDebugText -jsconsole`，报错直接可见）
4. 监听 `src/`、`addon/` 变化 → 自动重建 → 插件约 1 秒内热重载（`AddonManager.reload()`），无需重启 Zotero

首次运行需在 Zotero 的「工具 → 插件」里手动启用一次（侧载默认禁用），之后保持启用。

可选参数：
```bash
node scripts/serve.mjs --profile <dir>   # 指定开发 profile 目录
node scripts/serve.mjs --zotero <bin>    # 指定 Zotero 可执行文件路径
node scripts/serve.mjs --no-launch      # 只监听重建，不启动 Zotero
# 环境变量 ZOTERO_BIN / ZOTERO_PROFILE 同样有效
```

调试日志：在 Zotero 里「帮助 → Debug Output Logging → View Output」，搜 `[SkillTask]`。

## 安装

1. `npm run build` 得到 `dist/*.xpi`
2. Zotero → 工具 → 插件，把 `.xpi` 拖进插件管理器对话框
3. 重启 Zotero，"工具"菜单出现"技能任务…"入口

## 工程结构

```
addon/
  manifest.json        插件清单（addonID: zotero-skill-task@example.com）
  bootstrap.js         Zotero 生命周期入口（仅转发事件，无业务逻辑）
  prefs.js             默认偏好
  locale/en-US|zh-CN  Fluent 本地化（菜单标签等）
  content/panel.html   技能组/任务/MCP 管理面板
src/
  index.ts  打包入口（暴露 PluginHook）
  core.ts   生命周期 + 窗口管理
  ui.ts     工具菜单注册（Zotero 8+ MenuManager）+ 面板打开
  prefs.ts  偏好封装
  utils.ts  日志
scripts/
  build.mjs    esbuild 打包 → XPI
  release.mjs  发布：哈希 + update.json（可选 --publish 发 GitHub Release）
```

## 脚手架说明

基于 `tsingke/zotero-plugin-dev-template`（支持 Zotero 7–10 的现代模板）裁剪：
已验证其 manifest 声明覆盖 9/10、构建链仅 esbuild+TypeScript+zotero-types、
示例代码只用官方 API（`Zotero.MenuManager`、原生 Promise、Fluent），
无 `windingwind/zotero-plugin-template` 的旧 toolkit/Cu.import/Bluebird 包袱。
本仓库只保留最小可运行部分：工具菜单入口 + 占位面板；模板的示例列/通知观察者等已删去。
