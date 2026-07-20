/**
 * TaskStore — task management for plans (system-spec §15).
 *
 * One clean API over an in-memory task table that persists to a single JSON
 * file under the data dir, written atomically (temp file + rename) with 0600
 * perms. Pass `file: ":memory:"` to disable disk entirely (tests).
 *
 * Tasks form two overlapping structures:
 *  - a *tree* via `parentId` (task → subtasks), used by `progress()` subtrees;
 *  - a *DAG* via `deps` (task depends on other tasks), used by `readyTasks()`
 *    and `topoOrder()`. Adding a dependency that would close a cycle is
 *    rejected, so the dependency graph is always acyclic.
 *
 * Every mutation restamps `updatedAt`, so the durable file is an auditable
 * record of what changed and when.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { tasksFile } from "./paths.js";
import { TASK_STATUSES } from "./types.js";
import type { Progress, Task, TaskFilter, TaskInput, TaskPatch, TaskStatus } from "./types.js";

/** Persisted on-disk shape. */
interface TaskFileShape {
  version: 1;
  tasks: Task[];
}

export interface TaskStoreOptions {
  /** Explicit data directory (overrides `NEXUS_DATA_DIR` and the default). */
  dir?: string;
  /** Explicit persistence file path (overrides `dir`). Use ":memory:" to disable disk. */
  file?: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Environment for path/env resolution (tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The task-management API. Construct via {@link openTasks}.
 */
export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly filePath: string | null;
  private readonly now: () => number;

  constructor(opts: TaskStoreOptions = {}) {
    this.filePath =
      opts.file === ":memory:"
        ? null
        : (opts.file ?? tasksFile(opts.dir, opts.env ?? process.env));
    this.now = opts.now ?? Date.now;
    this.load();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /** Fetch by id. Returns a defensive copy. */
  get(id: string): Task | undefined {
    const t = this.tasks.get(id);
    return t ? clone(t) : undefined;
  }

  /**
   * Create a task. Validates `parentId` and every `deps` id exists, and that no
   * supplied dependency would close a cycle. Throws on any violation.
   */
  create(input: TaskInput): Task {
    const ts = this.now();
    const id = input.id ?? `task_${randomUUID()}`;
    if (this.tasks.has(id)) throw new Error(`tasks: id "${id}" already exists`);
    if (input.status !== undefined) assertStatus(input.status);

    if (input.parentId !== undefined) this.requireExists(input.parentId, "parent");

    const deps: string[] = [];
    const task: Task = {
      id,
      title: input.title,
      status: input.status ?? "todo",
      deps,
      createdAt: ts,
      updatedAt: ts,
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    this.tasks.set(id, task);

    // Add dependencies through the guarded path so cycles are caught.
    if (input.deps) {
      for (const dep of input.deps) {
        try {
          this.addDependency(id, dep, { persist: false });
        } catch (err) {
          this.tasks.delete(id); // roll back the partial task
          throw err;
        }
      }
    }

    this.save();
    return clone(task);
  }

  /**
   * Create a task as a subtask of `parentId`. Convenience over
   * {@link create} with the `parentId` bound.
   */
  addSubtask(parentId: string, input: Omit<TaskInput, "parentId">): Task {
    this.requireExists(parentId, "parent");
    return this.create({ ...input, parentId });
  }

  /** Patch mutable fields and restamp `updatedAt`. Returns the updated task. */
  update(id: string, patch: TaskPatch): Task {
    const cur = this.requireExists(id, "task");
    if (patch.status !== undefined) assertStatus(patch.status);

    let parentId = cur.parentId;
    if (patch.parentId !== undefined) {
      if (patch.parentId === null) {
        parentId = undefined;
      } else {
        this.requireExists(patch.parentId, "parent");
        if (this.wouldCloseParentCycle(id, patch.parentId)) {
          throw new Error(`tasks: reparenting "${id}" under "${patch.parentId}" forms a cycle`);
        }
        parentId = patch.parentId;
      }
    }

    let notes = cur.notes;
    if (patch.notes !== undefined) notes = patch.notes === null ? undefined : patch.notes;

    const next: Task = {
      ...cur,
      deps: [...cur.deps],
      updatedAt: this.now(),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(notes !== undefined ? { notes } : {}),
    };
    // Deleting keys the spread cannot clear when the source is `undefined`.
    if (parentId === undefined) delete next.parentId;
    if (notes === undefined) delete next.notes;

    this.tasks.set(id, next);
    this.save();
    return clone(next);
  }

  /**
   * Delete a task. Also detaches it as a dependency of any other task and
   * detaches its direct children (their `parentId` is cleared). Returns whether
   * a task was removed.
   */
  delete(id: string): boolean {
    if (!this.tasks.has(id)) return false;
    this.tasks.delete(id);
    for (const t of this.tasks.values()) {
      if (t.deps.includes(id)) t.deps = t.deps.filter((d) => d !== id);
      if (t.parentId === id) delete t.parentId;
    }
    this.save();
    return true;
  }

  /** List tasks matching a filter, oldest-first (stable, auditable order). */
  list(filter: TaskFilter = {}): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (filter.status !== undefined && t.status !== filter.status) continue;
      if (filter.parentId !== undefined) {
        const want = filter.parentId === null ? undefined : filter.parentId;
        if (t.parentId !== want) continue;
      }
      out.push(clone(t));
    }
    out.sort(byCreatedThenId);
    return out;
  }

  // ── Dependency graph ────────────────────────────────────────────────────────

  /**
   * Record that `taskId` depends on `dependsOnId` (the latter must reach `done`
   * before the former is ready). Rejects self-dependencies and any edge that
   * would close a cycle. Idempotent for an already-present edge.
   */
  addDependency(taskId: string, dependsOnId: string, opts: { persist?: boolean } = {}): void {
    const task = this.requireExists(taskId, "task");
    this.requireExists(dependsOnId, "dependency");
    if (taskId === dependsOnId) throw new Error(`tasks: "${taskId}" cannot depend on itself`);
    if (task.deps.includes(dependsOnId)) return; // already present, no-op

    // A cycle would form iff `dependsOnId` already (transitively) depends on
    // `taskId` — adding task→dependsOn would then close the loop.
    if (this.dependsOnTransitively(dependsOnId, taskId)) {
      throw new Error(
        `tasks: adding dependency "${taskId}" → "${dependsOnId}" forms a cycle`,
      );
    }

    task.deps = [...task.deps, dependsOnId];
    task.updatedAt = this.now();
    if (opts.persist !== false) this.save();
  }

  /** Remove a dependency edge. Returns whether one was removed. */
  removeDependency(taskId: string, dependsOnId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !task.deps.includes(dependsOnId)) return false;
    task.deps = task.deps.filter((d) => d !== dependsOnId);
    task.updatedAt = this.now();
    this.save();
    return true;
  }

  /**
   * Tasks that are actionable now: status `"todo"` and every dependency `done`.
   * Oldest-first. Missing dependency ids are treated as unmet (never `done`).
   */
  readyTasks(): Task[] {
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== "todo") continue;
      const ready = t.deps.every((d) => this.tasks.get(d)?.status === "done");
      if (ready) out.push(clone(t));
    }
    out.sort(byCreatedThenId);
    return out;
  }

  /**
   * All tasks in dependency (topological) order: a task always appears after
   * every task it depends on. Ties within a rank break by createdAt then id, so
   * the order is deterministic. Throws if the graph contains a cycle (it never
   * should, since {@link addDependency} prevents them — this is a defensive
   * guard against a hand-edited file).
   */
  topoOrder(): Task[] {
    const ids = [...this.tasks.keys()];
    const indegree = new Map<string, number>();
    // edge: dep → task (dep must precede task); indegree counts a task's deps.
    for (const id of ids) {
      const t = this.tasks.get(id) as Task;
      indegree.set(id, t.deps.filter((d) => this.tasks.has(d)).length);
    }

    const ordered: Task[] = [];
    const ready = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
    ready.sort((a, b) => byCreatedThenId(this.tasks.get(a) as Task, this.tasks.get(b) as Task));

    while (ready.length > 0) {
      const id = ready.shift() as string;
      ordered.push(clone(this.tasks.get(id) as Task));
      // Any task that depended on `id` loses one indegree.
      const freed: string[] = [];
      for (const other of ids) {
        const t = this.tasks.get(other) as Task;
        if (t.deps.includes(id)) {
          const d = (indegree.get(other) ?? 0) - 1;
          indegree.set(other, d);
          if (d === 0) freed.push(other);
        }
      }
      if (freed.length > 0) {
        freed.sort((a, b) =>
          byCreatedThenId(this.tasks.get(a) as Task, this.tasks.get(b) as Task),
        );
        ready.push(...freed);
        ready.sort((a, b) =>
          byCreatedThenId(this.tasks.get(a) as Task, this.tasks.get(b) as Task),
        );
      }
    }

    if (ordered.length !== ids.length) {
      throw new Error("tasks: dependency graph contains a cycle");
    }
    return ordered;
  }

  // ── Progress ────────────────────────────────────────────────────────────────

  /**
   * Progress snapshot. With no argument, counts every task in the store. With a
   * `rootId`, counts that task plus all of its descendants (the subtree defined
   * by `parentId`), so a plan's progress is just `progress(planRootId)`.
   */
  progress(rootId?: string): Progress {
    const tasks = rootId === undefined ? [...this.tasks.values()] : this.subtree(rootId);
    const counts: Record<TaskStatus, number> = {
      todo: 0,
      in_progress: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
    };
    for (const t of tasks) counts[t.status] += 1;

    const total = tasks.length;
    const done = counts.done;
    const countable = total - counts.cancelled;
    const percent = countable <= 0 ? 0 : Math.round((done / countable) * 100);
    return { total, counts, done, percent };
  }

  /** The subtree rooted at `id` (inclusive), gathered over `parentId` edges. */
  subtree(id: string): Task[] {
    this.requireExists(id, "task");
    const children = new Map<string, string[]>();
    for (const t of this.tasks.values()) {
      if (t.parentId !== undefined) {
        const list = children.get(t.parentId) ?? [];
        list.push(t.id);
        children.set(t.parentId, list);
      }
    }
    const out: Task[] = [];
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const t = this.tasks.get(cur);
      if (t) out.push(clone(t));
      for (const child of children.get(cur) ?? []) stack.push(child);
    }
    return out;
  }

  /** All tasks, oldest-first. */
  all(): Task[] {
    return this.list();
  }

  /** Absolute path of the durable file (or null when disk is disabled). */
  get path(): string | null {
    return this.filePath;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private requireExists(id: string, label: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`tasks: no ${label} with id "${id}"`);
    return t;
  }

  /** Does `from` reach `target` by following `deps` edges (transitively)? */
  private dependsOnTransitively(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const t = this.tasks.get(cur);
      if (t) stack.push(...t.deps);
    }
    return false;
  }

  /** Would making `newParent` the parent of `id` close a parent-chain cycle? */
  private wouldCloseParentCycle(id: string, newParent: string): boolean {
    let cur: string | undefined = newParent;
    const seen = new Set<string>();
    while (cur !== undefined) {
      if (cur === id) return true;
      if (seen.has(cur)) break; // pre-existing malformed chain; stop safely
      seen.add(cur);
      cur = this.tasks.get(cur)?.parentId;
    }
    return false;
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    let parsed: TaskFileShape;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as TaskFileShape;
    } catch {
      return; // corrupt/unreadable file: start empty rather than crash
    }
    if (!Array.isArray(parsed?.tasks)) return;
    for (const t of parsed.tasks) {
      if (t && typeof t.id === "string") {
        this.tasks.set(t.id, { ...t, deps: Array.isArray(t.deps) ? [...t.deps] : [] });
      }
    }
  }

  private save(): void {
    if (!this.filePath) return;
    const data: TaskFileShape = { version: 1, tasks: [...this.tasks.values()] };
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* best-effort on platforms without POSIX perms */
    }
  }
}

/** Open a TaskStore, loading any persisted tasks. */
export function openTasks(opts: TaskStoreOptions = {}): TaskStore {
  return new TaskStore(opts);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function clone(task: Task): Task {
  return { ...task, deps: [...task.deps] };
}

function byCreatedThenId(a: Task, b: Task): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function assertStatus(status: string): asserts status is TaskStatus {
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new Error(`tasks: invalid status "${status}"`);
  }
}
