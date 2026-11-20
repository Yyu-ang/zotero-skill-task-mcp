/** Integration tests: real stores/generator/MCP over an in-memory Zotero host. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DOMParser } from 'linkedom';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'note-dispatch-test-'));
const bundle = join(directory, 'dispatch.mjs');
await build({
  stdin: {
    contents: [
      "export { TaskStore } from './src/taskStore';",
      "export { SkillGroupStore } from './src/skillGroupStore';",
      "export { TaskGenerator } from './src/taskGenerator';",
      "export { McpServer } from './src/mcpServer';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  tsconfig: join(root, 'tsconfig.json'),
  bundle: true,
  format: 'esm',
  outfile: bundle,
  define: { __SKILLTASK_ENV__: '"production"' },
  logLevel: 'error',
});
const { TaskStore, SkillGroupStore, TaskGenerator, McpServer } = await import(bundle);

const originalGlobals = Object.fromEntries(['Zotero', 'IOUtils', 'PathUtils', 'DOMParser'].map((key) => [key, globalThis[key]]));
after(() => {
  Object.assign(globalThis, originalGlobals);
  rmSync(directory, { recursive: true, force: true });
});

// Gecko wraps text/html fragments in a body. linkedom expects a full document.
class HostDOMParser {
  parseFromString(html, type) {
    const input = type === 'text/html' && !/<html(?:\s|>)/i.test(html)
      ? `<!doctype html><html><body>${html}</body></html>`
      : html;
    return new DOMParser().parseFromString(input, type);
  }
}

const makeRule = (value = '完成', field = 'tag') => ({
  enabled: true,
  type: 'builtin-note',
  match: {
    operator: 'all',
    conditions: [{ field, operator: 'equals', value }],
    exclude: [],
    requireContent: true,
    minContentLength: 1,
  },
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, milliseconds = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation timed out')), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('scheduled note change was not processed');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let harness;
async function makeHarness({ completionRule = makeRule(), pdf = 'none', deliverable = { type: 'note' } } = {}) {
  const disk = new Map();
  const items = new Map();
  const observers = new Map();
  const failedReads = new Set();
  const logs = [];
  let nextItemID = 1000;
  let nextObserverID = 1;
  let createdNotes = 0;
  let searchLibraryID;
  let beforeSave = async () => {};
  globalThis.DOMParser = HostDOMParser;
  globalThis.PathUtils = { join, filename: basename };
  globalThis.IOUtils = {
    makeDirectory: async () => {},
    exists: async (path) => disk.has(path),
    readJSON: async (path) => {
      if (!disk.has(path)) throw new Error('file not found');
      return structuredClone(disk.get(path));
    },
    writeJSON: async (path, data) => { disk.set(path, structuredClone(data)); },
    write: async (path, data) => { disk.set(path, new Uint8Array(data)); },
    stat: async (path) => ({ type: 'regular', size: disk.get(path)?.byteLength ?? 0 }),
    getChildren: async () => [],
  };

  async function emit(event, ids, extraData = {}, type = 'item') {
    await Promise.all(Array.from(observers.values()).map((observer) => observer.notify(event, type, ids, extraData)));
  }

  function addParent({ id = 100, key = 'PARENT01', libraryID = 1 } = {}) {
    const parent = {
      id, key, libraryID, deleted: false, itemType: 'journalArticle',
      isRegularItem: () => true,
      isNote: () => false,
      isAttachment: () => false,
      getNotes: () => Array.from(items.values()).filter((item) => item.isNote() && item.parentID === id && !item.deleted).map((item) => item.id),
      getAttachments: () => [],
      getCollections: () => [],
      getDisplayTitle: () => '示例文献',
      getField: () => '',
      getCreators: () => [],
    };
    items.set(id, parent);
    return parent;
  }

  function addNote({ parent = primary, title = '计算说明', html = '<h1>计算说明</h1><p>内容已完成。</p>', tags = ['完成'], key, libraryID = parent.libraryID, ...overrides } = {}) {
    const id = nextItemID++;
    const item = {
      id, key: key ?? `NOTE${String(id).padStart(4, '0')}`, parentID: parent.id, libraryID,
      deleted: false, dateModified: '2026-11-20 00:00:00',
      isRegularItem: () => false,
      isNote: () => true,
      isAttachment: () => false,
      getNoteTitle: () => title,
      getNote: () => html,
      getTags: () => tags.map((tag) => ({ tag, type: 0 })),
      ...overrides,
    };
    items.set(id, item);
    return item;
  }

  globalThis.Zotero = {
    DataDirectory: { dir: '/virtual-zotero' },
    Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1 }, { libraryID: 2 }] },
    debug: () => {},
    logError: (error) => logs.push(error.message),
    Prefs: { get: () => undefined },
    Items: {
      get: (id) => items.get(id),
      getAsync: async (ids) => {
        const get = (id) => {
          if (failedReads.has(id)) throw new Error('simulated note read failure');
          return items.get(id);
        };
        return Array.isArray(ids) ? ids.map(get) : get(ids);
      },
      getByLibraryAndKey: (libraryID, key) => Array.from(items.values()).find((item) => item.libraryID === libraryID && item.key === key),
    },
    Search: class {
      constructor({ libraryID }) { this.libraryID = libraryID; searchLibraryID = libraryID; }
      async search() { return Array.from(items.values()).filter((item) => item.isRegularItem() && item.libraryID === this.libraryID && !item.deleted).map((item) => item.id); }
    },
    Notifier: {
      registerObserver(observer) { const id = String(nextObserverID++); observers.set(id, observer); return id; },
      unregisterObserver(id) { observers.delete(id); },
    },
    Item: class {
      constructor(type) { assert.equal(type, 'note'); this.html = ''; }
      setNote(html) { this.html = html; }
      async saveTx() {
        await beforeSave();
        const parent = items.get(this.parentID);
        assert.ok(parent, 'new note must have a real parent');
        assert.equal(this.libraryID, parent.libraryID, 'new note must explicitly preserve libraryID');
        const saved = addNote({ parent, html: this.html, tags: [] });
        this.id = saved.id;
        this.key = saved.key;
        createdNotes++;
        // Zotero can await callbacks while the write transaction is still running.
        await emit('add', [saved.id]);
      }
    },
  };

  const primary = addParent();
  const tasks = await TaskStore.load();
  const skillGroups = await SkillGroupStore.load();
  const group = await skillGroups.create({
    name: '通用笔记任务', description: '', instruction: '根据材料撰写计算说明。',
    scope: { type: 'all', collectionKeys: [], includeSubcollections: false },
    materials: { includeMetadata: false, includeAbstract: false, includeNotes: false, pdf },
    deliverable, completionRule,
  });
  const result = {
    primary, tasks, skillGroups, group, disk, items, failedReads, observers, logs,
    addParent, addNote, emit,
    get createdNotes() { return createdNotes; },
    get searchLibraryID() { return searchLibraryID; },
    set beforeSave(callback) { beforeSave = callback; },
  };
  result.rebuild = (groups = result.skillGroups) => {
    result.generator?.unregisterNotifier();
    result.skillGroups = groups;
    result.generator = new TaskGenerator({ skillGroups: groups, tasks, isAlive: () => result.alive !== false });
    result.server = new McpServer({ skillGroups: groups, tasks, generator: result.generator, version: '0.7.0-beta.1' });
  };
  result.rebuild();
  return result;
}

beforeEach(async () => { harness = await makeHarness(); });
afterEach(() => { harness.alive = false; harness.generator.unregisterNotifier(); });

describe('skill-group rule storage', () => {
  test('save, copy and reload preserve isolated rule configuration', async () => {
    const h = harness;
    const original = h.skillGroups.get(h.group.id);
    const copied = await h.skillGroups.copy(h.group.id);
    assert.notEqual(copied.id, original.id);
    assert.deepEqual(copied.completionRule, original.completionRule);
    copied.completionRule.match.conditions[0].value = 'local edit only';
    assert.equal(h.skillGroups.get(copied.id).completionRule.match.conditions[0].value, '完成');
    const reloaded = await SkillGroupStore.load();
    assert.deepEqual(reloaded.get(h.group.id).completionRule, original.completionRule);
    assert.deepEqual(reloaded.get(copied.id).completionRule, original.completionRule);
  });

  test('invalid enabled edits fail atomically without changing other fields', async () => {
    const h = harness;
    const before = h.skillGroups.get(h.group.id);
    const invalid = makeRule();
    invalid.match.conditions = [];
    await assert.rejects(h.skillGroups.update(h.group.id, { name: 'should not persist', completionRule: invalid }), /positive condition/);
    assert.deepEqual(h.skillGroups.get(h.group.id), before);
    assert.deepEqual((await SkillGroupStore.load()).get(h.group.id), before);
  });

  test('enabled note completion is limited to note and markdown-to-note deliverables', async () => {
    const h = harness;
    await assert.rejects(h.skillGroups.update(h.group.id, { deliverable: { type: 'file' } }), /内建笔记/);
    assert.equal(h.skillGroups.get(h.group.id).deliverable.type, 'note');
    const markdown = await h.skillGroups.update(h.group.id, { deliverable: { type: 'markdown', target: 'note' } });
    assert.equal(markdown.completionRule.enabled, true);
    const file = await h.skillGroups.update(h.group.id, {
      deliverable: { type: 'file' }, completionRule: { ...makeRule(), enabled: false },
    });
    assert.equal(file.deliverable.type, 'file');
    assert.equal(file.completionRule.enabled, false);
  });

  test('legacy groups with no completionRule keep their original dispatch behavior', async () => {
    const h = harness;
    const path = h.skillGroups.getFilePath();
    const old = h.disk.get(path);
    delete old[0].completionRule;
    h.disk.set(path, old);
    h.rebuild(await SkillGroupStore.load());
    h.addNote();
    await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.tasks.list()[0].status, 'pending');
    assert.ok((await h.server.claim({ skillGroupId: h.group.id })).task);
  });
});

describe('scan and completion state', () => {
  test('existing note completes before missing-PDF checks without counting an AI submission', async () => {
    const h = harness;
    await h.skillGroups.update(h.group.id, { materials: { ...h.group.materials, pdf: 'earliest' } });
    const existing = h.addNote();
    const result = await h.generator.scanSkillGroup(h.group.id);
    assert.equal(result.completedExisting, 1);
    const [task] = h.tasks.list();
    assert.equal(task.status, 'done');
    assert.equal(task.noteKey, existing.key);
    assert.equal(task.completionOrigin, 'existing-note');
    assert.equal(task.submissionCount, 0);
    assert.equal(task.attempts, 0);
    assert.equal(task.libraryID, 1);
    const after = await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.tasks.list().length, 1);
    assert.equal(after.completedExisting, 0);
    assert.equal(h.tasks.get(task.id).completedAt, task.completedAt);
  });

  test('AND cannot combine facts from different notes', async () => {
    const h = harness;
    const completionRule = makeRule();
    completionRule.match.conditions.push({ field: 'title', operator: 'equals', value: '计算说明' });
    await h.skillGroups.update(h.group.id, { completionRule });
    h.addNote({ title: '其他标题' });
    h.addNote({ tags: [] });
    await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.tasks.list()[0].status, 'pending');
  });

  test('only the user library is scanned and cross-library key collisions cannot complete it', async () => {
    const h = harness;
    const otherParent = h.addParent({ id: 200, key: h.primary.key, libraryID: 2 });
    h.addNote({ parent: otherParent });
    await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.searchLibraryID, 1);
    const [task] = h.tasks.list();
    assert.equal(h.tasks.list().length, 1);
    assert.equal(task.libraryID, 1);
    assert.equal(task.status, 'pending');
  });

  test('removed or moved rule-matching notes reopen the same task on scan', async () => {
    const h = harness;
    const note = h.addNote();
    await h.generator.scanSkillGroup(h.group.id);
    const [completed] = h.tasks.list();
    note.deleted = true;
    await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.tasks.list().length, 1);
    assert.equal(h.tasks.get(completed.id).status, 'pending');
    assert.equal(h.tasks.get(completed.id).noteKey, null);
    note.deleted = false;
    await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.tasks.get(completed.id).status, 'done');
    const other = h.addParent({ id: 200, key: 'PARENT02' });
    note.parentID = other.id;
    await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.tasks.get(completed.id).status, 'pending');
  });

  test('disabled rules preserve recognized completions even after the note is deleted', async () => {
    const h = harness;
    const note = h.addNote();
    await h.generator.scanSkillGroup(h.group.id);
    const [completed] = h.tasks.list();
    await h.skillGroups.update(h.group.id, { completionRule: { ...makeRule(), enabled: false } });
    note.deleted = true;
    await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.tasks.get(completed.id).status, 'done');
    assert.equal(h.tasks.list().length, 1);
  });

  test('scan never reopens agent-completed or cancelled tasks', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const [task] = h.tasks.list();
    await h.tasks.complete(task.id, { noteKey: 'HISTORY1', deliverableType: 'note', deliverableRef: 'HISTORY1' });
    await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.tasks.get(task.id).status, 'done');
    const second = h.addParent({ id: 200, key: 'PARENT02' });
    await h.generator.scanSkillGroup(h.group.id);
    const cancelled = h.tasks.list().find((row) => row.itemKey === second.key);
    await h.tasks.cancel(cancelled.id);
    h.addNote({ parent: second });
    await h.generator.scanSkillGroup(h.group.id);
    assert.equal(h.tasks.get(cancelled.id).status, 'cancelled');
    assert.equal(h.tasks.list().length, 2);
  });

  test('scan leaves an actively claimed task unchanged', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const claim = await h.server.claim({ skillGroupId: h.group.id });
    h.addNote();
    const before = h.tasks.get(claim.task.id);
    await h.generator.scanSkillGroup(h.group.id);
    assert.deepEqual(h.tasks.get(claim.task.id), before);
  });

  test('concurrent scans never create a second task', async () => {
    const h = harness;
    const outcomes = await Promise.allSettled([
      h.generator.scanSkillGroup(h.group.id), h.generator.scanSkillGroup(h.group.id),
    ]);
    assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
    assert.equal(h.tasks.list().length, 1);
  });
});

describe('claim and submit checks', () => {
  test('a note added after queuing is recognized before claim', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const note = h.addNote();
    const result = await h.server.claim({ skillGroupId: h.group.id });
    assert.equal(result.task, null);
    const [task] = h.tasks.list();
    assert.equal(task.status, 'done');
    assert.equal(task.noteKey, note.key);
    assert.equal(task.attempts, 0);
    assert.equal(task.submissionCount, 0);
  });

  test('read failures block dispatch with a visible task error and recover on retry', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const note = h.addNote({ tags: [] });
    h.failedReads.add(note.id);
    const denied = await h.server.claim({ skillGroupId: h.group.id });
    assert.equal(denied.task, null);
    const [blocked] = h.tasks.list();
    assert.notEqual(blocked.status, 'claimed');
    assert.match(blocked.lastError, /completion-check|read failure/);
    h.failedReads.clear();
    const allowed = await h.server.claim({ skillGroupId: h.group.id });
    assert.equal(allowed.task.id, blocked.id);
    assert.equal(h.tasks.get(blocked.id).lastError, null);
  });

  test('malformed persisted enabled rules block claims instead of silently disabling checks', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const path = h.skillGroups.getFilePath();
    const stored = h.disk.get(path);
    stored[0].completionRule.match.conditions = [];
    h.disk.set(path, structuredClone(stored));
    h.rebuild(await SkillGroupStore.load());
    assert.equal((await h.server.claim({ skillGroupId: h.group.id })).task, null);
    assert.match(h.tasks.list()[0].lastError, /positive condition|completion-check/);
  });

  test('a matching note appearing during a lease prevents a duplicate note on submit', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const claimed = await h.server.claim({ skillGroupId: h.group.id });
    const note = h.addNote();
    const result = await h.server.submit({ taskId: claimed.task.id, noteHtml: '<p>本次计算结果。</p>' });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(result.noteKey, note.key);
    assert.equal(result.submissionCount, 0);
    assert.equal(h.createdNotes, 0);
    assert.equal(h.tasks.get(claimed.task.id).completionOrigin, 'existing-note');
  });

  test('simultaneous submits create one built-in note and count one submission', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const claimed = await h.server.claim({ skillGroupId: h.group.id });
    const started = deferred();
    const resume = deferred();
    h.beforeSave = async () => { started.resolve(); await resume.promise; };
    const first = h.server.submit({ taskId: claimed.task.id, noteHtml: '<p>计算结果一。</p>' });
    await within(started.promise);
    const second = h.server.submit({ taskId: claimed.task.id, noteHtml: '<p>计算结果二。</p>' });
    resume.resolve();
    const results = await within(Promise.all([first, second]));
    assert.ok(results.every((result) => result.ok));
    assert.equal(results.filter((result) => result.duplicate).length, 1);
    assert.equal(h.createdNotes, 1);
    assert.equal(h.tasks.get(claimed.task.id).submissionCount, 1);
    assert.equal(h.tasks.get(claimed.task.id).completionOrigin, 'agent');
  });

  test('claimed completion rules remain fixed when the skill group is edited', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const claimed = await h.server.claim({ skillGroupId: h.group.id });
    await h.skillGroups.update(h.group.id, { completionRule: makeRule('另一结果') });
    const oldRuleNote = h.addNote();
    const result = await h.server.submit({ taskId: claimed.task.id, noteHtml: '<p>结果</p>' });
    assert.equal(result.duplicate, true);
    assert.equal(result.noteKey, oldRuleNote.key);
    assert.equal(h.createdNotes, 0);
  });

  test('enabling a rule after claim does not retroactively change that lease', async () => {
    const h = harness;
    await h.skillGroups.update(h.group.id, { completionRule: { ...makeRule(), enabled: false } });
    await h.generator.scanSkillGroup(h.group.id);
    const claimed = await h.server.claim({ skillGroupId: h.group.id });
    await h.skillGroups.update(h.group.id, { completionRule: makeRule() });
    h.addNote();
    const result = await h.server.submit({ taskId: claimed.task.id, noteHtml: '<p>本租约结果</p>' });
    assert.equal(result.ok, true);
    assert.notEqual(result.duplicate, true);
    assert.equal(h.createdNotes, 1);
  });

  test('two simultaneous claims return the pending task only once', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const results = await Promise.all([h.server.claim({ skillGroupId: h.group.id }), h.server.claim({ skillGroupId: h.group.id })]);
    assert.equal(results.filter((result) => result.task).length, 1);
    assert.equal(h.tasks.list()[0].attempts, 1);
  });

  test('changing deliverable during a lease preserves its original note input and completion rule', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    const claim = await h.server.claim({ skillGroupId: h.group.id });
    await h.skillGroups.update(h.group.id, {
      deliverable: { type: 'file' }, completionRule: { ...makeRule(), enabled: false },
    });
    const note = h.addNote();
    const result = await h.server.submit({ taskId: claim.task.id, noteHtml: '<p>原笔记交付物</p>' });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(result.noteKey, note.key);
    assert.equal(result.deliverableType, 'note');
    assert.equal(h.createdNotes, 0);
  });

  test('a frozen markdown-to-note lease retains its deliverable type when recognizing an existing note', async () => {
    const h = harness;
    await h.skillGroups.update(h.group.id, { deliverable: { type: 'markdown', target: 'note' } });
    await h.generator.scanSkillGroup(h.group.id);
    const claim = await h.server.claim({ skillGroupId: h.group.id });
    await h.skillGroups.update(h.group.id, {
      deliverable: { type: 'file' }, completionRule: { ...makeRule(), enabled: false },
    });
    h.addNote();
    const result = await h.server.submit({ taskId: claim.task.id, markdown: '原 Markdown 交付物' });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(result.deliverableType, 'markdown');
  });

  for (const action of ['cancel', 'releaseLease']) {
    test(`${action} waits for a suspended submission instead of changing its task mid-write`, async () => {
      const h = harness;
      const note = h.addNote({ tags: [] });
      await h.generator.scanSkillGroup(h.group.id);
      const claim = await h.server.claim({ skillGroupId: h.group.id });
      const start = deferred();
      const resume = deferred();
      const read = globalThis.Zotero.Items.getAsync;
      globalThis.Zotero.Items.getAsync = async (id) => {
        if (id === note.id) { start.resolve(); await resume.promise; }
        return read(id);
      };
      const submitting = h.server.submit({ taskId: claim.task.id, noteHtml: '<p>计算结果</p>' });
      await within(start.promise);
      const changing = h.tasks[action](claim.task.id).then(
        (value) => ({ value }), (error) => ({ error }),
      );
      await Promise.resolve();
      assert.equal(h.tasks.get(claim.task.id).status, 'claimed');
      resume.resolve();
      const [submitted, changed] = await within(Promise.all([submitting, changing]));
      assert.equal(submitted.ok, true);
      assert.ok(changed.error, 'the completed task cannot be cancelled or returned');
      assert.equal(h.tasks.get(claim.task.id).status, 'done');
      assert.equal(h.createdNotes, 1);
    });
  }

  test('a lease released as expired during asynchronous note reads cannot write a stale result', async () => {
    const h = harness;
    const note = h.addNote({ tags: [] });
    await h.generator.scanSkillGroup(h.group.id);
    const claim = await h.server.claim({ skillGroupId: h.group.id });
    const start = deferred();
    const resume = deferred();
    const read = globalThis.Zotero.Items.getAsync;
    globalThis.Zotero.Items.getAsync = async (id) => {
      if (id === note.id) { start.resolve(); await resume.promise; }
      return read(id);
    };
    const submitting = h.server.submit({ taskId: claim.task.id, noteHtml: '<p>过期结果</p>' });
    await within(start.promise);
    await h.tasks.releaseExpiredLeases(Date.now() + 60 * 60 * 1000);
    resume.resolve();
    const result = await within(submitting);
    assert.equal(result.ok, false);
    assert.equal(h.createdNotes, 0);
    assert.equal(h.tasks.get(claim.task.id).status, 'pending');
  });
});

describe('note notifications', () => {
  test('note additions re-evaluate the parent without a manual scan', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    h.generator.registerNotifier();
    const note = h.addNote();
    await within(h.emit('add', [note.id]));
    await eventually(() => h.tasks.list()[0].status === 'done');
    assert.equal(h.tasks.list()[0].noteKey, note.key);
  });

  test('note modification removes a stale rule completion', async () => {
    const h = harness;
    const note = h.addNote();
    await h.generator.scanSkillGroup(h.group.id);
    h.generator.registerNotifier();
    note.getTags = () => [];
    await within(h.emit('modify', [note.id]));
    await eventually(() => h.tasks.list()[0].status === 'pending');
  });

  test('item-tag additions re-evaluate child-note tags', async () => {
    const h = harness;
    const note = h.addNote({ tags: [] });
    await h.generator.scanSkillGroup(h.group.id);
    h.generator.registerNotifier();
    note.getTags = () => [{ tag: '完成' }];
    await within(h.emit('add', [`${note.id}-30`], {}, 'item-tag'));
    await eventually(() => h.tasks.list()[0].status === 'done');
  });

  test('erased notes re-evaluate the saved parent even when the note no longer resolves', async () => {
    const h = harness;
    const note = h.addNote();
    await h.generator.scanSkillGroup(h.group.id);
    h.generator.registerNotifier();
    h.items.delete(note.id);
    await within(h.emit('delete', [note.id]));
    await eventually(() => h.tasks.list()[0].status === 'pending');
  });

  test('a submit awaiting a note notifier does not deadlock or duplicate its task', async () => {
    const h = harness;
    await h.generator.scanSkillGroup(h.group.id);
    h.generator.registerNotifier();
    const claim = await h.server.claim({ skillGroupId: h.group.id });
    const result = await within(h.server.submit({ taskId: claim.task.id, noteHtml: '<p>正常写入结果</p>' }));
    assert.equal(result.ok, true);
    assert.equal(h.createdNotes, 1);
    assert.equal(h.tasks.list().length, 1);
    assert.equal(h.tasks.list()[0].completionOrigin, 'agent');
  });
});
