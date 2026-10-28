/** Runtime regression tests for panel paging and activity aggregation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformSync } from 'esbuild';

const source = readFileSync(resolve('src/taskInsights.ts'), 'utf8');
const js = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
const { paginateTasks, summarizeTaskActivity, TaskQueryIndex } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);
const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime();
const now = at(2026, 10, 28);

const completed = Array.from({ length: 55 }, (_, i) => ({
  id: 'd' + i, skillGroupId: 'alpha', itemKey: 'ITEM-' + i,
  status: 'done', createdAt: at(2026, 9, 1),
  completedAt: at(2026, 10, 1) + i * 60000,
}));
const other = [
  { id: 'p', skillGroupId: 'alpha', itemKey: 'OTHER', status: 'pending', createdAt: now, completedAt: null },
  { id: 'x', skillGroupId: 'beta', itemKey: 'OTHER', status: 'pending', createdAt: now, completedAt: null },
];
const all = [...completed, ...other];
const filter = { skillGroupId: 'alpha', status: 'done' };

const first = paginateTasks(all, filter);
assert.equal(first.total, 55);
assert.equal(first.items.length, 20);
assert.equal(first.items[0].id, 'd54', 'latest completion comes first');
assert.equal(first.items[19].id, 'd35');
assert.notEqual(first.items[0], completed[54], 'returned records must be copies');
assert.deepEqual(paginateTasks(all, filter, { offset: 20, limit: 20 }).items.map(t => t.id),
  Array.from({ length: 20 }, (_, i) => 'd' + (34 - i)));
assert.equal(paginateTasks(all, filter, { offset: 40, limit: 20 }).items.length, 15);
assert.equal(paginateTasks(all, filter, { offset: 60, limit: 20 }).items.length, 0);
assert.equal(paginateTasks(all, filter, { offset: 0, limit: 0 }).total, 55);
assert.equal(paginateTasks(all, { status: 'pending' }, { itemKeyContains: 'other' }).total, 2);
assert.equal(paginateTasks(all, { skillGroupId: 'alpha', status: 'pending' }).total, 1);
assert.equal(paginateTasks(all, filter, { limit: 10000 }).items.length, 55);


// A new completion is inserted in front while page one is on screen.
// Keyset pagination must not repeat the last visible task or skip the next.
const oldIndex = new TaskQueryIndex(all);
const oldFirst = oldIndex.page(filter);
const newlyCompleted = {
  id: 'newest', skillGroupId: 'alpha', itemKey: 'NEW',
  status: 'done', createdAt: now, completedAt: now,
};
const changedIndex = new TaskQueryIndex([newlyCompleted, ...all]);
const afterInsert = changedIndex.page(filter, {
  after: oldFirst.nextCursor, limit: 20,
});
assert.deepEqual(afterInsert.items.map(t => t.id),
  Array.from({ length: 20 }, (_, i) => 'd' + (34 - i)),
  'newly completed task must not move the cursor window');

// Same-millisecond events must have deterministic id tie breaks.
const tieTasks = ['a', 'b', 'c'].map(id => ({
  id, skillGroupId: 'alpha', itemKey: id, status: 'done',
  createdAt: now, completedAt: now,
}));
const tied = new TaskQueryIndex(tieTasks);
const tieFirst = tied.page(filter, { limit: 1 });
assert.equal(tieFirst.items[0].id, 'a');
assert.equal(tied.page(filter, { after: tieFirst.nextCursor, limit: 1 }).items[0].id, 'b');
assert.equal(tied.page(filter, { after: { sortAt: now, createdAt: now, id: 'b' }, limit: 1 }).items[0].id, 'c');

// Large-data smoke test: build index with exactly one source pass and reuse it
// across status counts, full-text searches, and hundreds of independent pages.
let sourcePasses = 0;
const largeItems = Array.from({ length: 50000 }, (_, i) => ({
  id: 'large-' + String(i).padStart(5, '0'),
  skillGroupId: 'group-' + (i % 10), itemKey: 'ITEM-' + i,
  status: i % 4 === 0 ? 'done' : 'pending',
  createdAt: now - i * 1000,
  completedAt: i % 4 === 0 ? now - i * 500 : null,
}));
const countingSource = {
  *[Symbol.iterator]() {
    sourcePasses++;
    yield* largeItems;
  },
};
const largeIndex = new TaskQueryIndex(countingSource);
assert.equal(sourcePasses, 1);
for (let i = 0; i < 300; i++) {
  const filterLarge = { skillGroupId: 'group-' + (i % 10), status: i % 4 === 0 ? 'done' : 'pending' };
  const page = largeIndex.page(filterLarge, { limit: 20 });
  assert.ok(page.items.length <= 20);
  assert.ok(largeIndex.countsBySkill(filterLarge.skillGroupId).pending >= 0);
}
assert.equal(sourcePasses, 1, 'indexed page queries must not rescan the underlying source');
assert.equal(largeIndex.page({ skillGroupId: 'group-0', status: 'done' }, { limit: 0 }).total, 2500);
assert.equal(largeIndex.page({ skillGroupId: 'group-1', status: 'done' }, { limit: 0 }).total, 0);
assert.equal(largeIndex.page({ skillGroupId: 'group-1', status: 'pending' }, {
  itemKeyContains: 'item-1', limit: 0,
}).items.length, 0);
assert.ok(largeIndex.page({ skillGroupId: 'group-1', status: 'pending' }, {
  itemKeyContains: 'item-1', limit: 0,
}).total > 0);

const tasks = [
  { id: 'a', skillGroupId: 'alpha', status: 'done', itemKey: 'A',
    createdAt: at(2026, 10, 27), completedAt: at(2026, 10, 28) },
  { id: 'b', skillGroupId: 'alpha', status: 'pending', itemKey: 'B',
    createdAt: at(2026, 10, 28), completedAt: null },
  { id: 'c', skillGroupId: 'beta', status: 'done', itemKey: 'C',
    createdAt: at(2026, 9, 15), completedAt: at(2026, 10, 1) },
  { id: 'd', skillGroupId: 'beta', status: 'cancelled', itemKey: 'D',
    createdAt: at(2025, 10, 1), completedAt: null },
];
const stats = summarizeTaskActivity(tasks, now);
assert.equal(stats.total, 4);
assert.equal(stats.daily.length, 365);
assert.equal(stats.monthly.length, 12);
assert.equal(stats.daily.at(-1).key, '2026-10-28');
assert.equal(stats.daily.at(-1).added, 1);
assert.equal(stats.daily.at(-1).completed, 1);
assert.equal(stats.daily.at(-2).added, 1);
assert.equal(stats.monthly.at(-1).added, 2);
assert.equal(stats.monthly.at(-1).completed, 2);
assert.equal(stats.statusCounts.done, 2);
assert.equal(stats.statusCounts.cancelled, 1);
assert.deepEqual(stats.bySkill.find(s => s.skillGroupId === 'alpha'),
  { skillGroupId: 'alpha', total: 2, done: 1, added30: 2, completed30: 1 });
assert.deepEqual(stats.bySkill.find(s => s.skillGroupId === 'beta'),
  { skillGroupId: 'beta', total: 2, done: 1, added30: 0, completed30: 1 });
assert.equal(stats.daily.some(d => d.key === '2025-10-01' && d.added > 0), false);

console.log('✓ Task paging and activity aggregation passed');
