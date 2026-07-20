/**
 * HookBus tests: a pre-tool hook can VETO a tool call; hooks fire IN ORDER and
 * a throwing hook is ISOLATED (does not crash the run or block the op); pre-hook
 * MODIFY threads a rewritten payload through later hooks and back to the caller;
 * verdicts on observe-only events are ignored.
 */

import { describe, expect, it, vi } from "vitest";
import { HookBus, HookExecutionError, createHookBus } from "../src/index.js";

describe("HookBus veto", () => {
  it("lets a pre-tool hook deny a tool call", async () => {
    const bus = new HookBus();
    bus.register("pre-tool", (p) => {
      if (p.toolName === "shell_exec") return { block: true, reason: "shell is disabled" };
    });

    const denied = await bus.emit("pre-tool", { toolName: "shell_exec", input: { cmd: "rm -rf /" } });
    expect(denied.blocked).toBe(true);
    expect(denied.reason).toBe("shell is disabled");

    const allowed = await bus.emit("pre-tool", { toolName: "fs_read", input: { path: "a.ts" } });
    expect(allowed.blocked).toBe(false);
    expect(allowed.reason).toBeUndefined();
  });

  it("ignores a block verdict on an observe-only event (post-tool)", async () => {
    const bus = new HookBus();
    bus.register("post-tool", () => ({ block: true, reason: "too late" }));
    const out = await bus.emit("post-tool", { toolName: "fs_read", ok: true });
    expect(out.blocked).toBe(false);
  });
});

describe("HookBus ordering + isolation", () => {
  it("fires handlers in order and isolates a throwing hook", async () => {
    const bus = new HookBus();
    const calls: string[] = [];

    bus.register("pre-run", () => { calls.push("b"); }, { order: 10, id: "b" });
    bus.register("pre-run", () => { calls.push("a"); }, { order: -5, id: "a" });
    bus.register("pre-run", () => {
      calls.push("boom");
      throw new Error("hook failure");
    }, { order: 0, id: "thrower" });
    bus.register("pre-run", () => { calls.push("c"); }, { order: 20, id: "c" });

    const out = await bus.emit("pre-run", {
      sessionId: "s1",
      turnId: "t1",
      adapterId: "mock",
      model: "mock-1",
    });

    // order asc: a(-5), boom(0), b(10), c(20)
    expect(calls).toEqual(["a", "boom", "b", "c"]);
    // a throwing hook is isolated: run is not blocked, but the error is recorded.
    expect(out.blocked).toBe(false);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.id).toBe("thrower");
    expect(out.errors[0]?.error.message).toBe("hook failure");
  });

  it("breaks order ties by registration sequence (stable)", async () => {
    const bus = createHookBus();
    const calls: string[] = [];
    bus.register("session-start", () => { calls.push("first"); });
    bus.register("session-start", () => { calls.push("second"); });
    await bus.emit("session-start", { sessionId: "s", ts: 0 });
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("HookBus modify", () => {
  it("threads a modified payload through later hooks and back to the caller", async () => {
    const bus = new HookBus();
    const seen: unknown[] = [];
    bus.register("pre-tool", (p) => {
      seen.push(p.input);
      return { modify: { input: { path: "rewritten.ts" } } };
    });
    bus.register("pre-tool", (p) => {
      seen.push(p.input); // should observe the rewritten input
    });

    const out = await bus.emit("pre-tool", { toolName: "fs_read", input: { path: "orig.ts" } });
    expect(seen[0]).toEqual({ path: "orig.ts" });
    expect(seen[1]).toEqual({ path: "rewritten.ts" });
    expect(out.payload.input).toEqual({ path: "rewritten.ts" });
  });

  it("resolves an on-approval decision (deny wins)", async () => {
    const bus = new HookBus();
    bus.register("on-approval", () => ({ approve: true }));
    bus.register("on-approval", () => ({ approve: false, reason: "policy" }));
    const out = await bus.emit("on-approval", { toolName: "shell_exec", permission: "exec" });
    expect(out.approved).toBe(false);
    expect(out.reason).toBe("policy");
  });
});

describe("HookBus fail-closed on HookExecutionError", () => {
  it("denies a veto-capable event when a hook throws HookExecutionError (fail-closed default)", async () => {
    const bus = new HookBus();
    bus.register("pre-tool", () => {
      throw new HookExecutionError("adapter crashed");
    });
    const out = await bus.emit("pre-tool", { toolName: "shell_exec", input: {} });
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe("adapter crashed");
    expect(out.errors).toHaveLength(1);
  });

  it("does not block an observe-only event on HookExecutionError", async () => {
    const bus = new HookBus();
    bus.register("post-tool", () => {
      throw new HookExecutionError("adapter crashed");
    });
    const out = await bus.emit("post-tool", { toolName: "shell_exec", ok: true });
    expect(out.blocked).toBe(false);
    expect(out.errors).toHaveLength(1);
  });

  it("honors failOpen:true on the thrown HookExecutionError", async () => {
    const bus = new HookBus();
    bus.register("pre-tool", () => {
      throw new HookExecutionError("adapter crashed", { failOpen: true });
    });
    const out = await bus.emit("pre-tool", { toolName: "shell_exec", input: {} });
    expect(out.blocked).toBe(false);
    expect(out.errors).toHaveLength(1);
  });

  it("still isolates a plain Error (a handler bug, not an execution failure) on a veto-capable event", async () => {
    const bus = new HookBus();
    bus.register("pre-tool", () => {
      throw new Error("bug in my handler");
    });
    const out = await bus.emit("pre-tool", { toolName: "shell_exec", input: {} });
    expect(out.blocked).toBe(false);
    expect(out.errors).toHaveLength(1);
  });
});

describe("HookBus registration lifecycle", () => {
  it("unregister removes a handler", async () => {
    const bus = new HookBus();
    const fn = vi.fn();
    const off = bus.register("on-error", fn);
    expect(bus.count("on-error")).toBe(1);
    off();
    expect(bus.count("on-error")).toBe(0);
    await bus.emit("on-error", { message: "x" });
    expect(fn).not.toHaveBeenCalled();
  });
});
