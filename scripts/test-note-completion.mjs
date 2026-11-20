/** Behavioral tests for generic rules, inert HTML and Zotero child-note reads. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DOMParser } from 'linkedom';

const directory = mkdtempSync(join(tmpdir(), 'note-completion-test-'));
const bundle = join(directory, 'note-completion.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../src/noteCompletion.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'error',
});
const N = await import(bundle);
const originalParser = globalThis.DOMParser;
const originalZotero = globalThis.Zotero;
after(() => {
  globalThis.DOMParser = originalParser;
  globalThis.Zotero = originalZotero;
  rmSync(directory, { recursive: true, force: true });
});

const condition = (field, value, operator = 'equals') => ({ field, value, operator });
const rule = (conditions = [condition('tag', '完成')], overrides = {}) => ({
  enabled: true,
  type: 'builtin-note',
  match: { operator: 'all', conditions, ...overrides },
});
const facts = (overrides = {}) => ({
  key: 'NOTE0001', title: '计算说明', text: '计算说明 本次计算已复核。', tags: ['完成'], ...overrides,
});

describe('rule validation', () => {
  test('missing rules are off and disabled rules retain editable conditions', () => {
    assert.equal(N.assertValidCompletionRule(undefined), undefined);
    assert.equal(N.assertValidCompletionRule(null), undefined);
    const input = { ...rule(), enabled: false };
    const parsed = N.assertValidCompletionRule(input);
    assert.equal(parsed.enabled, false);
    assert.deepEqual(parsed.match.conditions, input.match.conditions);
    assert.notEqual(parsed.match.conditions, input.match.conditions);
    assert.equal(N.assertValidCompletionRule({ enabled: false, type: 'builtin-note' }).match.conditions.length, 0);
  });

  test('normalizes values and supplies content defaults', () => {
    const parsed = N.assertValidCompletionRule(rule([condition('title', '  Cafe\u0301\n 完成  ')]));
    assert.equal(parsed.match.conditions[0].value, 'Café 完成');
    assert.equal(parsed.match.requireContent, true);
    assert.equal(parsed.match.minContentLength, 1);
    assert.deepEqual(parsed.match.exclude, []);
  });

  test('enabled empty positives are rejected for both AND and OR', () => {
    for (const operator of ['all', 'any']) {
      assert.throws(() => N.assertValidCompletionRule(rule([], { operator })), /positive condition/);
    }
  });

  test('invalid types, fields, operators, and blank literals are rejected', () => {
    for (const input of [
      [], true, 'rule', {}, { enabled: true, type: 'unknown' },
      { ...rule(), enabled: 'true' },
      rule([condition('author', 'a')]),
      rule([condition('title', 'a', 'regex')]),
      rule([condition('tag', 'a', 'contains')]),
      rule([condition('title', ' \u200b\n ')]),
      rule([condition('title', 'a'.repeat(1001))]),
      rule(Array.from({ length: 51 }, () => condition('tag', 'a'))),
      rule(undefined, { operator: 'none' }),
      rule(undefined, { exclude: null }),
      rule(undefined, { requireContent: 'yes' }),
      rule(undefined, { minContentLength: -1 }),
      rule(undefined, { minContentLength: 1.5 }),
      rule(undefined, { minContentLength: Infinity }),
      rule(undefined, { minContentLength: 1_000_001 }),
    ]) assert.throws(() => N.assertValidCompletionRule(input));
  });
});

describe('single-note matching', () => {
  test('AND requires all conditions on a single note', () => {
    const both = rule([condition('tag', '完成'), condition('title', '计算说明')]);
    assert.equal(N.evaluateNoteCompletion(both, facts({ title: '另一笔记' })).matches, false);
    assert.equal(N.evaluateNoteCompletion(both, facts({ tags: [] })).matches, false);
    assert.deepEqual(N.evaluateNoteCompletion(both, facts()).matchedConditions, [0, 1]);
  });

  test('OR accepts any positive match and reports matching condition indexes', () => {
    const either = rule([condition('tag', '复核'), condition('title', '计算', 'startsWith')], { operator: 'any' });
    assert.deepEqual(N.evaluateNoteCompletion(either, facts()).matchedConditions, [1]);
    assert.equal(N.evaluateNoteCompletion(either, facts()).matches, true);
  });

  test('exclusions take precedence and use any-condition semantics', () => {
    const r = rule(undefined, { exclude: [condition('tag', '未完成'), condition('text', '草稿', 'contains')] });
    const evaluation = N.evaluateNoteCompletion(r, facts({ text: '草稿 等待补齐' }));
    assert.equal(evaluation.excluded, true);
    assert.equal(evaluation.matches, false);
    assert.deepEqual(evaluation.matchedConditions, []);
    assert.equal(N.evaluateNoteCompletion(r, facts({ tags: ['完成', '未完成'] })).matches, false);
  });

  test('tags use exact normalized values and case-sensitive comparison', () => {
    assert.equal(N.evaluateNoteCompletion(rule(), facts({ tags: ['尚未完成'] })).matches, false);
    assert.equal(N.evaluateNoteCompletion(rule([condition('tag', 'Complete')]), facts({ tags: ['complete'] })).matches, false);
    assert.equal(N.evaluateNoteCompletion(rule([condition('tag', 'Café')]), facts({ tags: [' Cafe\u0301 '] })).matches, true);
  });

  test('title and text support literal equals, prefix and contains, not regex', () => {
    for (const [field, value, operator, expected] of [
      ['title', '计算说明', 'equals', true],
      ['title', '说明', 'equals', false],
      ['title', '计算', 'startsWith', true],
      ['title', '说明', 'contains', true],
      ['text', '本次计算已复核', 'contains', true],
      ['text', '.*', 'contains', false],
    ]) assert.equal(N.evaluateNoteCompletion(rule([condition(field, value, operator)]), facts()).matches, expected);
  });

  test('content length counts Unicode characters, not bytes, UTF-16 units or whitespace', () => {
    const note = facts({ text: ' 甲 \n 乙\u00a0😀\u200B ' });
    assert.equal(N.evaluateNoteCompletion(rule(), note).contentLength, 3);
    assert.equal(N.evaluateNoteCompletion(rule(undefined, { minContentLength: 3 }), note).matches, true);
    assert.equal(N.evaluateNoteCompletion(rule(undefined, { minContentLength: 4 }), note).matches, false);
  });

  test('empty text is rejected by default; content requirement can be disabled explicitly', () => {
    const empty = facts({ text: ' \u00a0\u200B ' });
    assert.equal(N.evaluateNoteCompletion(rule(), empty).matches, false);
    assert.equal(N.evaluateNoteCompletion(rule(undefined, { requireContent: false }), empty).matches, true);
    assert.equal(N.evaluateNoteCompletion(rule(undefined, { requireContent: false, minContentLength: 2 }), empty).matches, false);
    assert.equal(N.evaluateNoteCompletion(rule(undefined, { minContentLength: 0 }), empty).matches, false);
  });

  test('disabled rules never match', () => {
    assert.equal(N.evaluateNoteCompletion({ ...rule(), enabled: false }, facts()).matches, false);
  });
});

describe('inert HTML normalization', () => {
  beforeEach(() => { globalThis.DOMParser = DOMParser; });

  test('decodes entities and preserves word boundaries without splitting inline words', () => {
    assert.equal(N.noteHtmlToText('<h1>标题</h1><p>re<strong>sult</strong>&nbsp;&amp;&nbsp;value<br>next</p>'), '标题 result & value next');
  });

  test('markup, attributes, scripts, comments, styles, and hidden text cannot satisfy markers', () => {
    const html = '<div data-marker="complete">Visible</div><!-- complete -->'
      + '<script>complete</script><style>.complete{}</style><template>complete</template>'
      + '<span hidden>complete</span><span aria-hidden="true">complete</span>'
      + '<p style="display: none">complete</p><p style="visibility: hidden">complete</p>'
      + '<div style="opacity: 0">complete</div><iframe>complete</iframe>';
    assert.equal(N.noteHtmlToText(html), 'Visible');
  });

  test('empty HTML shells and formatting-only text become empty', () => {
    for (const html of ['<p><br></p>', '<div>&nbsp;\u200b</div>', '<!-- completed -->', '<script>done</script>']) {
      assert.equal(N.noteHtmlToText(html), '');
    }
  });

  test('tables and adjacent list entries retain separation', () => {
    assert.equal(N.noteHtmlToText('<ul><li>one</li><li>two</li></ul><table><tr><td>three</td><td>four</td></tr></table>'), 'one two three four');
  });

  test('unavailable HTML parser raises a check error instead of returning empty text', () => {
    globalThis.DOMParser = undefined;
    assert.throws(() => N.noteHtmlToText('<p>data</p>'), /DOMParser/);
  });
});

describe('Zotero child-note adapter', () => {
  const parent = { id: 100, libraryID: 1, getNotes: () => [1, 2] };
  let notes;
  const note = (key, overrides = {}) => ({
    key, parentID: 100, libraryID: 1, deleted: false,
    isNote: () => true,
    getNoteTitle: () => '计算说明',
    getNote: () => '<h1>计算说明</h1><p>内容已完成</p>',
    getTags: () => [{ tag: '完成', type: 0 }],
    dateModified: '2026-11-20 00:00:00',
    ...overrides,
  });
  beforeEach(() => {
    globalThis.DOMParser = DOMParser;
    notes = new Map([[1, note('NOTE0001')], [2, note('NOTE0002')]]);
    globalThis.Zotero = { Items: { getAsync: async (id) => notes.get(id) } };
  });

  test('selects newest qualifying note, breaking ties by key deterministically', async () => {
    assert.equal((await N.findMatchingBuiltinNote(parent, rule())).noteKey, 'NOTE0001');
    notes.set(2, note('NOTE0002', { dateModified: '2026-11-20 01:00:00' }));
    assert.equal((await N.findMatchingBuiltinNote(parent, rule())).noteKey, 'NOTE0002');
    assert.equal((await N.findMatchingBuiltinNote({ ...parent, getNotes: () => [2, 1] }, rule())).noteKey, 'NOTE0002');
  });

  test('does not combine tags from one note with the title of another', async () => {
    notes.set(1, note('NOTE0001', { getNoteTitle: () => '别的标题' }));
    notes.set(2, note('NOTE0002', { getTags: () => [] }));
    assert.deepEqual(await N.findMatchingBuiltinNote(parent, rule([condition('tag', '完成'), condition('title', '计算说明')])), { status: 'not-matched' });
  });

  test('exclusion disqualifies only that note; an older qualifying note remains sufficient', async () => {
    notes.set(2, note('NOTE0002', {
      dateModified: '2026-11-21 00:00:00', getTags: () => [{ tag: '完成' }, { tag: '草稿' }],
    }));
    const result = await N.findMatchingBuiltinNote(parent, rule(undefined, { exclude: [condition('tag', '草稿')] }));
    assert.equal(result.noteKey, 'NOTE0001');
  });

  test('skips deleted notes, other libraries, wrong parents, and non-note children', async () => {
    for (const override of [
      { deleted: true }, { libraryID: 2 }, { parentID: 200 }, { isNote: () => false },
    ]) {
      notes.set(1, note('NOTE0001', override));
      notes.set(2, note('NOTE0002', override));
      assert.deepEqual(await N.findMatchingBuiltinNote(parent, rule()), { status: 'not-matched' });
    }
  });

  test('no notes is a valid negative result and an omitted rule does not read notes', async () => {
    assert.deepEqual(await N.findMatchingBuiltinNote({ ...parent, getNotes: () => [] }, rule()), { status: 'not-matched' });
    assert.deepEqual(await N.findMatchingBuiltinNote(null, undefined), { status: 'not-matched' });
  });

  test('incomplete reads and parser failures do not become no-match decisions', async () => {
    notes.delete(1);
    notes.set(2, note('NOTE0002', { getTags: () => [] }));
    assert.equal((await N.findMatchingBuiltinNote(parent, rule())).status, 'error');
    globalThis.Zotero.Items.getAsync = async () => { throw new Error('read failed'); };
    assert.match((await N.findMatchingBuiltinNote(parent, rule())).error, /read failed/);
    globalThis.Zotero.Items.getAsync = async () => note('NOTE0001');
    globalThis.DOMParser = undefined;
    assert.match((await N.findMatchingBuiltinNote(parent, rule())).error, /DOMParser/);
  });

  test('one proven match suffices even when another note cannot be read', async () => {
    notes.delete(1);
    assert.equal((await N.findMatchingBuiltinNote(parent, rule())).noteKey, 'NOTE0002');
  });

  test('invalid stored rules, missing reader APIs and unknown child fields report errors', async () => {
    assert.equal((await N.findMatchingBuiltinNote(parent, rule([]))).status, 'error');
    assert.equal((await N.findMatchingBuiltinNote({}, rule())).status, 'error');
    globalThis.Zotero = {};
    assert.equal((await N.findMatchingBuiltinNote(parent, rule())).status, 'error');
    globalThis.Zotero = { Items: { getAsync: async () => note('NOTE0001', { getTags: undefined }) } };
    assert.equal((await N.findMatchingBuiltinNote(parent, rule())).status, 'error');
    globalThis.Zotero.Items.getAsync = async () => note('NOTE0001', { libraryID: undefined });
    assert.equal((await N.findMatchingBuiltinNote(parent, rule())).status, 'error');
  });

  test('hidden HTML and markup attributes are not body markers', async () => {
    notes.set(1, note('NOTE0001', { getNote: () => '<p data-status="complete">visible</p>' }));
    notes.set(2, note('NOTE0002', { getNote: () => '<p hidden>complete</p>' }));
    assert.deepEqual(await N.findMatchingBuiltinNote(parent, rule([condition('text', 'complete', 'contains')])), { status: 'not-matched' });
  });

  test('loads childItems, itemData, note and tags before calling lazy Zotero getters', async () => {
    let childrenLoaded = false;
    const loaded = new Set();
    const lazyParent = {
      ...parent,
      loadDataType: async (type) => { assert.equal(type, 'childItems'); childrenLoaded = true; },
      getNotes: () => { assert.equal(childrenLoaded, true); return [1]; },
    };
    notes.set(1, note('NOTE0001', {
      loadDataType: async (type) => { loaded.add(type); },
      getNoteTitle: () => { assert.ok(loaded.has('itemData')); return '计算说明'; },
      getNote: () => { assert.ok(loaded.has('note')); return '<p>已完成内容</p>'; },
      getTags: () => { assert.ok(loaded.has('tags')); return [{ tag: '完成' }]; },
    }));
    assert.equal((await N.findMatchingBuiltinNote(lazyParent, rule())).status, 'matched');
    notes.get(1).loadDataType = async () => { throw new Error('lazy load failed'); };
    assert.match((await N.findMatchingBuiltinNote(lazyParent, rule())).error, /lazy load failed/);
  });
});
