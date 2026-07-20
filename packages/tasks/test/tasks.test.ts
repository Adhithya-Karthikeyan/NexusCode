import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { openTasks } from "../src/store.js";
import { tasksFile } from "../src/paths.js";
import { TASK_STATUSES } from "../src/types.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

let clock = 1_000;
const now = (): number => (clock += 1000);

describe("TaskStore — CRUD & stamping", () => {
  it("creates/gets/updates/deletes and stamps timestamps", () => {
    clock = 1000;
    const store = openTasks({ file: ":memory:", now });

    const a = store.create({ title: "write parser" });
    expect(a.status).toBe("todo");
    expect(a.deps).toEqual([]);
    expect(a.createdAt).toBe(a.updatedAt);
    expect(store.get(a.id)?.title).toBe("write parser");

    const before = a.updatedAt;
    const updated = store.update(a.id, { status: "in_progress", notes: "started" });
    expect(updated.status).toBe("in_progress");
    expect(updated.notes).toBe("started");
    expect(updated.createdAt).toBe(a.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(before);

    expect(store.delete(a.id)).toBe(true);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.delete(a.id)).toBe(false);
  });

  it("rejects an invalid status and a duplicate explicit id", () => {
    const store = openTasks({ file: ":memory:", now });
    // @ts-expect-error deliberately invalid status
    expect(() => store.create({ title: "x", status: "nope" })).toThrow(/invalid status/);
    store.create({ title: "a", id: "fixed" });
    expect(() => store.create({ title: "b", id: "fixed" })).toThrow(/already exists/);
  });

  it("returns defensive copies (mutating a result never leaks into the store)", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    a.deps.push("hacked");
    a.title = "mutated";
    expect(store.get(a.id)?.deps).toEqual([]);
    expect(store.get(a.id)?.title).toBe("a");
  });

  it("exposes the canonical status set", () => {
    expect(TASK_STATUSES).toEqual(["todo", "in_progress", "blocked", "done", "cancelled"]);
  });
});

describe("TaskStore — subtasks (tree)", () => {
  it("attaches subtasks under a parent and lists children", () => {
    clock = 1000;
    const store = openTasks({ file: ":memory:", now });
    const plan = store.create({ title: "ship feature" });
    const s1 = store.addSubtask(plan.id, { title: "design" });
    const s2 = store.addSubtask(plan.id, { title: "build" });
    const grand = store.addSubtask(s2.id, { title: "unit tests" });

    expect(s1.parentId).toBe(plan.id);
    expect(store.list({ parentId: plan.id }).map((t) => t.id)).toEqual([s1.id, s2.id]);
    expect(store.list({ parentId: null }).map((t) => t.id)).toEqual([plan.id]);

    // subtree includes the root + all descendants
    const subtreeIds = store
      .subtree(plan.id)
      .map((t) => t.id)
      .sort();
    expect(subtreeIds).toEqual([plan.id, s1.id, s2.id, grand.id].sort());
  });

  it("rejects a subtask under a missing parent", () => {
    const store = openTasks({ file: ":memory:", now });
    expect(() => store.addSubtask("ghost", { title: "x" })).toThrow(/no parent/);
  });

  it("detaches children when a parent is deleted", () => {
    const store = openTasks({ file: ":memory:", now });
    const p = store.create({ title: "p" });
    const c = store.addSubtask(p.id, { title: "c" });
    store.delete(p.id);
    expect(store.get(c.id)?.parentId).toBeUndefined();
  });

  it("rejects reparenting that would form a parent cycle", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    const b = store.addSubtask(a.id, { title: "b" });
    // making a a child of b would close a→b→a
    expect(() => store.update(a.id, { parentId: b.id })).toThrow(/cycle/);
  });
});

describe("TaskStore — dependency DAG & cycle detection", () => {
  it("adds dependencies and is idempotent per edge", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    const b = store.create({ title: "b" });
    store.addDependency(b.id, a.id);
    store.addDependency(b.id, a.id); // no-op
    expect(store.get(b.id)?.deps).toEqual([a.id]);
  });

  it("rejects a self-dependency", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    expect(() => store.addDependency(a.id, a.id)).toThrow(/cannot depend on itself/);
  });

  it("rejects a direct cycle (a→b, b→a)", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    const b = store.create({ title: "b" });
    store.addDependency(a.id, b.id);
    expect(() => store.addDependency(b.id, a.id)).toThrow(/forms a cycle/);
  });

  it("rejects a transitive cycle (a→b→c→a)", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    const b = store.create({ title: "b" });
    const c = store.create({ title: "c" });
    store.addDependency(a.id, b.id);
    store.addDependency(b.id, c.id);
    expect(() => store.addDependency(c.id, a.id)).toThrow(/forms a cycle/);
    // graph stayed acyclic → topo order still works
    expect(store.topoOrder()).toHaveLength(3);
  });

  it("rejects a dependency on a missing task", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    expect(() => store.addDependency(a.id, "ghost")).toThrow(/no dependency/);
  });

  it("accepts create() with valid deps but rolls back the task on a bad dep", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    const before = store.all().length;

    // valid: c depends on a (a brand-new id can never close a cycle)
    const c = store.create({ title: "c", id: "c", deps: [a.id] });
    expect(c.deps).toEqual([a.id]);

    // a create whose deps reference a missing task must throw AND leave nothing behind
    expect(() => store.create({ title: "bad", id: "bad", deps: ["missing"] })).toThrow();
    expect(store.get("bad")).toBeUndefined();

    // a create that self-references must throw AND roll back
    expect(() => store.create({ title: "self", id: "self", deps: ["self"] })).toThrow(
      /cannot depend on itself/,
    );
    expect(store.get("self")).toBeUndefined();

    expect(store.all().length).toBe(before + 1); // only c survived
  });

  it("removeDependency drops the edge", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    const b = store.create({ title: "b" });
    store.addDependency(b.id, a.id);
    expect(store.removeDependency(b.id, a.id)).toBe(true);
    expect(store.get(b.id)?.deps).toEqual([]);
    expect(store.removeDependency(b.id, a.id)).toBe(false);
  });

  it("drops a dependency edge when the depended-on task is deleted", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    const b = store.create({ title: "b" });
    store.addDependency(b.id, a.id);
    store.delete(a.id);
    expect(store.get(b.id)?.deps).toEqual([]);
  });
});

describe("TaskStore — readyTasks respects deps", () => {
  it("only surfaces todo tasks whose deps are all done", () => {
    clock = 1000;
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    const b = store.create({ title: "b" });
    const c = store.create({ title: "c" });
    store.addDependency(b.id, a.id); // b needs a
    store.addDependency(c.id, b.id); // c needs b

    // initially only a (no deps) is ready
    expect(store.readyTasks().map((t) => t.id)).toEqual([a.id]);

    store.update(a.id, { status: "done" });
    // now b unblocks; c still waits on b
    expect(store.readyTasks().map((t) => t.id)).toEqual([b.id]);

    store.update(b.id, { status: "done" });
    expect(store.readyTasks().map((t) => t.id)).toEqual([c.id]);

    // an in_progress task is not "ready" (already picked up)
    store.update(c.id, { status: "in_progress" });
    expect(store.readyTasks()).toEqual([]);
  });

  it("treats a missing dependency id as unmet", () => {
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    store.addDependency(a.id, store.create({ title: "dep" }).id);
    store.delete(store.all().find((t) => t.title === "dep")!.id);
    // dep removed → edge dropped → a becomes ready
    expect(store.readyTasks().map((t) => t.id)).toEqual([a.id]);
  });
});

describe("TaskStore — topological order", () => {
  it("orders every task after its dependencies", () => {
    clock = 1000;
    const store = openTasks({ file: ":memory:", now });
    const a = store.create({ title: "a" });
    const b = store.create({ title: "b" });
    const c = store.create({ title: "c" });
    const d = store.create({ title: "d" });
    store.addDependency(b.id, a.id);
    store.addDependency(c.id, a.id);
    store.addDependency(d.id, b.id);
    store.addDependency(d.id, c.id);

    const order = store.topoOrder().map((t) => t.id);
    const pos = (id: string): number => order.indexOf(id);
    expect(pos(a.id)).toBeLessThan(pos(b.id));
    expect(pos(a.id)).toBeLessThan(pos(c.id));
    expect(pos(b.id)).toBeLessThan(pos(d.id));
    expect(pos(c.id)).toBeLessThan(pos(d.id));
    expect(order).toHaveLength(4);
  });
});

describe("TaskStore — progress percentages", () => {
  it("computes counts and percent, excluding cancelled from the denominator", () => {
    const store = openTasks({ file: ":memory:", now });
    store.create({ title: "a", status: "done" });
    store.create({ title: "b", status: "done" });
    store.create({ title: "c", status: "in_progress" });
    store.create({ title: "d", status: "todo" });

    const p = store.progress();
    expect(p.total).toBe(4);
    expect(p.done).toBe(2);
    expect(p.counts.done).toBe(2);
    expect(p.counts.in_progress).toBe(1);
    expect(p.counts.todo).toBe(1);
    expect(p.percent).toBe(50); // 2 done / 4 countable

    // cancelling one non-done task lifts percent (denominator shrinks)
    store.update(store.all().find((t) => t.title === "d")!.id, { status: "cancelled" });
    const p2 = store.progress();
    expect(p2.counts.cancelled).toBe(1);
    expect(p2.percent).toBe(67); // 2 done / 3 countable → 66.67 → 67
  });

  it("reports subtree progress for a plan independently", () => {
    const store = openTasks({ file: ":memory:", now });
    const plan = store.create({ title: "plan" });
    const s1 = store.addSubtask(plan.id, { title: "s1", status: "done" });
    store.addSubtask(plan.id, { title: "s2", status: "todo" });
    store.addSubtask(s1.id, { title: "s1a", status: "done" });
    // unrelated top-level task must not affect the plan's subtree progress
    store.create({ title: "other", status: "todo" });

    const p = store.progress(plan.id);
    expect(p.total).toBe(4); // plan + s1 + s2 + s1a
    expect(p.done).toBe(2);
    expect(p.percent).toBe(50);
  });

  it("returns 0 percent when nothing is countable", () => {
    const store = openTasks({ file: ":memory:", now });
    store.create({ title: "x", status: "cancelled" });
    expect(store.progress().percent).toBe(0);
    const empty = openTasks({ file: ":memory:", now });
    expect(empty.progress().percent).toBe(0);
  });
});

describe("TaskStore — persistence", () => {
  it("round-trips tasks, subtasks, and deps through a JSON file", () => {
    clock = 1000;
    const dir = tmp("nexus-tasks-");
    const store = openTasks({ dir, now });
    const a = store.create({ title: "a", id: "a" });
    const b = store.create({ title: "b", id: "b" });
    store.addDependency(b.id, a.id);
    store.addSubtask(a.id, { title: "child", id: "child" });
    store.update(a.id, { status: "done", notes: "finished" });

    // reopen from disk — fresh store, same file
    const reopened = openTasks({ dir, now });
    expect(reopened.get("a")?.status).toBe("done");
    expect(reopened.get("a")?.notes).toBe("finished");
    expect(reopened.get("b")?.deps).toEqual(["a"]);
    expect(reopened.get("child")?.parentId).toBe("a");
    expect(reopened.all()).toHaveLength(3);
    expect(reopened.progress().done).toBe(1);
  });

  it("resolves the file under NEXUS_DATA_DIR", () => {
    const dir = tmp("nexus-tasks-env-");
    expect(tasksFile(undefined, { NEXUS_DATA_DIR: dir } as NodeJS.ProcessEnv)).toBe(
      join(dir, "tasks.json"),
    );
  });

  it("writes the durable file with 0600 perms (POSIX)", () => {
    if (platform() === "win32") return;
    const dir = tmp("nexus-tasks-perm-");
    const store = openTasks({ dir, now });
    store.create({ title: "a" });
    const mode = statSync(store.path as string).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("starts empty on a corrupt file rather than crashing", () => {
    const dir = tmp("nexus-tasks-corrupt-");
    const file = join(dir, "tasks.json");
    // write garbage, then open
    writeFileSync(file, "{ not json");
    const store = openTasks({ file });
    expect(store.all()).toEqual([]);
  });

  it(":memory: store has a null path and never writes", () => {
    const store = openTasks({ file: ":memory:", now });
    expect(store.path).toBeNull();
    store.create({ title: "a" });
    expect(store.all()).toHaveLength(1);
  });
});
