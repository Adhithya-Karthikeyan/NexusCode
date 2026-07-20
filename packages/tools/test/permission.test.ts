import { describe, it, expect, vi } from "vitest";
import { PermissionGate, type Tool } from "@nexuscode/tools";

const tool = (permission: Tool["permission"], name = `t_${permission}`): Tool => ({
  name,
  description: "",
  parameters: {},
  permission,
  run: async () => ({ ok: true, content: [] }),
});

describe("PermissionGate mode policy", () => {
  it("plan mode allows read, denies write/exec/network", async () => {
    const g = new PermissionGate({ mode: "plan" });
    expect((await g.check(tool("read"), {})).allowed).toBe(true);
    expect((await g.check(tool("write"), {})).allowed).toBe(false);
    expect((await g.check(tool("exec"), {})).allowed).toBe(false);
    expect((await g.check(tool("network"), {})).allowed).toBe(false);
  });

  it("read-only allows read, denies write/exec, asks for network", async () => {
    const approve = vi.fn(async () => true);
    const g = new PermissionGate({ mode: "read-only", approve });
    expect((await g.check(tool("read"), {})).allowed).toBe(true);
    expect((await g.check(tool("write"), {})).allowed).toBe(false);
    const net = await g.check(tool("network"), {});
    expect(net.allowed).toBe(true);
    expect(net.viaApproval).toBe(true);
    expect(approve).toHaveBeenCalledOnce();
  });

  it("workspace-write allows read+write, asks for exec/network", async () => {
    const g = new PermissionGate({ mode: "workspace-write", approve: async () => false });
    expect((await g.check(tool("read"), {})).allowed).toBe(true);
    expect((await g.check(tool("write"), {})).allowed).toBe(true);
    const exec = await g.check(tool("exec"), {});
    expect(exec.allowed).toBe(false);
    expect(exec.viaApproval).toBe(true);
  });

  it("full-access allows everything without approval", async () => {
    const approve = vi.fn(async () => true);
    const g = new PermissionGate({ mode: "full-access", approve });
    for (const p of ["read", "write", "exec", "network"] as const) {
      const d = await g.check(tool(p), {});
      expect(d.allowed).toBe(true);
      expect(d.viaApproval).toBe(false);
    }
    expect(approve).not.toHaveBeenCalled();
  });

  it("ask denies when no approver is configured", async () => {
    const g = new PermissionGate({ mode: "workspace-write" });
    const d = await g.check(tool("exec"), {});
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no approver/);
  });
});

describe("PermissionGate allow/deny lists", () => {
  it("denylist wins over everything, including full-access", async () => {
    const g = new PermissionGate({ mode: "full-access", denylist: ["shell_*"] });
    const d = await g.check(tool("exec", "shell_exec"), {});
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/denylist/);
  });

  it("allowlist bypasses mode policy and approval", async () => {
    const approve = vi.fn(async () => false);
    const g = new PermissionGate({ mode: "read-only", allowlist: ["fs_write"], approve });
    const d = await g.check(tool("write", "fs_write"), {});
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/allowlist/);
    expect(approve).not.toHaveBeenCalled();
  });

  it("denylist beats allowlist", async () => {
    const g = new PermissionGate({ mode: "full-access", allowlist: ["x"], denylist: ["x"] });
    expect((await g.check(tool("read", "x"), {})).allowed).toBe(false);
  });
});

describe("PermissionGate redaction", () => {
  it("redacts secret-named fields in the approval request and logged input", async () => {
    let seen: unknown;
    const g = new PermissionGate({
      mode: "workspace-write",
      approve: async (req) => {
        seen = req.input;
        return true;
      },
    });
    const d = await g.check(tool("exec"), { command: "curl", apiKey: "sk-abcdef0123456789ABCD" });
    expect(JSON.stringify(seen)).toContain("[REDACTED]");
    expect(JSON.stringify(seen)).not.toContain("sk-abcdef0123456789ABCD");
    expect(JSON.stringify(d.loggedInput)).toContain("[REDACTED]");
  });

  it("setMode changes subsequent decisions", async () => {
    const g = new PermissionGate({ mode: "plan" });
    expect((await g.check(tool("write"), {})).allowed).toBe(false);
    g.setMode("workspace-write");
    expect((await g.check(tool("write"), {})).allowed).toBe(true);
  });
});
