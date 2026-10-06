// 默认偏好设置
// 插件安装/启用/Zotero 启动时自动读取

pref("extensions.zotero-skill-task.enabled", true);

// MCP 服务默认启用；用户可在设置或管理面板中显式关闭。
pref("extensions.zotero-skill-task.mcp.enabled", true);

// MCP 访问凭据默认关闭；用户需要鉴权时可显式启用。
pref("extensions.zotero-skill-task.mcp.tokenEnabled", false);

// 任务领取租约时长（分钟），默认 30；插件主面板可改，实时生效
pref("extensions.zotero-skill-task.task.leaseMinutes", 30);

// 文件交付物大小上限（MB），默认 200；插件主面板可改为更高值，实时生效
pref("extensions.zotero-skill-task.deliverable.maxFileMB", 200);
