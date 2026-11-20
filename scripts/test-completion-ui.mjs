/** Exercise the actual rule editor and its read-only preview with a DOM. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML, DOMParser } from 'linkedom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'skilltask-completion-ui-'));
try {
  const { window, document } = parseHTML('<!doctype html><html><body><div id="error-box"></div></body></html>');
  Object.defineProperty(document, 'readyState', { value: 'loading' });
  Object.assign(globalThis, {
    document, window, DOMParser, Event: window.Event,
    HTMLInputElement: window.HTMLInputElement,
    Node: window.Node,
  });
  let reads = 0;
  let scopeReads = 0;
  const note = {
    id: 2, key: 'NOTE0001', parentID: 1, libraryID: 1,
    isNote: () => true,
    getNoteTitle: () => 'Experiment record',
    getNote: () => '<h1>Experiment record</h1><p>Result is ready.</p>',
    getTags: () => [{ tag: 'ready' }],
  };
  const parent = {
    id: 1, key: 'ITEM0001', libraryID: 1,
    isRegularItem: () => true,
    getField: () => 'Selected paper',
    getNotes: () => [2],
  };
  let selected = [parent];
  globalThis.Zotero = {
    locale: 'en-US', Libraries: { userLibraryID: 1 },
    getMainWindow: () => ({ ZoteroPane: { getSelectedItems: () => selected } }),
    Items: { getAsync: async () => { reads++; return note; } },
  };
  const output = join(temp, 'panel.mjs');
  const source = readFileSync(join(root, 'src/panel.ts'), 'utf8');
  await build({
    stdin: {
      contents: source + '\nexport { completionRuleEditor };\nexport function setPreviewAPI(value) { api = value; }',
      resolveDir: join(root, 'src'), loader: 'ts', sourcefile: 'panel.ts',
    },
    bundle: true, platform: 'node', format: 'esm', outfile: output, logLevel: 'silent',
  });
  const { completionRuleEditor, setPreviewAPI } = await import(pathToFileURL(output).href);
  let inScope = true;
  setPreviewAPI({
    skillGroups: {
      matchesScope: async (group) => {
        scopeReads++;
        assert.equal(group.scope.type, 'all');
        return inScope;
      },
    },
    tasks: new Proxy({}, { get() { throw new Error('Preview must never access task storage'); } }),
  });
  const scope = () => ({ type: 'all', collectionKeys: [], includeSubcollections: true });
  const editor = completionRuleEditor(undefined, scope);
  document.body.append(editor.element);
  assert.equal(editor.read().enabled, false, 'new rules are disabled');
  const enabled = editor.element.querySelector('input[type="checkbox"]');
  enabled.checked = true;
  enabled.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.throws(() => editor.read(), /empty/, 'enabling a blank rule must fail');
  const text = editor.element.querySelector('input[type="text"]');
  text.value = 'ready';
  text.dispatchEvent(new window.Event('input', { bubbles: true }));
  const rule = editor.read();
  assert.equal(rule.enabled, true);
  assert.deepEqual(rule.match.conditions, [{ field: 'tag', operator: 'equals', value: 'ready' }]);
  assert.equal(rule.match.minContentLength, 1);
  // Gecko can display native option popups without a usable background.
  // All three rule-editor choices must be opaque document buttons and clickable.
  const html = readFileSync(join(root, 'addon/content/panel.html'), 'utf8');
  assert.match(html, /\.completion-choice-popup\s*\{[^}]*background:\s*var\(--panel\)/s);
  assert.match(html, /\.completion-choice-option\s*\{[^}]*background:\s*var\(--panel\)/s);
  assert.equal(editor.element.querySelectorAll('select').length, 0);
  const picks = [...editor.element.querySelectorAll('.completion-choice')];
  assert.equal(picks.length, 3, 'combine, field and comparison use clickable menus');
  function choose(pick, index) {
    const trigger = pick.querySelector('.completion-choice-trigger');
    const popup = pick.querySelector('[role="listbox"]');
    trigger.click();
    assert.equal(popup.hidden, false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const options = [...popup.querySelectorAll('button[role="option"]')];
    assert.ok(options.length > index);
    options[index].click();
    assert.equal(popup.hidden, true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  }
  choose(picks[1], 1);
  choose(picks[2], 1);
  choose(picks[0], 1);
  assert.deepEqual(editor.read().match.conditions, [{ field: 'title', operator: 'contains', value: 'ready' }]);
  assert.equal(editor.read().match.operator, 'any');
  choose(picks[1], 0);
  choose(picks[0], 0);
  assert.deepEqual(editor.read().match.conditions, [{ field: 'tag', operator: 'equals', value: 'ready' }]);
  assert.equal(editor.read().match.operator, 'all');
  const popup = picks[1].querySelector('[role="listbox"]');
  picks[1].querySelector('.completion-choice-trigger').click();
  const escape = new window.Event('keydown', { bubbles: true, cancelable: true });
  escape.key = 'Escape';
  popup.dispatchEvent(escape);
  assert.equal(popup.hidden, true, 'Escape closes option popup');
  const content = editor.element.querySelectorAll('input[type="checkbox"]')[1];
  content.checked = false;
  content.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(editor.read().match.minContentLength, 0, 'unchecking content removes its default minimum');
  assert.equal(editor.element.querySelector('input[type="number"]').disabled, true);
  editor.setAvailable(false);
  assert.equal(editor.element.hidden, true);
  assert.equal(editor.read().enabled, false, 'file delivery cannot accidentally keep note completion enabled');
  editor.setAvailable(true);
  assert.equal(editor.read().enabled, true, 'switching back retains entered settings');

  const preview = [...editor.element.querySelectorAll('button')].find(button => button.textContent.includes('Check selected'));
  const status = editor.element.querySelector('[role="status"]');
  async function clickPreview() {
    preview.click();
    // opBtn uses a promise; wait for its async reads, without real-time sleeps.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(preview.disabled, false);
  }
  await clickPreview();
  assert.equal(reads, 1);
  assert.equal(scopeReads, 1);
  assert.match(status.textContent, /matched note.*Experiment record/);
  assert.match(status.textContent, /conditions 1/);
  assert.ok([...status.querySelectorAll('button')].some(button => button.textContent.includes('View note')));

  inScope = false;
  await clickPreview();
  assert.match(status.textContent, /outside the current skill scope/);
  assert.equal(reads, 1, 'out-of-scope preview must not inspect notes');
  selected = [{ ...parent, libraryID: 2 }];
  await clickPreview();
  assert.match(status.textContent, /personal library/);
  assert.equal(reads, 1, 'preview must not read other libraries');

  selected = [parent];
  inScope = true;
  globalThis.Zotero.Items.getAsync = async () => { throw new Error('unavailable'); };
  await clickPreview();
  assert.match(status.textContent, /check failed.*cannot be dispatched/);

  const broken = completionRuleEditor({ enabled: true, type: 'builtin-note', match: {} }, scope);
  assert.match(broken.element.textContent, /Unable to check rule/);
  assert.equal(broken.read().enabled, false, 'malformed persisted rules must be repairable in the editor');
  const imported = completionRuleEditor({
    enabled: true,
    type: 'builtin-note',
    match: {
      operator: 'all',
      conditions: [{ field: 'tag', operator: 'equals', value: 'ready' }],
      requireContent: false,
      minContentLength: 20,
    },
  }, scope);
  const importedContent = imported.element.querySelectorAll('input[type="checkbox"]')[1];
  assert.equal(importedContent.checked, true, 'an explicit positive minimum is an effective content requirement');
  assert.equal(imported.read().match.minContentLength, 20, 'saving imported rules must preserve their explicit minimum');
  assert.equal(imported.read().match.requireContent, true, 'the editor uses an equivalent explicit content requirement');
  importedContent.checked = false;
  importedContent.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(imported.read().match.minContentLength, 0, 'only explicit unchecking removes the imported minimum');
  console.log('Completion rule UI: validation, visibility, preview, scope, read errors and no task mutations passed.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
