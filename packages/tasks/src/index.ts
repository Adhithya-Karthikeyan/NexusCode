/**
 * @nexuscode/tasks — task management for plans (system-spec §15).
 *
 * A {@link TaskStore} holds {@link Task}s that form two overlapping structures:
 * a *tree* via `parentId` (task → subtasks) and a *DAG* via `deps` (task depends
 * on tasks). The DAG is kept acyclic — {@link TaskStore.addDependency} rejects
 * any edge that would close a cycle — which powers {@link TaskStore.readyTasks}
 * (todo tasks whose deps are all done), {@link TaskStore.topoOrder} (dependency
 * order), and {@link TaskStore.progress} (counts + percent for a plan/subtree).
 *
 * Tasks persist to a JSON file under the shared data dir (0600 perms, atomic
 * writes); pass `file: ":memory:"` for an in-memory store (tests).
 */

export type {
  Task,
  TaskStatus,
  TaskInput,
  TaskPatch,
  TaskFilter,
  Progress,
} from "./types.js";
export { TASK_STATUSES } from "./types.js";

export { TaskStore, openTasks } from "./store.js";
export type { TaskStoreOptions } from "./store.js";

export { tasksDataDir, tasksFile } from "./paths.js";
