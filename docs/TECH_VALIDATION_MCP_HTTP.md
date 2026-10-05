# Zotero 插件进程内运行 HTTP/MCP 服务 — 技术验证（Track B）

- 验证对象：需求计划书 §10 第 2 项（最高优先级）
- 验证日期：2026-10-03
- 验证方式：公开资料调研（Zotero 官方 dev 文档、Firefox/Mozilla 源码、真实插件源码与实测记录）。**未做真机运行测试**（VM 无 GUI），凡需运行时确认的断言已在"遗留不确定点"中标明。

---

## 1. 结论（一句话）

**可行。** Zotero 插件进程（Firefox chrome 特权环境）内可以稳定运行只监听 `127.0.0.1` 的 HTTP 服务：Zotero 自身就是这么做的（`chrome/content/zotero/xpcom/server/server.js` 用 Firefox 的 `HttpServer` 模块监听 `127.0.0.1:23119`），且已有第三方插件（zotero-js-bridge，实测于 Zotero 10.0.2）在插件层面复用了同一机制；底层 `nsIServerSocket` 的 `init(port, loopbackOnly=true)` 在当前 mozilla-central 源码中仍是 scriptable，可供 JS 直接调用。

---

## 2. 可行方案与原型代码

### 2.0 背景事实（已查证）

- Zotero 桌面端自带一个进程内 HTTP 服务器（Connector Server），实现位于 `chrome/content/zotero/xpcom/server/server.js`，master 分支当前代码：
  ```js
  var { HttpServer } = ChromeUtils.importESModule("chrome://remote/content/server/httpd.sys.mjs");
  // ...
  serv = new HttpServer();
  serv.registerPrefixHandler('/', this.handleRequest);
  serv.start(port);
  Zotero.debug(`HTTP server listening on 127.0.0.1:${serv.identity.primaryPort}`);
  ```
  它只监听 loopback，并在 `Zotero.addShutdownListener` 中注册关闭回调。这是"插件进程内跑 HTTP 服务"在 Zotero 9/10（Firefox 140+ runtime）下成立的最直接证据。
- `HttpServer` 的 `start(port)` 只绑 loopback（Zotero 日志与第三方文档均确认 `127.0.0.1`），提供 `identity.primaryPort`（实际绑定端口）、`stop()`、`registerPrefixHandler` / `registerPathHandler`。
- 底层 `nsIServerSocket`（`@mozilla.org/network/server-socket;1`）：mozilla-central 当前 `netwerk/base/nsIServerSocket.idl` 中接口标记为 `[scriptable]`，`init(port, loopbackOnly, backlog)`、`close()`、`asyncListen(listener)` 均可从 JS 调用（只有 `initWithAddress` / `getAddress` 是 `noscript`）。`aLoopbackOnly=true` 即只响应 loopback 接口。2026-08 的开源项目 minecraft-server-in-firefox 在**当前 Firefox** 的 Browser Toolbox（chrome 特权 JS）中用 `init(25565, false, -1)` + `asyncListen` 成功跑起了一个 TCP 服务器，确认该能力在 Firefox 140+ 时代依然可用。
- 插件生命周期：bootstrap 扩展提供 `install / startup / shutdown / uninstall` + `onMainWindowLoad/Unload`。在 `shutdown()` 中释放资源是标准做法（各插件模板/SKILL 均一致）。

### 2.1 方案 A（推荐，证据最强）：复用 Zotero 自带服务器，注册插件端点

Zotero 官方文档（connector_http_server）把 `Zotero.Server.Endpoints` 作为插件扩展点：

```js
Zotero.Server.Endpoints["/myAddon/helloWorld"] = Ctor;
Ctor.prototype = {
  supportedMethods: ["GET", "POST"],
  init: async function (requestData) { return [200, "application/json", body]; }
};
```

已有**真实插件先例**：`sum-su/zotero-js-bridge`（2026-09 发布，文档声明在 Zotero 10.0.2 + 25 个插件的真实 profile 上实测）在 Zotero 自带服务器上注册了 9 个 JSON 端点（`/zoterojs/exec` 等），不新开端口、不持有 socket，Zotero 照常干净退出。它的安全设计可直接借鉴：`X-ZoteroJS-Token` 请求头鉴权、token 存 pref 并镜像到 data-dir 下的 `0600` 文件、常量时间比较、master 开关。

**原型代码（TypeScript 风格，编译为 bootstrap  bundle 的一部分）：**

```ts
// mcpServer.ts — 在 hooks.onStartup() 中调用 register()，在 onShutdown() 中调用 unregister()

const MCP_PATH = "/skilltask/mcp";       // MCP Streamable HTTP 端点
const PREF_ENABLED = "extensions.zotero.skilltask.mcp.enabled";  // 默认 false
const PREF_TOKEN = "extensions.zotero.skilltask.mcp.token";

function McpEndpoint() {}
McpEndpoint.prototype = {
  supportedMethods: ["POST", "GET"],
  supportedDataTypes: ["application/json"],
  permitBookmarklet: false,

  // 注意：Zotero 9 起 init 必须是 async；同步 init 返回数组会导致请求永远挂起（见 §3 坑 #2）
  init: async function (requestData: any) {
    // —— 默认关闭：在 handler 层强制 ——
    if (!Zotero.Prefs.get(PREF_ENABLED, true)) {
      return [503, "application/json", JSON.stringify({ error: "MCP interface disabled" })];
    }
    // —— 鉴权在 HTTP handler 层 ——
    const expected = Zotero.Prefs.get(PREF_TOKEN, true) as string;
    const got = String(requestData.headers?.["authorization"] || "")
      .replace(/^Bearer\s+/i, "");
    if (!expected || !timingSafeEqual(got, expected)) {
      return [401, "application/json", JSON.stringify({ error: "unauthorized" })];
    }
    // —— 业务：MCP Streamable HTTP = POST JSON-RPC ——
    try {
      const rpc = JSON.parse(requestData.data || "{}");
      const result = await dispatchMcp(rpc);   // 任务领取 / 结果提交 / 租约逻辑
      return [200, "application/json", JSON.stringify(result)];
    } catch (e) {
      return [400, "application/json", JSON.stringify({ error: String(e) })];
    }
  },
};

export function registerMcpEndpoint() {
  (Zotero.Server.Endpoints as any)[MCP_PATH] = McpEndpoint;
}

export function unregisterMcpEndpoint() {
  delete (Zotero.Server.Endpoints as any)[MCP_PATH];
}
```

bootstrap 侧：

```ts
// hooks.ts
async function onStartup() {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
  // Zotero.Server 在 Zotero 启动流程中已初始化；若不确定，加守卫轮询/等待
  if (Zotero.Server?.Endpoints) registerMcpEndpoint();
  registerPreferencePane(); // 放"启用 MCP 接口"开关 + token 复制/重新生成按钮
}
function onShutdown() {
  unregisterMcpEndpoint();  // 删端点，不持有 socket，无需额外清理
}
```

**方案 A 的"默认关闭"语义说明**：23119 监听器本身随 Zotero 常驻，但 MCP 端点在未启用时返回 503、未鉴权时返回 401。这与 zotero-js-bridge 的"master switch 在请求路径上强制"做法一致。如果需求坚持"监听器本身默认不监听"，用方案 B。

### 2.2 方案 B（备选，监听器级默认关闭）：插件自建 HttpServer 实例

与 Zotero 核心 import 同一个模块，开独立端口（如 `127.0.0.1:23120`），用户在偏好设置中启用时才 `start()`，关闭/插件停用时 `stop()`。

```ts
// mcpHttpServer.ts
const { HttpServer } = ChromeUtils.importESModule(
  "chrome://remote/content/server/httpd.sys.mjs"   // 与 Zotero 核心 server.js 相同的模块
);

let server: any = null;

export async function startMcpHttpServer(port = 23120) {
  if (server) return server.identity.primaryPort;
  server = new HttpServer();
  server.registerPrefixHandler("/mcp", handleMcpRequest);
  server.start(port);  // 只绑 loopback；端口被占时会自动顺延（见 §3 坑 #4）
  const actual = server.identity.primaryPort;
  Zotero.debug(`[skilltask] MCP HTTP listening on 127.0.0.1:${actual}`);
  return actual;  // 把实际端口展示在界面上，不要写回 pref
}

export function stopMcpHttpServer() {
  if (!server) return;
  server.stop(() => {});
  server = null;
}

function handleMcpRequest(request: any, response: any) {
  // Host 头校验（防 DNS rebinding，抄 Zotero server.js 的做法）：
  const host = request.getHeader("Host");
  if (!/^(?:127\.0\.0\.1|\[::1\]|localhost)(?::[0-9]+)?$/i.test(host || "")) {
    response.setStatusLine(request.httpVersion, 403, "Forbidden");
    return;
  }
  // enabled + Bearer 鉴权（同方案 A），然后处理 JSON-RPC ...
}
```

生命周期绑定：

```ts
// hooks.ts
async function onStartup() {
  // ...
  if (Zotero.Prefs.get(PREF_ENABLED, true)) {
    await startMcpHttpServer();
  }
  // 兜底：Zotero 退出时一定关闭（Zotero 核心 server.js 就是这么做的）
  Zotero.addShutdownListener(stopMcpHttpServer);
}
function onShutdown() {
  stopMcpHttpServer();
}
```

**方案 B 的证据状态**：`HttpServer` 模块在 Zotero 9/10 runtime 内可用是确定的（Zotero 核心在用）；**但未找到任何插件自建第二个 HttpServer 实例的公开先例**，标记为"原理可行、待真机验证"（见 §5 不确定点）。

### 2.3 不推荐：手写 nsIServerSocket + HTTP 解析

技术上可行（接口 scriptable，`asyncListen` 回调不阻塞主线程，minecraft 项目已演示），但等于重造一个有 bug 的 httpd：要自己处理分包、Content-Length/chunked、keep-alive、并发连接。没有理由不用现成的 `HttpServer` 模块。仅当未来 `httpd.sys.mjs` 被移除时才考虑。

### 2.5 当前 MCP 协议实现（2026-10-05 更新）

当前插件仍复用方案 A 的 Zotero Connector Server，但 MCP 协议层已经改为**双栈无状态**：

- **Modern：2026-07-28**
  - 客户端先调用 `server/discover`；
  - 每个 request 的 `params._meta` 必须包含 `io.modelcontextprotocol/protocolVersion = "2026-07-28"` 与 `io.modelcontextprotocol/clientCapabilities`；
  - HTTP request 必须携带匹配的 `MCP-Protocol-Version` 与 `Mcp-Method`；`tools/call` 还需 `Mcp-Name` 与 `params.name` 一致；
  - `server/discover` 返回 `supportedVersions=["2026-07-28"]`、capabilities 与私有零 TTL 缓存提示；
  - 现代 response 带 `resultType: "complete"`，并在 `_meta["io.modelcontextprotocol/serverInfo"]` 暴露服务端身份；
  - `tools/list` 返回 `ttlMs/cacheScope`；
  - 三个业务工具都声明 `outputSchema`，`tools/call` 同时返回文本 `content` 与 `structuredContent`。
- **Legacy：2025-11-25**
  - 保留 `initialize`、`ping`、`tools/list`、`tools/call`；
  - 不要求 2026 envelope/header；
  - 响应保持原有 legacy 形态，避免现有客户端因升级失效。

协议选择采用 body/header 判别：只有 2026 协议声明进入 modern 校验；2025-era 请求保持 legacy 路径。modern 请求的 header/body 协议声明不一致返回 HTTP 400 + `-32020 HeaderMismatch`；声明不支持的 2026 revision 返回 HTTP 400 + `-32022 UnsupportedProtocolVersion`。

> 本实现是针对 Zotero `Server.Endpoints` 的轻量双协议适配，没有引入官方 TypeScript SDK runtime；协议契约依据 2026-07-28 官方 SDK/规范实现。仍应在真实目标 MCP 客户端上做端到端互操作测试。

### 2.4 安全边界放在哪一层

| 层 | 做法 | 依据 |
|---|---|---|
| 传输绑定 | 只绑 loopback：方案 A 天然（Zotero server 只绑 `127.0.0.1`）；方案 B `server.start()` 同样只绑 loopback；裸 `nsIServerSocket` 用 `init(port, true, backlog)` | Zotero server.js 日志 `HTTP server listening on 127.0.0.1:`；nsIServerSocket.idl `aLoopbackOnly` |
| 客户端鉴别 | HTTP handler 层校验 `Authorization: Bearer <token>`（MCP 官方 Streamable HTTP 也是 Bearer 方案，RFC 9728）；常量时间比较 | zotero-js-bridge 的 `X-ZoteroJS-Token` 设计 |
| 默认关闭 | pref 默认 false；handler 层未启用返回 503（方案 A）或根本不 start 监听器（方案 B） | 需求要求 |
| DNS rebinding | 校验 Host 头只允许 `127.0.0.1/localhost/[::1]` | Zotero server.js 内置的 Host 头正则 |
| 浏览器 CSRF | 依赖 Zotero 自带的 CSRF guard（方案 A 自动继承）：UA 以 `Mozilla/` 开头或带 `Origin` 头的请求在到达插件端点前被丢弃 | zotero-js-bridge 文档实测记录 |

注意：loopback 上的任何本地进程都能连上端口，**token 是真正的边界**，"只绑 127.0.0.1"只是缩小暴露面。威胁模型为单用户桌面机时可接受（与 zotero-js-bridge 的结论一致）。

---

## 3. 注意事项 / 风险清单

1. **未真机验证。** 所有原型代码基于文档与源码推导，未在真实 Zotero 10 上跑过。`init` 签名、header 大小写处理（Zotero 用了大小写不敏感的 Headers 代理）等细节需在真机上联调。
2. **`init` 必须是 async（Zotero 9+ 实测坑）。** 社区 Zotero 9 插件开发记录：同步 `init` 返回数组会导致请求永远挂起无响应。原型代码已按 async 写。
3. **MCP 客户端的请求头要求（方案 A）：** 不要发 `Origin` 头，`User-Agent` 不要以 `Mozilla/` 开头，否则被 Zotero 的 CSRF guard 在插件端点之前丢弃。这是 zotero-js-bridge 文档中实测确认的行为。
4. **端口占用自动顺延（坑，来自 zotero/zotero#5999）：** `HttpServer.start(port)` 在端口被占时**静默顺延到下一个空闲端口**，历史上还曾把顺延后的端口写回 `prefs.js` 造成两端不一致。做法：启动后读回 `server.identity.primaryPort`，把**实际端口展示在插件界面/日志里**，不要写回用户配置的 pref；若顺延发生，给用户明确提示。
5. **多窗口/多实例：** Zotero 是单进程应用，bootstrap `startup` 在进程内只执行一次，不存在"每个窗口起一个监听器"的问题。Zotero 的多 profile/多实例场景下第二个实例本来也起不来（profile 锁），无需特殊处理。
6. **插件禁用/卸载时的干净关闭：** 方案 A 只需 `delete Zotero.Server.Endpoints[path]`（不持有 socket）；方案 B 必须调 `server.stop()`。两者都在 bootstrap `shutdown()` 里做，并用 `Zotero.addShutdownListener` 做退出兜底。注意模板常见写法在 `reason === APP_SHUTDOWN` 时直接 return——socket 清理不要放在会被跳过的分支里，或依赖 addShutdownListener 兜底。
7. **主线程：** `nsIServerSocket.asyncListen` 是异步回调机制，不会挂起主线程（minecraft 项目明确验证了"reads use asyncWait so nothing blocks the browser's main thread"）。MCP handler 里避免做同步重 IO（如大文件读写），用 `IOUtils` 异步 API。
8. **Token 存储：** 建议 pref + data-dir 下 `0600` 文件双存（zotero-js-bridge 做法），支持一键重新生成（旧 token 立即失效）。任何能读用户 profile 的本地进程理论上都能拿到 token——单用户桌面威胁模型下可接受，文档中如实告知用户。
9. **Zotero.Server.Endpoints 是事实标准而非冻结 API：** 官方 dev 文档记载了该插件扩展点，多款插件在用，但 Zotero 官方不承诺跨大版本稳定。升级 Zotero 大版本时需回归验证端点注册机制。
10. **MCP 传输选型：** 建议只实现 Streamable HTTP 的"POST JSON-RPC → 单 JSON 响应"模式（MCP 规范允许），不要一上来就做 SSE 流。Zotero 的 httpd 支持 `response.seizePower()` 做自定义流式响应，真有需要时再加。

---

## 4. Fallback：插件管理的本机伴随服务（当前不需要，仅作预案）

**结论为可行，本节仅为预案**，触发条件：未来 Firefox/Gecko 移除 `nsIServerSocket` 或 `httpd.sys.mjs`，或 Zotero 收紧插件的 chrome 特权。设计要点（概要）：

- **形态**：插件 XPI 内附一个单文件可执行伴随服务（Node 单文件 bundle 或 Go/Rust 单二进制，三平台各一份，约数 MB），不常驻、由插件按需拉起。
- **拉起/管理**：插件用 `nsIProcess`（或 `Subprocess.jsm`/`ChromeUtils` 的 subprocess 能力）启动本机二进制；插件 `startup` 时若 MCP 已启用则拉起，`shutdown` + `Zotero.addShutdownListener` 时终止子进程；用心跳/自检处理异常退出后重启。
- **端口与凭据协商**：伴随服务启动参数带 `--port 0`（OS 自动分配空闲端口，根治端口占用问题）+ `--token <随机>`（插件每次启动时生成，通过命令行/环境变量一次性传递，不落盘或仅 0600 落盘）；服务启动后把实际端口写回 stdout/回环 HTTP 自检端点，插件读到后展示在界面上。
- **发现机制**：端口动态分配 → 插件把"实际端口 + token 有效期"写在 profile 下的 `0600` 状态文件（或内存 + 界面展示），外部 AI 客户端从该文件读取；不做 mDNS/广播（loopback 场景不需要）。
- **卸载清理**：`uninstall` hook 中终止进程并删除二进制与状态文件；同时提供"伴随服务残留自检"（启动时若发现旧进程占用标记则 kill）。
- **代价**：三平台打包体积、杀毒软件误报、进程生命周期管理复杂度都显著高于进程内方案。只有在进程内方案被平台能力堵死时才走这条路。

---

## 5. 遗留不确定点（需真机验证）

1. 方案 B（插件自建第二个 `HttpServer` 实例）无公开插件先例，`chrome://remote/content/server/httpd.sys.mjs` 从插件代码 `importESModule` 是否畅通、双实例共存有无干扰，需在 Zotero 10 真机上验证。
2. `Zotero.Server` 在插件 `startup` 时机是否已初始化完成：Zotero 核心在启动流程中 `init` 它，但插件 `startup` 与其的时序关系未查到文档说明，需真机确认（或加守卫等待 `Zotero.initializationPromise` + 轮询）。
3. Zotero 9 的 async-`init` 要求是社区记录（fullvahti 的 SKILL），未在官方文档中找到对应说明；Zotero 10 是否延续同样行为需真机确认。
4. `HttpServer.start()` 端口顺延行为来自 issue #5999（Zotero 7 时代报告），在当前版本是否依然如此、以及是否还会写回 `prefs.js`，未再确认。
5. `nsIServerSocket` 在 Zotero 10 所用的 Gecko 分支中确切可用性：mozilla-central 当前源码确认 scriptable，且同代 Firefox 实测可用，但未在 Zotero 10 二进制上直接验证。

---

## 6. 参考来源

- Zotero 核心 server.js（master）：https://github.com/zotero/zotero/blob/master/chrome/content/zotero/xpcom/server/server.js
- Zotero 官方文档「Connector HTTP Server」（含插件端点注册 API）：https://www.zotero.org/support/dev/client_coding/connector_http_server
- zotero-js-bridge（Zotero 10.0.2 实测、复用 Zotero 自带服务器的插件）：https://github.com/sum-su/zotero-js-bridge
- zotero-js-bridge 端点文档（含 CSRF guard、token 鉴权实测记录）：https://github.com/sum-su/zotero-js-bridge/blob/HEAD/docs/endpoints.md
- minecraft-server-in-firefox（2026-08，当前 Firefox 中 `nsIServerSocket` + `asyncListen` 实测可用）：https://github.com/hostdit/minecraft-server-in-firefox
- `nsIServerSocket.idl`（mozilla-central 当前源码，`[scriptable]`，`init` 可脚本调用）：https://searchfox.org/mozilla-central/source/netwerk/base/nsIServerSocket.idl
- Firefox 官方 httpd 使用文档：https://firefox-source-docs.mozilla.org/networking/http_server_for_testing.html
- zotero/zotero#5999（`HttpServer.start` 端口占用自动顺延问题）：https://github.com/zotero/zotero/issues/5999
- 第三方整理的 Zotero HTTP Server API 文档（含三种端点签名）：https://github.com/evelasko/zotero-citation-linker/blob/HEAD/docs/ZOTERO_HTTP_SERVER_API.md
- Zotero 8 插件开发指南（ESM 迁移、bootstrap 生命周期）：https://gist.github.com/EwoutH/04c8df5a97963b5b46cec9f392ceb103
- fullvahti 的 Zotero 9 插件开发记录（Zotero 9 `init` 必须 async 的坑）：https://github.com/heidihelena/fullvahti/blob/HEAD/.claude/skills/zotero-9-plugin-dev/SKILL.md
- bootstrap 生命周期标准写法：https://github.com/cboulanger/zotero-skills/blob/HEAD/skills/zotero-plugin-dev/SKILL.md
