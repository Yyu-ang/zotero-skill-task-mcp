# 网络访问与 OAuth

## 开关与地址

MCP 总开关控制整个服务。“允许远程访问”和“启用 OAuth 授权”默认均关闭。

| 允许远程访问 | OAuth | 23123 | 23124 |
|---|---|---|---|
| 关闭 | 关闭 | 仅本机回环，免鉴权 | 关闭 |
| 关闭 | 开启 | 仅本机回环，免鉴权 | 关闭 |
| 开启 | 关闭 | 本机／局域网，免鉴权 | 关闭 |
| 开启 | 开启 | 本机／局域网，免鉴权 | 外网 OAuth |

本机使用 `http://127.0.0.1:23123/skilltask/mcp`。局域网使用 `http://<LAN-IP>:23123/skilltask/mcp`，其中 `<LAN-IP>` 是运行 Zotero 的电脑的私网地址。

插件不占用、不修改 Zotero 的 `23119`，也不再监听旧的 `23121`。升级后，旧客户端需要将插件地址改为 `23123`；旧版静态访问令牌不再使用，也不会自动转换为开启远程访问的权限。

局域网模式只接受真实 TCP 来源属于回环、RFC1918 私网、IPv4 链路本地、IPv6 ULA／链路本地的请求。当前 Gecko socket 使用 IPv4 监听；地址分类同时兼容 IPv4-mapped IPv6。公网 IP 即使伪造 `X-Forwarded-For` 也不能进入免鉴权入口。LAN 客户端应使用 IP 地址及正确端口作为 Host，不携带浏览器 Origin。

## 配置外网

1. 为外网入口准备 HTTPS 域名或 HTTPS 隧道，例如 `https://mcp.example.com`。
2. 在插件 MCP 服务页填写“外网公开地址”。只填写 HTTPS origin，可带 HTTPS 端口，不含路径、账号、查询参数或片段。
3. 将该域名转发至 `http://127.0.0.1:23124`，保留完整路径、查询参数及 Authorization 请求头。Host 使用公开域名或 `127.0.0.1:23124`。
4. 同时开启“允许远程访问”和“启用 OAuth 授权”。客户端连接 `https://mcp.example.com/skilltask/mcp`。
5. 客户端发起授权时，在运行 Zotero 的电脑上核对客户端自报名称、规范化回调域名及权限，点击允许。取消或超时不会发放授权码。

`23124` 是 HTTPS 代理后的 HTTP 接收端，不自行签发 TLS 证书。外网客户端始终使用 HTTPS 公开地址。不要将免鉴权的 `23123` 配置为公网代理目标；代理会改变 TCP 来源，无法靠原客户端地址判断其信任范围。

OAuth 入口对所有 TCP 来源使用相同鉴权，包括回环、本机代理和局域网。服务不会根据 Host、Origin 或任何转发头把外网请求降级为免鉴权请求。

## 授权接口

以下路径仅由 `23124` 提供：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/.well-known/oauth-protected-resource/skilltask/mcp` | GET | MCP 保护资源信息；另支持不带资源路径的发现入口 |
| `/.well-known/oauth-authorization-server` | GET | 授权服务器信息 |
| `/oauth/register` | POST JSON | 注册 public client，`token_endpoint_auth_method=none` |
| `/oauth/authorize` | GET | 授权码与 S256 PKCE，本机批准 |
| `/oauth/token` | POST form | 兑换授权码或轮换刷新令牌 |
| `/oauth/revoke` | POST form | 撤销令牌所属授权系列 |
| `/skilltask/mcp` | POST JSON | 已授权的 MCP 调用 |

客户端需要支持授权码流程与 S256 PKCE。`scope` 为 `skilltask`；authorize 与 token 请求必须带 `resource=https://mcp.example.com/skilltask/mcp`。回调必须与注册的 URI 精确匹配，支持 HTTPS 回调以及本机 HTTP 回调。不支持 implicit、password、client-credentials grant 或静态 Bearer 令牌替代 OAuth。

该权限允许读取技能组材料、创建或修改技能组、领取和管理任务、写入笔记或文件交付物。本机批准框展示这些权限，不宣称只读。

授权码五分钟有效且仅能使用一次；访问令牌一小时有效；刷新令牌轮换且所属授权系列最多三十天。重放刷新令牌会撤销该系列全部访问。所有授权状态仅保存在内存，令牌仅保存摘要。

“撤销全部 OAuth 授权”、模式／公开地址变更、停用服务和 Zotero 重启均使原授权失效，客户端需要重新注册和授权。不会撤回已经完成的文献操作。

## 启动失败与验证

端口被占用时不会改用第三个端口。外网启动失败时关闭远程入口并尝试恢复本机 `23123`；本机端口同样被占用则显示服务未监听及具体错误。公开地址不合法或安全随机数不可用时，OAuth 不启动。

自动检查：

```sh
npm run typecheck
npm test
npm run build
```

发布前应在 Zotero 桌面验证四种开关组合、局域网客户端、HTTPS 代理、批准／拒绝、本机和公网端口占用以及插件停用。应观察：默认只有本机 `23123`；仅远程开关开启时只开放局域网 `23123`；两个开关开启时 `23124` 的未授权 MCP 请求返回 401 和资源发现信息；关闭远程后 `23124` 停止并恢复本机访问。原有 Zotero Connector 应始终正常工作。

## 设计来源

两开关结构参考 [zotero-mcp-plus 的 OAuth 分支](https://github.com/cloneorcopy/zotero-mcp-plus/tree/dd6d06b82d205f180439f2c81d162f4bafb79307)。本仓库使用独立的 23123／23124 端口与本机批准流程，未移植参考项目的远程密码授权。

协议依据：[MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)、[RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)、[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)。
