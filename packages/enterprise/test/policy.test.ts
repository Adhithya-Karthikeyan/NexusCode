import { describe, expect, it } from "vitest";

import { RoleStore, type Principal } from "../src/rbac/index.js";
import {
  Authorizer,
  PolicyEvaluator,
  costUsdFromUsage,
  type PolicyRule,
} from "../src/policy/index.js";

const developer: Principal = { id: "u-dev", roles: ["developer"] };
const admin: Principal = { id: "u-admin", roles: ["admin"] };
const viewer: Principal = { id: "u-view", roles: ["viewer"] };

describe("PolicyEvaluator — deny-overrides / explicit-deny-wins", () => {
  it("an explicit deny overrides a matching allow (order-independent)", () => {
    const allow: PolicyRule = { id: "allow-tools", effect: "allow", actions: ["*"], resources: ["tool:*"] };
    const deny: PolicyRule = { id: "deny-deploy", effect: "deny", resources: ["tool:prod_deploy"] };
    // allow listed first, deny second — deny must still win.
    const evaluator = new PolicyEvaluator({ rules: [allow, deny] });
    const d = evaluator.evaluate({ principal: developer, action: "write", resource: "tool:prod_deploy" });
    expect(d.allowed).toBe(false);
    expect(d.matchedRule?.id).toBe("deny-deploy");
    // A non-denied tool still allowed by the allow rule.
    expect(evaluator.evaluate({ principal: developer, action: "write", resource: "tool:fs_write" }).allowed).toBe(true);
  });

  it("default-deny (no matching rule) leaves matchedRule undefined", () => {
    const evaluator = new PolicyEvaluator({ rules: [{ effect: "allow", resources: ["tool:*"] }] });
    const d = evaluator.evaluate({ principal: developer, action: "use", resource: "provider:openai" });
    expect(d.allowed).toBe(false);
    expect(d.matchedRule).toBeUndefined();
    expect(d.reason).toContain("default deny");
  });

  it("subjects target by role and by principal id", () => {
    const evaluator = new PolicyEvaluator({
      rules: [
        { effect: "allow", subjects: { roles: ["developer"] }, resources: ["tool:*"], actions: ["write"] },
        { effect: "deny", subjects: { principals: ["u-dev"] }, resources: ["tool:secret"] },
      ],
    });
    expect(evaluator.evaluate({ principal: developer, action: "write", resource: "tool:fs_write" }).allowed).toBe(true);
    // principal-targeted deny wins for that exact principal.
    expect(evaluator.evaluate({ principal: developer, action: "write", resource: "tool:secret" }).allowed).toBe(false);
    // a different principal (same request) isn't targeted by the deny, but also
    // isn't a `developer`, so the allow doesn't apply → default deny.
    const other: Principal = { id: "u-other", roles: ["viewer"] };
    expect(evaluator.evaluate({ principal: other, action: "write", resource: "tool:secret" }).allowed).toBe(false);
  });
});

describe("PolicyEvaluator — conditions", () => {
  it("maxCostUsd: an over-budget request is DENIED, within-budget is allowed", () => {
    const evaluator = new PolicyEvaluator({
      rules: [{ id: "budgeted", effect: "allow", resources: ["provider:*"], conditions: { maxCostUsd: 1.0 } }],
    });
    // within budget → allowed
    const ok = evaluator.evaluate({
      principal: developer,
      action: "use",
      resource: "provider:openai",
      context: { costUsd: 0.5 },
    });
    expect(ok.allowed).toBe(true);
    // over budget → allow condition no longer holds → default deny
    const over = evaluator.evaluate({
      principal: developer,
      action: "use",
      resource: "provider:openai",
      context: { costUsd: 5.0 },
    });
    expect(over.allowed).toBe(false);
    // unknown cost → fail closed
    const unknown = evaluator.evaluate({
      principal: developer,
      action: "use",
      resource: "provider:openai",
    });
    expect(unknown.allowed).toBe(false);
  });

  it("maxCostUsd cost is derived from Usage + Pricing via the frozen cost seam", () => {
    // 1M input tokens @ $3/Mtok + 1M output @ $15/Mtok = $18 → over a $1 cap.
    const cost = costUsdFromUsage(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { inputPerMTok: 3, outputPerMTok: 15 },
    );
    expect(cost).toBeCloseTo(18, 6);
    const evaluator = new PolicyEvaluator({
      rules: [{ effect: "allow", resources: ["model:*"], conditions: { maxCostUsd: 1.0 } }],
    });
    expect(
      evaluator.evaluate({ principal: developer, action: "use", resource: "model:gpt-4o", context: { costUsd: cost } }).allowed,
    ).toBe(false);
  });

  it("timeWindow: rule applies only inside the daily clock window", () => {
    const evaluator = new PolicyEvaluator({
      rules: [{ effect: "allow", resources: ["command:*"], conditions: { timeWindow: { start: "09:00", end: "17:00" } } }],
    });
    const at = (h: number, m: number) => new Date(2026, 6, 19, h, m, 0).getTime();
    expect(
      evaluator.evaluate({ principal: developer, action: "execute", resource: "command:deploy", context: { now: at(12, 0) } }).allowed,
    ).toBe(true);
    expect(
      evaluator.evaluate({ principal: developer, action: "execute", resource: "command:deploy", context: { now: at(22, 0) } }).allowed,
    ).toBe(false);
  });

  it("dataClass: rule applies only for listed classes; unknown class fails closed", () => {
    const evaluator = new PolicyEvaluator({
      rules: [{ effect: "allow", resources: ["tool:*"], conditions: { dataClass: ["public", "internal"] } }],
    });
    expect(
      evaluator.evaluate({ principal: developer, action: "read", resource: "tool:x", context: { dataClass: "public" } }).allowed,
    ).toBe(true);
    expect(
      evaluator.evaluate({ principal: developer, action: "read", resource: "tool:x", context: { dataClass: "restricted" } }).allowed,
    ).toBe(false);
    expect(evaluator.evaluate({ principal: developer, action: "read", resource: "tool:x" }).allowed).toBe(false);
  });
});

describe("PolicyEvaluator — conditional DENY fails closed (deny-overrides guarantee)", () => {
  it("a dataClass-scoped DENY still fires when the class context is missing", () => {
    // An explicit deny scoped to `restricted` data. Withholding the dataClass
    // context must NOT neutralize it — the deny fails closed and still matches.
    const evaluator = new PolicyEvaluator({
      rules: [
        { id: "allow-tools", effect: "allow", resources: ["tool:*"], actions: ["*"] },
        { id: "deny-restricted", effect: "deny", resources: ["tool:*"], conditions: { dataClass: ["restricted"] } },
      ],
    });
    // No context at all: the deny cannot be ruled out ⇒ deny wins (fail closed).
    const noCtx = evaluator.evaluate({ principal: developer, action: "read", resource: "tool:x" });
    expect(noCtx.allowed).toBe(false);
    expect(noCtx.matchedRule?.id).toBe("deny-restricted");
    expect(noCtx.reason).toContain("fail closed");
    // Context proving the data is NOT restricted rules the deny out ⇒ allow applies.
    const proven = evaluator.evaluate({
      principal: developer,
      action: "read",
      resource: "tool:x",
      context: { dataClass: "public" },
    });
    expect(proven.allowed).toBe(true);
    expect(proven.matchedRule?.id).toBe("allow-tools");
    // Context matching the deny scope ⇒ deny fires as before.
    const matched = evaluator.evaluate({
      principal: developer,
      action: "read",
      resource: "tool:x",
      context: { dataClass: "restricted" },
    });
    expect(matched.allowed).toBe(false);
    expect(matched.matchedRule?.id).toBe("deny-restricted");
  });

  it("a maxCostUsd-scoped DENY still fires when the cost context is missing", () => {
    // A deny guarded by `maxCostUsd: 10` fires while cost ≤ $10 (the guard holds);
    // withholding the cost must not defeat it — it fails closed and still denies.
    const evaluator = new PolicyEvaluator({
      rules: [
        { id: "allow-models", effect: "allow", resources: ["model:*"], actions: ["*"] },
        { id: "deny-guarded", effect: "deny", resources: ["model:*"], conditions: { maxCostUsd: 10 } },
      ],
    });
    // No cost context ⇒ the deny cannot be ruled out ⇒ deny wins (fail closed).
    const noCtx = evaluator.evaluate({ principal: developer, action: "use", resource: "model:gpt-4o" });
    expect(noCtx.allowed).toBe(false);
    expect(noCtx.matchedRule?.id).toBe("deny-guarded");
    expect(noCtx.reason).toContain("fail closed");
    // Cost proven ABOVE the cap places the request outside the deny's guard ⇒
    // the deny is ruled out and the allow applies.
    const outside = evaluator.evaluate({
      principal: developer,
      action: "use",
      resource: "model:gpt-4o",
      context: { costUsd: 20 },
    });
    expect(outside.allowed).toBe(true);
    expect(outside.matchedRule?.id).toBe("allow-models");
    // Cost within the guard ⇒ deny fires as intended.
    expect(
      evaluator.evaluate({
        principal: developer,
        action: "use",
        resource: "model:gpt-4o",
        context: { costUsd: 2 },
      }).allowed,
    ).toBe(false);
  });

  it("server-style authorize (no context) cannot bypass a conditional deny", () => {
    const roleStore = new RoleStore();
    // RBAC would allow the write, but the conditional deny fails closed.
    const evaluator = new PolicyEvaluator({
      rules: [{ id: "deny-restricted", effect: "deny", resources: ["tool:prod_deploy"], conditions: { dataClass: ["restricted"] } }],
    });
    const authz = new Authorizer({ roleStore, evaluator });
    // No context passed — mirrors the REST authorize() path.
    const d = authz.authorize({ principal: developer, action: "write", resource: "tool:prod_deploy" });
    expect(d.allowed).toBe(false);
    expect(d.source).toBe("policy");
    expect(d.matchedRule?.id).toBe("deny-restricted");
  });
});

describe("Authorizer — combined policy + RBAC", () => {
  const roleStore = new RoleStore();

  it("a deny policy overrides an RBAC allow grant", () => {
    // RBAC alone allows a developer to write tools.
    expect(roleStore.can(developer, "write", "tool:prod_deploy")).toBe(true);
    const evaluator = new PolicyEvaluator({
      rules: [{ id: "no-deploy", effect: "deny", resources: ["tool:prod_deploy"] }],
    });
    const authz = new Authorizer({ roleStore, evaluator });
    const d = authz.authorize({ principal: developer, action: "write", resource: "tool:prod_deploy" });
    expect(d.allowed).toBe(false);
    expect(d.source).toBe("policy");
    expect(d.matchedRule?.id).toBe("no-deploy");
    // A different tool is still allowed (via RBAC fallthrough).
    const ok = authz.authorize({ principal: developer, action: "write", resource: "tool:fs_write" });
    expect(ok.allowed).toBe(true);
    expect(ok.source).toBe("rbac");
  });

  it("with no matching policy, RBAC decides and FAILS CLOSED", () => {
    const authz = new Authorizer({ roleStore });
    // admin allowed via RBAC
    expect(authz.authorize({ principal: admin, action: "manage", resource: "agent-role:reviewer" }).allowed).toBe(true);
    // viewer denied a write tool via RBAC (fail closed, no policy opinion)
    const no = authz.authorize({ principal: viewer, action: "write", resource: "tool:fs_write" });
    expect(no.allowed).toBe(false);
    expect(no.source).toBe("rbac");
  });

  it("a policy allow can grant beyond RBAC (explicit allow settles it)", () => {
    // viewer has no RBAC grant to use a provider...
    expect(roleStore.can(viewer, "use", "provider:openai")).toBe(false);
    // ...but an explicit policy allow lets this specific viewer through.
    const evaluator = new PolicyEvaluator({
      rules: [{ id: "grant-view", effect: "allow", subjects: { principals: ["u-view"] }, resources: ["provider:openai"], actions: ["use"] }],
    });
    const authz = new Authorizer({ roleStore, evaluator });
    const d = authz.authorize({ principal: viewer, action: "use", resource: "provider:openai" });
    expect(d.allowed).toBe(true);
    expect(d.source).toBe("policy");
  });
});
