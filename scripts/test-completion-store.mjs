/** Runtime tests for completion origins, reopening, leases and library identity. */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'completion-store-'));
const bundle = join(temp, 'store.mjs');
await build({
  entryPoints: [join(root, 'src/taskStore.ts')], bundle: true, format: 'esm',
  outfile: bundle, logLevel: 'error', define: { __SKILLTASK_ENV__: '"production"' },
});
let records = [];
let now = 1_800_000_000_000;
let writes = 0;
const originalDateNow = Date.now;
Date.now = () => now;
globalThis.Zotero = {
  DataDirectory: { dir: '/zotero' }, Libraries: { userLibraryID: 1 },
  debug() {}, logError() {}, Prefs: { get() { return undefined; } },
};
globalThis.PathUtils = { join };
globalThis.IOUtils = {
  async makeDirectory() {}, async exists() { return true; },
  async readJSON() { return structuredClone(records); },
  async writeJSON(_path, value) { records = structuredClone(value); writes++; },
};
const { TaskStore } = await import(pathToFileURL(bundle).href);
const data = (itemKey = 'ITEM', libraryID = 1) => ({
  skillGroupId: 'skill', skillGroupVersion: 1, instructionSnapshot: 'Do the task',
  itemKey, libraryID,
});
const note = (noteKey = 'NOTE') => ({
  noteKey, deliverableType: 'note', deliverableRef: noteKey,
  completionOrigin: 'existing-note', completionRuleVersion: 2,
});
const rule = () => ({
  enabled: true, type: 'builtin-note',
  match: { operator: 'all', conditions: [{ field: 'tag', operator: 'equals', value: 'ready' }] },
});

beforeEach(() => { records = []; writes = 0; now = 1_800_000_000_000; });
after(() => { Date.now = originalDateNow; rmSync(temp, { recursive: true, force: true }); });

describe('completion origins and persistence', () => {
  test('newly recognized notes and attachments have zero actual submissions', async () => {
    const store = await TaskStore.load();
    const existing = await store.createCompleted(data(), note());
    assert.equal(existing.status, 'done');
    assert.equal(existing.completionOrigin, 'existing-note');
    assert.equal(existing.submissionCount, 0);
    const attachment = await store.createCompleted(data('FILE'), {
      noteKey: null, deliverableType: 'file', deliverableRef: 'result.pdf',
      completionOrigin: 'existing-attachment', attachmentKey: 'ATTACH',
    });
    assert.equal(attachment.submissionCount, 0);
    const restored = await TaskStore.load();
    assert.equal(restored.get(existing.id).submissionCount, 0);
    assert.equal(restored.get(existing.id).completionOrigin, 'existing-note');
    assert.equal(restored.countsBySkill('skill').done, 2);
    assert.equal(restored.listPage({ status: 'done' }).total, 2);
    assert.equal(restored.activityStats(now).daily.at(-1).completed, 0);
  });

  test('legacy completion counts are preserved and missing origin defaults to agent', async () => {
    records = [
      { id: 'old', skillGroupId: 'skill', itemKey: 'ITEM', status: 'done', completedAt: now },
      { id: 'old-count', skillGroupId: 'skill', itemKey: 'COUNT', status: 'done', submissionCount: 4 },
      { id: 'recognized', skillGroupId: 'skill', itemKey: 'OTHER', status: 'done', completionOrigin: 'existing-note' },
    ];
    const store = await TaskStore.load();
    assert.equal(store.get('old').completionOrigin, 'agent');
    assert.equal(store.get('old').submissionCount, 1);
    assert.equal(store.get('old-count').submissionCount, 4);
    assert.equal(store.get('recognized').submissionCount, 0);
    assert.equal(store.activityStats(now).daily.at(-1).completed, 1);
  });

  test('recognition refreshes references and rule version without creating a second completion', async () => {
    const store = await TaskStore.load();
    const pending = await store.create(data());
    const first = await store.recognizeExistingNote(pending.id, note());
    now += 1000;
    const next = await store.recognizeExistingNote(pending.id, { ...note('REPLACEMENT'), completionRuleVersion: 3 });
    assert.equal(next.noteKey, 'REPLACEMENT');
    assert.equal(next.completedAt, first.completedAt);
    assert.equal(next.completionCheckedAt, now);
    assert.equal(next.completionRuleVersion, 3);
    assert.equal(next.submissionCount, 0);
    assert.equal(store.list().length, 1);
    assert.equal(store.activityStats(now).daily.at(-1).completed, 0);
    assert.ok(writes >= 3);
  });

  test('actual submission is idempotent, and the first revision of a recognized note counts once', async () => {
    const store = await TaskStore.load();
    const recognized = await store.createCompleted(data(), note());
    now += 5000;
    const result = { noteKey: 'NOTE', deliverableType: 'note', deliverableRef: 'NOTE' };
    const actual = await store.reviseComplete(recognized.id, result);
    assert.equal(actual.completionOrigin, 'agent');
    assert.equal(actual.submissionCount, 1);
    assert.equal(actual.completedAt, now);
    const revised = await store.reviseComplete(actual.id, result);
    assert.equal(revised.submissionCount, 2);
    const duplicate = await store.complete(actual.id, { ...result, noteKey: 'BAD', deliverableRef: 'BAD' });
    assert.equal(duplicate.noteKey, 'NOTE');
    assert.equal(duplicate.submissionCount, 2);
    assert.equal(await store.reopenExistingCompletion(actual.id, 'pending'), null);
    assert.equal(await store.recognizeExistingNote(actual.id, note('OTHER')), null);
  });
});

describe('recognition and task state', () => {
  test('pending, material-waiting and failed tasks can reuse an existing note', async () => {
    const store = await TaskStore.load();
    for (const status of ['pending', 'waiting-material', 'failed']) {
      const task = await store.create({ ...data(status), status: status === 'failed' ? 'pending' : status });
      if (status === 'failed') await store.fail(task.id, 'prior execution failed');
      const result = await store.recognizeExistingNote(task.id, note());
      assert.equal(result.status, 'done');
      assert.equal(result.submissionCount, 0);
      assert.equal(result.lastError, null);
    }
  });

  test('scanning never steals a lease; explicit submit recognition requires a live lease', async () => {
    const store = await TaskStore.load();
    const task = await store.create(data());
    await store.claimById(task.id, 1000);
    assert.equal(await store.recognizeExistingNote(task.id, note()), null);
    assert.equal(store.get(task.id).status, 'claimed');
    const result = await store.recognizeExistingNote(task.id, note(), true);
    assert.equal(result.status, 'done');
    assert.equal(result.leaseExpiresAt, null);
    const expiring = await store.create(data('EXPIRED'));
    await store.claimById(expiring.id, 1000);
    now += 1001;
    assert.equal(await store.recognizeExistingNote(expiring.id, note(), true), null);
  });

  test('cancelled tasks cannot be recognized, reopened or completed', async () => {
    const store = await TaskStore.load();
    const task = await store.create(data());
    await store.cancel(task.id);
    assert.equal(await store.recognizeExistingNote(task.id, note(), true), null);
    assert.equal(await store.reopenExistingCompletion(task.id, 'pending'), null);
    await assert.rejects(store.complete(task.id, note()), /取消/);
    assert.equal(store.get(task.id).status, 'cancelled');
  });

  test('reopening clears result and lease fields while preserving the task identity', async () => {
    const store = await TaskStore.load();
    const recognized = await store.createCompleted(data(), note());
    const reopened = await store.reopenExistingCompletion(recognized.id, 'waiting-material');
    assert.equal(reopened.id, recognized.id);
    assert.equal(reopened.status, 'waiting-material');
    for (const field of ['noteKey', 'deliverableRef', 'deliverableType', 'attachmentKey', 'leaseExpiresAt', 'claimedAt', 'completedAt', 'lastError']) {
      assert.equal(reopened[field], null, field);
    }
    assert.equal(reopened.completionOrigin, undefined);
    assert.equal(reopened.completionRuleVersion, undefined);
    assert.equal(reopened.submissionCount, 0);
    assert.equal(await store.reopenExistingCompletion(reopened.id, 'pending'), null);
  });

  test('claim and recognition use state changes before persistence to avoid stealing work', async () => {
    const store = await TaskStore.load();
    const first = await store.create(data('FIRST'));
    const [recognized, claimed] = await Promise.all([
      store.recognizeExistingNote(first.id, note()), store.claimById(first.id, 1000),
    ]);
    assert.equal(recognized.status, 'done');
    assert.equal(claimed, null);
    const second = await store.create(data('SECOND'));
    const [claimedFirst, notRecognized] = await Promise.all([
      store.claimById(second.id, 1000), store.recognizeExistingNote(second.id, note()),
    ]);
    assert.equal(claimedFirst.status, 'claimed');
    assert.equal(notRecognized, null);
  });

  test('check failures do not change task state or erase unrelated failures', async () => {
    const store = await TaskStore.load();
    const task = await store.create(data());
    const errored = await store.recordCompletionCheckError(task.id, 'note loading failed');
    assert.equal(errored.status, 'pending');
    assert.match(errored.lastError, /^completion-check:/);
    const cleared = await store.recordCompletionCheckError(task.id, null);
    assert.equal(cleared.lastError, null);
    await store.fail(task.id, 'execution failed');
    await store.recordCompletionCheckError(task.id, 'note loading failed');
    await store.recordCompletionCheckError(task.id, null);
    assert.equal(store.get(task.id).lastError, 'execution failed');
    assert.equal(store.get(task.id).status, 'failed');
  });
});

describe('library and claimed-rule isolation', () => {
  test('equal item keys in separate libraries do not share tasks', async () => {
    const store = await TaskStore.load();
    const personal = await store.create(data('SAME', 1));
    const group = await store.create(data('SAME', 2));
    assert.equal(store.findActiveBySkillAndItem('skill', 'SAME', 1).id, personal.id);
    assert.equal(store.findActiveBySkillAndItem('skill', 'SAME', 2).id, group.id);
    assert.equal(store.findLatestBySkillAndItem('skill', 'SAME', 3), undefined);
    assert.equal((await TaskStore.load()).get(group.id).libraryID, 2);
  });

  test('legacy tasks belong only to the personal library', async () => {
    records = [{ id: 'legacy', skillGroupId: 'skill', itemKey: 'SAME', status: 'pending' }];
    const store = await TaskStore.load();
    assert.equal(store.findActiveBySkillAndItem('skill', 'SAME', 1).id, 'legacy');
    assert.equal(store.findActiveBySkillAndItem('skill', 'SAME', 2), undefined);
    assert.equal(store.findLatestBySkillAndItem('skill', 'SAME', 2), undefined);
  });

  test('claim freezes current instruction and an independent copy of the rule', async () => {
    const store = await TaskStore.load();
    const task = await store.create(data());
    const configured = rule();
    const claimed = await store.claimById(task.id, 1000, {
      skillGroupVersion: 5, instructionSnapshot: 'Updated', completionRuleSnapshot: configured,
    });
    configured.match.conditions[0].value = 'changed after claim';
    claimed.completionRuleSnapshot.match.conditions[0].value = 'changed returned task';
    store.get(task.id).completionRuleSnapshot.match.conditions[0].value = 'changed get';
    store.list()[0].completionRuleSnapshot.match.conditions[0].value = 'changed list';
    store.listPage().items[0].completionRuleSnapshot.match.conditions[0].value = 'changed page';
    const saved = (await TaskStore.load()).get(task.id);
    assert.equal(store.get(task.id).completionRuleSnapshot.match.conditions[0].value, 'ready');
    assert.equal(saved.completionRuleSnapshot.match.conditions[0].value, 'ready');
    assert.equal(saved.skillGroupVersion, 5);
    assert.equal(saved.instructionSnapshot, 'Updated');
    await store.releaseLease(task.id);
    const disabled = await store.claimById(task.id, 1000, {
      skillGroupVersion: 6, instructionSnapshot: 'No rule', completionRuleSnapshot: null,
    });
    assert.equal(disabled.completionRuleSnapshot, null);
  });
});
