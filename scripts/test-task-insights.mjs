/** Runtime regression tests for panel paging and activity aggregation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transformSync } from 'esbuild';

const source = readFileSync(resolve('src/taskInsights.ts'), 'utf8');
const js = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
const { paginateTasks, summarizeTaskActivity } = await import(
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
