/**
 * `CancelScope` (src/cancel.ts) — one cancellation semantics over a scope
 * tree. Untested seam (audit F7): cascade + reason propagation, a child
 * created from an already-cancelled parent, `onCancel`'s exactly-once /
 * immediate-run contract, isolation between handlers, idempotent `cancel()`,
 * and that `signal.aborted` never disagrees with `isCancelled`.
 */
import { describe, it, expect } from "vitest";
import { rootScope } from "@nexuscode/core";

describe("CancelScope — cascade", () => {
  it("parent.cancel cancels every descendant, tagging them with reason 'parent'", async () => {
    const parent = rootScope();
    const childA = parent.child();
    const childB = parent.child();
    const grandchild = childA.child();

    await parent.cancel("user");

    expect(parent.isCancelled).toBe(true);
    expect(parent.reason).toBe("user");
    expect(childA.isCancelled).toBe(true);
    expect(childA.reason).toBe("parent");
    expect(childB.isCancelled).toBe(true);
    expect(childB.reason).toBe("parent");
    expect(grandchild.isCancelled).toBe(true);
    expect(grandchild.reason).toBe("parent");
  });
});

describe("CancelScope — child() of an already-cancelled parent", () => {
  it("starts cancelled with reason 'parent' and an already-aborted signal", async () => {
    const parent = rootScope();
    await parent.cancel("timeout");

    const child = parent.child();

    expect(child.isCancelled).toBe(true);
    expect(child.reason).toBe("parent");
    expect(child.signal.aborted).toBe(true);
  });
});

describe("CancelScope.onCancel — exactly-once contract", () => {
  it("runs a handler registered before cancel exactly once, and one registered after cancel runs immediately, exactly once", async () => {
    const scope = rootScope();
    let before = 0;
    scope.onCancel(() => {
      before += 1;
    });

    await scope.cancel("user");
    expect(before).toBe(1);

    let after = 0;
    scope.onCancel(() => {
      after += 1;
    });
    // Already-cancelled scope runs a newly registered handler synchronously.
    expect(after).toBe(1);

    // A second cancel() must not re-run anything.
    await scope.cancel("timeout");
    expect(before).toBe(1);
    expect(after).toBe(1);
  });
});

describe("CancelScope.onCancel — a throwing handler does not block siblings", () => {
  it("still runs every other registered handler even when one throws synchronously", async () => {
    const scope = rootScope();
    const ran: string[] = [];
    scope.onCancel(() => {
      ran.push("a");
      throw new Error("handler a exploded");
    });
    scope.onCancel(() => {
      ran.push("b");
    });
    scope.onCancel(() => {
      ran.push("c");
    });

    await scope.cancel("user");

    expect(ran.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("CancelScope.cancel — idempotent", () => {
  it("the first cancel() call wins: reason is fixed and later calls are no-ops", async () => {
    const scope = rootScope();
    let calls = 0;
    scope.onCancel(() => {
      calls += 1;
    });

    await scope.cancel("user");
    await scope.cancel("budget");
    await scope.cancel("race-won");

    expect(scope.reason).toBe("user");
    expect(calls).toBe(1);
  });
});

describe("CancelScope.signal — agrees with isCancelled", () => {
  it("signal.aborted matches isCancelled both before and after cancel", async () => {
    const scope = rootScope();
    expect(scope.isCancelled).toBe(false);
    expect(scope.signal.aborted).toBe(false);

    await scope.cancel("budget");

    expect(scope.isCancelled).toBe(true);
    expect(scope.signal.aborted).toBe(true);
  });
});
