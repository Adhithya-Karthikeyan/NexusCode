/**
 * Task-management types (system-spec §15). A task is the atomic unit of a plan:
 * it has a lifecycle `status`, may be a subtask of another task (`parentId`),
 * and may depend on other tasks (`deps`). Dependencies form a DAG — cycles are
 * rejected — which drives `readyTasks()`, topological ordering, and progress.
 *
 * Every task is stamped (`createdAt`/`updatedAt`) so the store is auditable, and
 * every mutation restamps `updatedAt`.
 */

/** Lifecycle state of a task. */
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";

/** The set of valid statuses, in canonical order. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

/** A single unit of work. Persisted verbatim. */
export interface Task {
  /** Stable identifier. Random unless an explicit `id` is supplied on create. */
  id: string;
  /** Human-readable summary of the work. */
  title: string;
  /** Lifecycle state. */
  status: TaskStatus;
  /** The parent task this is a subtask of, if any. */
  parentId?: string;
  /** Ids of tasks that must reach `done` before this task is ready. */
  deps: string[];
  /** Free-form notes (rationale, progress, links). */
  notes?: string;
  /** Epoch millis at creation. Never changes after the first write. */
  createdAt: number;
  /** Epoch millis of the last mutation. Restamped on every update. */
  updatedAt: number;
}

/** Fields accepted by {@link TaskStore.create}. */
export interface TaskInput {
  title: string;
  /** Initial status. Default: `"todo"`. */
  status?: TaskStatus;
  /** Parent task id (must exist). */
  parentId?: string;
  /** Initial dependency ids (each must exist; must not form a cycle). */
  deps?: string[];
  notes?: string;
  /** Provide to create with a known id (idempotent seeding); omit for a fresh id. */
  id?: string;
}

/** Mutable fields accepted by {@link TaskStore.update}. */
export interface TaskPatch {
  title?: string;
  status?: TaskStatus;
  /** Reparent the task. `null` detaches it (clears `parentId`). */
  parentId?: string | null;
  notes?: string | null;
}

/** Filter for {@link TaskStore.list}. All present clauses must match (AND). */
export interface TaskFilter {
  status?: TaskStatus;
  /** Direct children of this parent (use `null` for top-level tasks). */
  parentId?: string | null;
}

/** Progress snapshot for a plan or a subtree. */
export interface Progress {
  /** Total tasks counted. */
  total: number;
  /** Count per status. */
  counts: Record<TaskStatus, number>;
  /** Tasks in the `done` state. */
  done: number;
  /**
   * Percent complete (0–100, rounded). Denominator excludes `cancelled` tasks,
   * so cancelling work does not depress the score. `0` when nothing is countable.
   */
  percent: number;
}
