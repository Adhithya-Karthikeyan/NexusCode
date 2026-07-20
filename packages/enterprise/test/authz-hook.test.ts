import { HookBus } from "@nexuscode/hooks";
import { describe, expect, it } from "vitest";

import { RoleStore, type Principal } from "../src/rbac/index.js";
import {
  Authorizer,
  PolicyEvaluator,
  actionForToolPermission,
  createAuthorizationHook,
} from "../src/policy/index.js";

const viewer: Principal = { id: "sess-viewer", roles: ["viewer"] };
const developer: Principal = { id: "sess-dev", roles: ["developer"] };

function makeBus(authz: Authorizer, principals: Record<string, Principal>) {
  const bus = new HookBus();
  const hook = createAuthorizationHook({
    authorizer: authz,
    resolvePrincipal: (sessionId) => (sessionId ? principals[sessionId] : undefined),
  });
  bus.register("pre-tool", hook, { id: "enterprise-authz" });
  return bus;
}

describe("createAuthorizationHook — pre-tool gate integration", () => {
  it("maps tool permission classes to RBAC actions", () => {
    expect(actionForToolPermission("read")).toBe("read");
    expect(actionForToolPermission("write")).toBe("write");
    expect(actionForToolPermission("exec")).toBe("execute");
    expect(actionForToolPermission("network")).toBe("use");
    expect(actionForToolPermission(undefined)).toBe("use");
  });

  it("VETOES a write tool call for a viewer (fail-closed RBAC)", async () => {
    const authz = new Authorizer({ roleStore: new RoleStore() });
    const bus = makeBus(authz, { "sess-viewer": viewer });
    const out = await bus.emit("pre-tool", {
      toolName: "fs_write",
      input: { path: "/etc/hosts", contents: "x" },
      permission: "write",
      sessionId: "sess-viewer",
    });
    expect(out.blocked).toBe(true);
    expect(out.reason).toContain("fail closed");
  });

  it("ALLOWS a write tool call for a developer", async () => {
    const authz = new Authorizer({ roleStore: new RoleStore() });
    const bus = makeBus(authz, { "sess-dev": developer });
    const out = await bus.emit("pre-tool", {
      toolName: "fs_write",
      input: { path: "./file.txt" },
      permission: "write",
      sessionId: "sess-dev",
    });
    expect(out.blocked).toBe(false);
  });

  it("a deny policy on a tool overrides the developer's RBAC grant at the gate", async () => {
    const evaluator = new PolicyEvaluator({
      rules: [{ id: "no-shell", effect: "deny", resources: ["tool:shell"] }],
    });
    const authz = new Authorizer({ roleStore: new RoleStore(), evaluator });
    const bus = makeBus(authz, { "sess-dev": developer });
    const blocked = await bus.emit("pre-tool", {
      toolName: "shell",
      input: { cmd: "rm -rf /" },
      permission: "exec",
      sessionId: "sess-dev",
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("no-shell");
    // A different tool still passes.
    const ok = await bus.emit("pre-tool", {
      toolName: "fs_write",
      input: {},
      permission: "write",
      sessionId: "sess-dev",
    });
    expect(ok.blocked).toBe(false);
  });

  it("observes only (no veto) when the principal cannot be resolved", async () => {
    const authz = new Authorizer({ roleStore: new RoleStore() });
    const bus = makeBus(authz, {}); // no principal for this session
    const out = await bus.emit("pre-tool", {
      toolName: "fs_write",
      input: {},
      permission: "write",
      sessionId: "unknown-session",
    });
    // No identity → the enterprise hook abstains; the PermissionGate still gates.
    expect(out.blocked).toBe(false);
  });
});
