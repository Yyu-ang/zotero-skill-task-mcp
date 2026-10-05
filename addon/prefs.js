// 默认偏好设置
// 插件安装/启用/Zotero 启动时自动读取

pref("extensions.zotero-skill-task.enabled", true);

// MCP 服务默认关闭（需求 §8 安全：安装后由用户在 Zotero 界面显式启用）
pref("extensions.zotero-skill-task.mcp.enabled", false);

// MCP 访问凭据默认启用；启用服务时自动生成 token。
pref("extensions.zotero-skill-task.mcp.tokenEnabled", true);

// 任务领取租约时长（分钟），默认 30；设置页可改，实时生效
pref("extensions.zotero-skill-task.task.leaseMinutes", 30);

// 文件交付物大小上限（MB），默认 50，硬上限 200；设置页可改，实时生效
pref("extensions.zotero-skill-task.deliverable.maxFileMB", 50);
