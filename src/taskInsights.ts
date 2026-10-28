/**
 * Pure task-list queries and activity aggregation. No Zotero dependencies.
 * Only page-sized shallow copies leave the task store for the panel.
 */
import type {
  Task, TaskActivity, TaskActivityBucket, TaskActivityBySkill,
  TaskFilter, TaskPage, TaskPageOptions, TaskStatus,
} from './types';

const STATUSES: TaskStatus[] = [
  'waiting-material', 'pending', 'claimed', 'done', 'failed', 'cancelled',
];

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localMonthKey(timestamp: number): string {
  return localDateKey(timestamp).slice(0, 7);
}

function validTimestamp(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function taskTimestamp(task: Task): number {
  return task.status === 'done' && validTimestamp(task.completedAt)
    ? task.completedAt
    : task.createdAt;
}

/** Most recently completed tasks first; others by creation time, newest first. */
export function paginateTasks(
  source: Iterable<Task>,
  filter: TaskFilter = {},
  options: TaskPageOptions = {},
): TaskPage {
  const offset = Number.isSafeInteger(options.offset) && (options.offset ?? 0) > 0
    ? options.offset! : 0;
  const limit = Number.isSafeInteger(options.limit) && (options.limit ?? 20) >= 0
    ? Math.min(options.limit!, 200) : 20;
  const query = (options.itemKeyContains ?? '').trim().toLowerCase();
  const statuses = filter.status === undefined
    ? undefined
    : new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
  const matching: Task[] = [];
  for (const task of source) {
    if (filter.skillGroupId !== undefined && task.skillGroupId !== filter.skillGroupId) continue;
    if (statuses && !statuses.has(task.status)) continue;
    if (query && !task.itemKey.toLowerCase().includes(query)) continue;
    matching.push(task);
  }
  matching.sort((a, b) =>
    taskTimestamp(b) - taskTimestamp(a) ||
    b.createdAt - a.createdAt ||
    a.id.localeCompare(b.id)
  );
  return {
    total: matching.length,
    items: matching.slice(offset, offset + limit).map(task => ({ ...task })),
  };
}

function emptyBucket(key: string): TaskActivityBucket {
  return { key, added: 0, completed: 0 };
}

/**
 * Calendar-day aggregation in the Zotero client's local timezone.
 * "Added" and "completed" are independent events (not a cohort conversion rate).
 */
export function summarizeTaskActivity(
  source: Iterable<Task>,
  now: number = Date.now(),
): TaskActivity {
  const today = new Date(now);
  const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const last30Start = new Date(
    anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 29
  ).getTime();

  const daily: TaskActivityBucket[] = [];
  const monthly: TaskActivityBucket[] = [];
  const dayMap = new Map<string, TaskActivityBucket>();
  const monthMap = new Map<string, TaskActivityBucket>();
  for (let i = 364; i >= 0; i--) {
    const key = localDateKey(new Date(
      anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - i
    ).getTime());
    const bucket = emptyBucket(key);
    daily.push(bucket);
    dayMap.set(key, bucket);
  }
  for (let i = 11; i >= 0; i--) {
    const key = localMonthKey(new Date(
      anchor.getFullYear(), anchor.getMonth() - i, 1
    ).getTime());
    const bucket = emptyBucket(key);
    monthly.push(bucket);
    monthMap.set(key, bucket);
  }

  const statusCounts = Object.fromEntries(STATUSES.map(s => [s, 0]))
    as Record<TaskStatus, number>;
  const bySkill = new Map<string, TaskActivityBySkill>();
  let total = 0;
  for (const task of source) {
    total++;
    statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
    let skill = bySkill.get(task.skillGroupId);
    if (!skill) {
      skill = { skillGroupId: task.skillGroupId, total: 0, done: 0, added30: 0, completed30: 0 };
      bySkill.set(task.skillGroupId, skill);
    }
    skill.total++;
    if (task.status === 'done') skill.done++;
    if (validTimestamp(task.createdAt)) {
      const day = localDateKey(task.createdAt);
      const month = localMonthKey(task.createdAt);
      const dayBucket = dayMap.get(day);
      const monthBucket = monthMap.get(month);
      if (dayBucket) dayBucket.added++;
      if (monthBucket) monthBucket.added++;
      if (task.createdAt >= last30Start && task.createdAt <= now) skill.added30++;
    }
    if (task.status === 'done' && validTimestamp(task.completedAt)) {
      const day = localDateKey(task.completedAt);
      const month = localMonthKey(task.completedAt);
      const dayBucket = dayMap.get(day);
      const monthBucket = monthMap.get(month);
      if (dayBucket) dayBucket.completed++;
      if (monthBucket) monthBucket.completed++;
      if (task.completedAt >= last30Start && task.completedAt <= now) skill.completed30++;
    }
  }

  return {
    daily, monthly, total, statusCounts,
    bySkill: Array.from(bySkill.values()).sort((a, b) => b.total - a.total),
  };
}
