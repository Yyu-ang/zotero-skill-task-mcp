/**
 * UI wiring regression checks.
 *
 * These are intentionally static: they catch the exact integration regressions that
 * previously produced blank panel/preference UIs before a Zotero runtime is available.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

const bootstrap = read('addon/bootstrap.js');
const panel = read('addon/content/panel.html');
const uiTs = read('src/ui.ts');
const coreTs = read('src/core.ts');
const mcpTs = read('src/mcpServer.ts');
const addonPrefs = read('addon/prefs.js');
const utilsTs = read('src/utils.ts');
const menuIconSvg = read('addon/content/icons/icon.svg');
const panelTs = read('src/panel.ts');
const skillStoreTs = read('src/skillGroupStore.ts');
const taskGeneratorTs = read('src/taskGenerator.ts');
const taskStoreTs = read('src/taskStore.ts');
const attachmentsTs = read('src/attachments.ts');

const includeSrc = 'chrome://zotero/content/include.js';
const panelScript = 'src="panel.js"';

assert.ok(
  panel.includes(includeSrc),
  'panel.html must import Zotero core with chrome://zotero/content/include.js'
);
assert.ok(
  panel.indexOf(includeSrc) < panel.indexOf(panelScript),
  'Zotero include.js must load before panel.js'
);
assert.ok(
  panel.startsWith('<!DOCTYPE html>') && !panel.includes('xmlns="http://www.w3.org/1999/xhtml"'),
  'standalone panel must use HTML parsing, not XHTML/XML parsing'
);
assert.ok(
  panel.includes('windowtype="zotero-skill-task-panel"'),
  'standalone panel must expose a windowtype for focus/reuse'
);
assert.ok(
  uiTs.includes("'chrome://zotero-skill-task/content/panel.html'"),
  'UI launcher must open the panel through the registered chrome URL'
);
assert.ok(
  uiTs.includes('win.open(') && !uiTs.includes("content/panel.xhtml"),
  'UI launcher must use window.open for the standalone HTML panel'
);
assert.ok(
  panel.includes('id="boot-status"'),
  'panel shell must expose visible boot diagnostics instead of failing to a blank window'
);
assert.ok(
  bootstrap.includes('aomStartup.registerChrome') &&
    bootstrap.includes('["content", "zotero-skill-task"'),
  'bootstrap must register a stable chrome:// content package'
);
assert.ok(
  panel.includes('id="tabbtn-settings"') &&
    panel.includes('id="tab-settings"') &&
    panelTs.includes("type TabId = 'skills' | 'tasks' | 'mcp' | 'settings'") &&
    panelTs.includes('function renderSettings()') &&
    panelTs.includes('PREFS.TASK_LEASE_MINUTES') &&
    panelTs.includes('PREFS.DELIVERABLE_MAX_FILE_MB') &&
    panelTs.includes('PREFS.SHORTCUT_ENABLED'),
  'task defaults and shortcut settings must live in the main plugin panel'
);
assert.ok(
  !coreTs.includes('PreferencePanes') &&
    !coreTs.includes('preferences.xhtml') &&
    !coreTs.includes('preferences.js'),
  'standalone Zotero Preference Pane must not be registered after settings are merged'
);
assert.ok(
  panelTs.includes('mcp.setTokenEnabled(tokenToggle.checked)') &&
    panelTs.includes("panel-mcp-token-switch"),
  'MCP access-token setting must be available in the MCP module'
);

assert.ok(
  mcpTs.includes('Z?.Server?.port') &&
    mcpTs.includes("Z?.Prefs?.get?.('httpServer.port')") &&
    !mcpTs.includes("Prefs?.get?.('httpServer.port', true)"),
  'MCP status must report the actual Zotero server port with a correct pref fallback'
);

assert.ok(
  mcpTs.includes("'2025-11-25'") &&
    mcpTs.includes("'2025-06-18'") &&
    mcpTs.includes("'2025-03-26'") &&
    mcpTs.includes("'2024-11-05'") &&
    mcpTs.includes("const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28'") &&
    mcpTs.includes("case 'server/discover':") &&
    mcpTs.includes("supportedVersions: [MCP_MODERN_PROTOCOL_VERSION]"),
  'MCP endpoint must dual-serve legacy revisions and modern 2026-07-28'
);
assert.ok(
  mcpTs.includes('function negotiateLegacyProtocolVersion(') &&
    mcpTs.includes('protocolVersions') &&
    mcpTs.includes('supportedProtocolVersions') &&
    mcpTs.includes('protocolVersion: negotiatedVersion'),
  'legacy initialize must negotiate the client-offered supported revision instead of forcing 2025-11-25'
);
assert.ok(
  mcpTs.includes("getHeader(requestData?.headers, 'MCP-Protocol-Version')") &&
    mcpTs.includes("getHeader(headers, 'Mcp-Method')") &&
    mcpTs.includes("getHeader(headers, 'Mcp-Name')") &&
    mcpTs.includes('validateModernRequest(') &&
    mcpTs.includes('HEADER_MISMATCH'),
  'MCP 2026 requests must validate the standard stateless HTTP headers and envelope'
);
assert.ok(
  mcpTs.includes("ttlMs: 0") &&
    mcpTs.includes("cacheScope: 'private'") &&
    mcpTs.includes("resultType: 'complete'") &&
    mcpTs.includes('structuredContent: result') &&
    (mcpTs.match(/outputSchema:/g)?.length ?? 0) >= 3,
  'MCP 2026 responses must include cache hints, complete result type, structured content, and output schemas'
);
assert.ok(
  mcpTs.includes("typeof incoming === 'object'") &&
    !mcpTs.includes("JSON.parse(String(requestData?.data"),
  'MCP endpoint must accept Zotero.Server pre-parsed application/json payloads'
);
assert.ok(
  mcpTs.includes("prefs.get(PREF_MCP_TOKEN_ENABLED, false)") &&
    addonPrefs.includes('pref("extensions.zotero-skill-task.mcp.tokenEnabled", false)'),
  'MCP access-token protection must default to disabled'
);
assert.ok(
  mcpTs.includes("prefs.get(PREF_MCP_ENABLED, true)") &&
    addonPrefs.includes('pref("extensions.zotero-skill-task.mcp.enabled", true)'),
  'MCP service must default to enabled'
);
assert.ok(
  mcpTs.includes("name: 'skilltask_inject_skill'") &&
    mcpTs.includes('this.injectSkill(args)') &&
    mcpTs.includes('this.skillGroups.create({'),
  'MCP must expose a tool that injects skills into the existing skill-group store'
);
assert.ok(
  panel.includes('[hidden] { display: none !important; }'),
  'panel CSS must not override hidden notices such as boot and stopped-service banners'
);
assert.ok(
  uiTs.includes("icon: 'chrome://zotero-skill-task/content/icons/icon.svg'"),
  'Tools menu item must include the plugin icon'
);
assert.ok(
  menuIconSvg.includes('width="16"') &&
    menuIconSvg.includes('height="16"') &&
    menuIconSvg.includes('fill="context-fill"') &&
    !menuIconSvg.includes('context-stroke'),
  'Tools menu SVG must follow Zotero MenuManager 16x16 context-fill icon contract'
);
assert.ok(
  addonPrefs.includes('pref("extensions.zotero-skill-task.deliverable.maxFileMB", 200)') &&
    utilsTs.includes('deliverableFileBytes: 200 * 1024 * 1024'),
  'default file limit must be 200 MB'
);
assert.ok(
  !utilsTs.includes('deliverableFileBytesMax') &&
    !mcpTs.includes('maximum: 209715200'),
  '200 MB is a default, not a hard cap'
);

assert.ok(
  panelTs.includes("bindFileDropZone(skillDrop, skillInput") &&
    panelTs.includes("bindFileDropZone(refsDrop, refsInput") &&
    panelTs.includes("getAssetManifest(editing.id)") &&
    panelTs.includes("writeSkillFile(") &&
    panelTs.includes("writeReferenceFiles("),
  'skill editor must support drag/click SKILL.md and references uploads'
);
assert.ok(
  panelTs.includes("referencesEnabled: refsEnabled.checked") &&
    panelTs.includes("referencesDescription: refsDesc.value.trim()"),
  'skill editor must persist references enablement and description'
);
assert.ok(
  skillStoreTs.includes("const SKILL_FILE_NAME = 'SKILL.md'") &&
    skillStoreTs.includes("const REFERENCES_DIR_NAME = 'references'") &&
    skillStoreTs.includes('getAssetManifest(id: string)') &&
    skillStoreTs.includes('writeSkillFile(id: string') &&
    skillStoreTs.includes('writeReferenceFiles(') &&
    skillStoreTs.includes('copySkillAssets(src.id, sg.id)'),
  'skill assets must be persisted in per-skill SKILL.md/references directories'
);

assert.ok(
  skillStoreTs.includes('function normalizeUploadBytes(') &&
    !skillStoreTs.includes('bytes instanceof Uint8Array') &&
    skillStoreTs.includes('new Uint8Array(src.buffer, offset, byteLength)'),
  'skill/reference uploads must accept TypedArrays from another window realm'
);
assert.ok(
  panelTs.includes('function parseSkillMarkdownMetadata(') &&
    panelTs.includes("readField('name')") &&
    panelTs.includes("readField('description')") &&
    panelTs.includes('nameInput.value = metadata.name') &&
    panelTs.includes('descInput.value = metadata.description'),
  'SKILL.md upload must parse and auto-fill name and description'
);
assert.ok(
  mcpTs.includes('skillMarkdown') &&
    mcpTs.includes('referenceFiles') &&
    mcpTs.includes('skillAssets') &&
    mcpTs.includes('skillAssets.references = []'),
  'MCP injection/claim must support skill assets and respect disabled references'
);

assert.ok(
  panelTs.includes('targetFileName') &&
    panelTs.includes('existingAttachmentPolicy') &&
    panelTs.includes("panel-form-existing-overwrite") &&
    panelTs.includes("panel-form-existing-skip"),
  'deliverable form must allow a target filename and overwrite/skip policy'
);
assert.ok(
  panelTs.includes("el('div', 'field-inline conflict-policy')") &&
    panelTs.includes("document.createElement('option')") &&
    panelTs.includes('filePolicy.disabled = !attachFile.checked') &&
    !panelTs.includes('filePolicyRow.hidden =') &&
    panelTs.includes('mdPolicyRow.hidden = !mdToFile') &&
    panelTs.includes('mdPolicy.disabled = !attachMd.checked'),
  'attachment conflict selects must stay visible and only disable when auto-attach is off'
);
assert.ok(
  panel.includes('.field-inline.conflict-policy select') &&
    panel.includes('width: 100%; min-height: 32px') &&
    panel.includes('.field-inline select option'),
  'attachment conflict selects/options need explicit Firefox/Zotero rendering styles'
);
assert.ok(
  panelTs.includes('const taskStatusGroupOpen = new Map<string, boolean>();') &&
    panelTs.includes('bindTaskStatusGroupState(') &&
    panelTs.includes("taskStatusGroupKey(sg.id, st)") &&
    panelTs.includes("taskStatusGroupKey(sg.id, 'done')"),
  'expanding one task must preserve the user-selected open/closed state of status groups'
);
assert.ok(
  panelTs.includes('resolveTaskItem(t.itemKey)') &&
    panelTs.includes("panel-detail-item-title") &&
    panelTs.includes("panel-detail-view-in-library") &&
    panelTs.includes('await pane.selectItem(item.id)') &&
    panelTs.includes('win?.focus?.()'),
  'task detail must show the Zotero item title and provide a jump-to-library action'
);
assert.ok(
  panelTs.includes("d.existingAttachmentPolicy =\n            filePolicy.value === 'overwrite' ? 'overwrite' : 'skip';") &&
    panelTs.includes("d.existingAttachmentPolicy =\n              mdPolicy.value === 'overwrite' ? 'overwrite' : 'skip';"),
  'attachment conflict dropdown selection must persist independently of the attach checkbox'
);
assert.ok(
  taskGeneratorTs.includes('findExistingDeliverableAttachment') &&
    taskGeneratorTs.includes('createCompleted(') &&
    taskGeneratorTs.includes('completedExisting++') &&
    taskStoreTs.includes('findLatestBySkillAndItem') &&
    taskStoreTs.includes('async createCompleted('),
  'scan must persist skip-on-existing attachments as completed tasks'
);
assert.ok(
  taskGeneratorTs.includes('deliverableAttachmentConflict(') &&
    taskGeneratorTs.includes("conflict?.policy === 'overwrite'") &&
    taskGeneratorTs.includes('latest.deliverableRef === conflict.targetName'),
  'switching an existing-attachment completion from skip to overwrite must allow a new task to be generated'
);
assert.ok(
  attachmentsTs.includes('attachmentFilename') &&
    attachmentsTs.includes('findChildAttachmentsByFilename') &&
    mcpTs.includes("policy === 'overwrite'") &&
    mcpTs.includes("policy === 'skip'"),
  'submit must detect same-name attachments and honor overwrite/skip'
);

for (const required of [
  'ctx.Zotero = Zotero',
  'ctx.Services = Services',
  'ctx.PathUtils = PathUtils',
  'ctx.IOUtils = IOUtils',
]) {
  assert.ok(
    bootstrap.includes(required),
    `bootstrap sandbox is missing required host global: ${required}`
  );
}

console.log('✓ UI wiring regression checks passed');
