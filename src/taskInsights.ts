/**
 * Pure task-list queries and activity aggregation. No Zotero dependencies.
 * Only page-sized shallow copies leave the task store for the panel.
 */
import type {
  Task, TaskActivity, TaskActivityBucket, TaskActivityBySkill,
  TaskCursor, TaskFilter, TaskPage, TaskPageOptions, TaskStatus,
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

/** Sort by completion/creation descending and resolve timestamp ties by id. */
function compareTasks(a: Task, b: Task): number {
  return taskTimestamp(b) - taskTimestamp(a) ||
    b.createdAt - a.createdAt ||
    a.id.localeCompare(b.id);
}

function cursorFor(task: Task): TaskCursor {
  return { sortAt: taskTimestamp(task), createdAt: task.createdAt, id: task.id };
}

/** Returns > 0 only for an entry strictly after the supplied cursor. */
function compareWithCursor(task: Task, after: TaskCursor): number {
  return after.sortAt - taskTimestamp(task) ||
    after.createdAt - task.createdAt ||
    task.id.localeCompare(after.id);
}

/**
 * Read-only per-snapshot indexes. Build once for all groups and statuses, rather
 * than scanning/sorting the full task set for each status panel and every page.
 * A search scans only the relevant pre-sorted group, without sorting again.
 */
export class TaskQueryIndex {
  private readonly grouped = new Map<string, Map<TaskStatus, Task[]>>();
  private readonly counts = new Map<string, Record<TaskStatus, number>>();
  private readonly allSorted: Task[];

  constructor(source: Iterable<Task>) {
    this.allSorted = [];
    for (const task of source) {
      this.allSorted.push(task);
      let statuses = this.grouped.get(task.skillGroupId);
      if (!statuses) {
        statuses = new Map();
        this.grouped.set(task.skillGroupId, statuses);
        this.counts.set(
          task.skillGroupId,
          Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<TaskStatus, number>
        );
      }
      let items = statuses.get(task.status);
      if (!items) {
        items = [];
        statuses.set(task.status, items);
      }
      items.push(task);
      const counts = this.counts.get(task.skillGroupId)!;
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    for (const byStatus of this.grouped.values()) {
      for (const items of byStatus.values()) items.sort(compareTasks);
    }
    // General multi-group filters are supported, but the panel only asks for
    // indexed exact skill+status pairs, which avoid this global sort.
    this.allSorted.sort(compareTasks);
  }

  countsBySkill(skillGroupId: string): Record<TaskStatus, number> {
    const counts = this.counts.get(skillGroupId);
    return Object.fromEntries(STATUSES.map(s => [s, counts?.[s] ?? 0])) as Record<TaskStatus, number>;
  }

  page(filter: TaskFilter = {}, options: TaskPageOptions = {}): TaskPage {
    const statuses = filter.status === undefined
      ? undefined
      : Array.isArray(filter.status) ? filter.status : [filter.status];
    let sorted: Task[];
    if (filter.skillGroupId !== undefined && statuses?.length === 1) {
      sorted = this.grouped.get(filter.skillGroupId)?.get(statuses[0]) ?? [];
    } else if (filter.skillGroupId !== undefined) {
      const byStatus = this.grouped.get(filter.skillGroupId);
      sorted = (statuses ?? STATUSES).flatMap(status => byStatus?.get(status) ?? [])
        .sort(compareTasks);
    } else if (statuses) {
      const allowed = new Set(statuses);
      sorted = this.allSorted.filter(task => allowed.has(task.status));
    } else {
      sorted = this.allSorted;
    }

    const query = (options.itemKeyContains ?? '').trim().toLowerCase();
    if (query) sorted = sorted.filter(task => task.itemKey.toLowerCase().includes(query));
    const total = sorted.length;
    const limit = Number.isSafeInteger(options.limit) && (options.limit ?? 20) >= 0
      ? options.limit! : 20;
    const offset = Number.isSafeInteger(options.offset) && (options.offset ?? 0) >= 0
      ? options.offset! : 0;

    // Keyset lookup is O(log n) over a sorted group and does not shift when
    // a newer completed task is inserted ahead of the visible page.
    let start = offset;
    if (options.after) {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareWithCursor(sorted[mid], options.after) <= 0) lo = mid + 1;
        else hi = mid;
      }
      start = lo;
    }
    const selected = sorted.slice(start, start + limit);
    const last = selected[selected.length - 1];
    return {
      total,
      items: selected.map(task => ({ ...task })),
      nextCursor: last && start + selected.length < total ? cursorFor(last) : null,
    };
  }
}

/** Convenience pure function, suitable for tests or one-shot callers. */
export function paginateTasks(
  source: Iterable<Task>,
  filter: TaskFilter = {},
  options: TaskPageOptions = {},
): TaskPage {
  return new TaskQueryIndex(source).page(filter, options);
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

  const statusCounts = Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<TaskStatus, number>;
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
