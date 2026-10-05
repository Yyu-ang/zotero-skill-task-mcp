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
const panel = read('addon/content/panel.xhtml');
const prefsXhtml = read('addon/content/preferences.xhtml');
const prefsTs = read('src/preferences.ts');

const includeSrc = 'chrome://zotero/content/include.js';
const panelScript = 'src="panel.js"';

assert.ok(
  panel.includes(includeSrc),
  'panel.xhtml must import Zotero core with chrome://zotero/content/include.js'
);
assert.ok(
  panel.indexOf(includeSrc) < panel.indexOf(panelScript),
  'Zotero include.js must load before panel.js'
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
