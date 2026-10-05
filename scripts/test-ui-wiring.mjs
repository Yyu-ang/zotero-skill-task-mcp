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
const prefsXhtml = read('addon/content/preferences.xhtml');
const prefsTs = read('src/preferences.ts');
const uiTs = read('src/ui.ts');
const coreTs = read('src/core.ts');
const mcpTs = read('src/mcpServer.ts');

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
  coreTs.includes("src: 'chrome://zotero-skill-task/content/preferences.xhtml'") &&
    coreTs.includes("scripts: ['chrome://zotero-skill-task/content/preferences.js']"),
  'PreferencePane resources must load through chrome:// URLs'
);

assert.match(
  prefsXhtml,
  /<vbox\b[^>]*\bid="zotero-prefpane-skill-task"[^>]*\bonload="[^"]*ZoteroSkillTaskPreferences\.init\(\)/s,
  'preference pane root must initialize through its own onload lifecycle'
);
assert.ok(
  prefsTs.includes('(window as any).ZoteroSkillTaskPreferences = { init };'),
  'preferences script must expose its initializer on the pane window'
);
assert.ok(
  !prefsTs.includes("document.addEventListener('DOMContentLoaded', init)"),
  'preference pane must not depend on the parent Preferences DOMContentLoaded event'
);

assert.ok(
  !prefsTs.includes("Prefs.get('httpServer.port', true)") &&
    !prefsTs.includes("Prefs.set('httpServer.port', v, true)"),
  'preferences must not treat Zotero built-in httpServer.port as a global plugin pref'
);
assert.ok(
  mcpTs.includes('Z?.Server?.port') &&
    mcpTs.includes("Z?.Prefs?.get?.('httpServer.port')") &&
    !mcpTs.includes("Prefs?.get?.('httpServer.port', true)"),
  'MCP status must report the actual Zotero server port with a correct pref fallback'
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
