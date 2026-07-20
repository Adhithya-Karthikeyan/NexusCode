import { describe, expect, it } from "vitest";

import {
  RoleStore,
  parseResource,
  type Principal,
  type Role,
} from "../src/rbac/index.js";

const admin: Principal = { id: "u-admin", roles: ["admin"] };
const developer: Principal = { id: "u-dev", roles: ["developer"] };
const viewer: Principal = { id: "u-view", roles: ["viewer"] };
const nobody: Principal = { id: "u-none", roles: [] };

describe("RoleStore — built-in roles, fail-closed", () => {
  const store = new RoleStore();

  it("admin is allowed every action on every resource", () => {
    expect(store.can(admin, "write", "tool:fs_write")).toBe(true);
    expect(store.can(admin, "use", "provider:openai")).toBe(true);
    expect(store.can(admin, "manage", "agent-role:reviewer")).toBe(true);
    expect(store.can(admin, "execute", "command:deploy")).toBe(true);
  });

  it("viewer is DENIED a write tool", () => {
    expect(store.can(viewer, "write", "tool:fs_write")).toBe(false);
    // ...but may read.
    expect(store.can(viewer, "read", "tool:fs_write")).toBe(true);
  });

  it("viewer is DENIED using a restricted provider", () => {
    expect(store.can(viewer, "use", "provider:openai")).toBe(false);
    expect(store.can(viewer, "use", "provider:internal-gateway")).toBe(false);
  });

  it("developer can use tools/providers/commands but NOT manage RBAC", () => {
    expect(store.can(developer, "write", "tool:fs_write")).toBe(true);
    expect(store.can(developer, "use", "provider:openai")).toBe(true);
    expect(store.can(developer, "execute", "command:deploy")).toBe(true);
    // `manage` is not granted to developer → fail closed.
    expect(store.can(developer, "manage", "agent-role:reviewer")).toBe(false);
  });

  it("a principal with NO roles falls back to the minimal default role", () => {
    // default may read the catalog...
    expect(store.can(nobody, "read", "model:gpt-4o")).toBe(true);
    expect(store.can(nobody, "read", "provider:openai")).toBe(true);
    // ...but nothing else (fail closed).
    expect(store.can(nobody, "write", "tool:fs_write")).toBe(false);
    expect(store.can(nobody, "read", "tool:fs_write")).toBe(false);
  });

  it("FAILS CLOSED when no rule grants a restricted action", () => {
    // A custom role that grants only read on tools.
    const s = new RoleStore({
      roles: [{ name: "toolreader", grants: [{ actions: ["read"], resources: ["tool:*"] }] }],
    });
    const p: Principal = { id: "u1", roles: ["toolreader"] };
    // Missing rule for `execute` on a restricted command → deny.
    expect(s.can(p, "execute", "command:deploy")).toBe(false);
    // Missing rule for `use` on a restricted provider → deny.
    expect(s.can(p, "use", "provider:openai")).toBe(false);
    // The one granted action still works.
    expect(s.can(p, "read", "tool:fs_read")).toBe(true);
  });

  it("explain() reports the deciding role/grant and a reason", () => {
    const ok = store.explain(developer, "write", "tool:fs_write");
    expect(ok.allowed).toBe(true);
    expect(ok.role).toBe("developer");
    expect(ok.reason).toContain("developer");

    const no = store.explain(viewer, "write", "tool:fs_write");
    expect(no.allowed).toBe(false);
    expect(no.reason).toContain("fail closed");
  });

  it("malformed resource strings are denied, not crashed", () => {
    expect(store.can(admin, "read", "not-a-resource")).toBe(false);
    expect(store.can(admin, "read", "unknown-type:x")).toBe(false);
    expect(parseResource("tool:fs_write")).toEqual({ type: "tool", id: "fs_write" });
    expect(parseResource("bogus")).toBeNull();
    expect(parseResource("tool:")).toBeNull();
  });
});

describe("RoleStore — custom roles + inheritance", () => {
  it("inherited grants are unioned (cycle-safe)", () => {
    const base: Role = {
      name: "base",
      grants: [{ actions: ["read"], resources: ["model:*"] }],
    };
    const power: Role = {
      name: "power",
      inherits: ["base"],
      grants: [{ actions: ["write"], resources: ["tool:*"] }],
    };
    const store = new RoleStore({ roles: [base, power] }, { includeBuiltins: false });
    const p: Principal = { id: "u", roles: ["power"] };
    expect(store.can(p, "write", "tool:fs_write")).toBe(true); // own grant
    expect(store.can(p, "read", "model:gpt-4o")).toBe(true); // inherited
    expect(store.can(p, "write", "model:gpt-4o")).toBe(false); // neither grants
  });

  it("a self/mutual inheritance cycle does not hang and still resolves grants", () => {
    const a: Role = { name: "a", inherits: ["b"], grants: [{ actions: ["read"], resources: ["tool:*"] }] };
    const b: Role = { name: "b", inherits: ["a"], grants: [{ actions: ["write"], resources: ["tool:*"] }] };
    const store = new RoleStore({ roles: [a, b] }, { includeBuiltins: false });
    const p: Principal = { id: "u", roles: ["a"] };
    expect(store.can(p, "read", "tool:x")).toBe(true);
    expect(store.can(p, "write", "tool:x")).toBe(true);
    expect(store.can(p, "execute", "tool:x")).toBe(false);
  });
});
