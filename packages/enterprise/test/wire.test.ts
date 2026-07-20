/**
 * Enterprise wiring tests (system-spec §25). The single `EnterpriseServices`
 * bundle the harness plugs into the PermissionGate / hook bus / router / server:
 *   - a viewer principal is DENIED a write tool and the deny is AUDITED;
 *   - the audit chain remains intact (tamper-evident) and detects tampering;
 *   - a budget BLOCKS an over-limit run and accrues spend post-run;
 *   - token → principal resolution is constant-time and correct;
 *   - a private gateway set is assembled from config;
 *   - OFF mode is inert (`enabled:false`) — the fail-closed decisions still
 *     compute but callers skip them, so single-user behavior is unchanged.
 * Offline, deterministic.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildEnterpriseServices, type EnterpriseWireConfig } from "../src/wire/index.js";
import { verifyChain } from "../src/audit/log.js";
import type { Pricing, Usage } from "@nexuscode/shared";

const TMP = mkdtempSync(join(tmpdir(), "nx-ent-wire-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const PRICING: Pricing = { inputPerMTok: 10, outputPerMTok: 30 };
/** Fixed HMAC key so this file's one direct `verifyChain()` call (bypassing
 * `AuditLog`, which otherwise holds its own key internally) can authenticate. */
const TEST_AUDIT_KEY = Buffer.from("11".repeat(32), "hex");

function baseConfig(overrides: Partial<EnterpriseWireConfig> = {}): EnterpriseWireConfig {
  return {
    mode: "on",
    principals: [
      { id: "vince", roles: ["viewer"], token: "tok-viewer" },
      { id: "dana", roles: ["developer"], token: "tok-dev" },
    ],
    ...overrides,
  };
}

describe("EnterpriseServices — RBAC tool authorization + audit", () => {
  it("denies a viewer a write tool and records the deny to the audit log", () => {
    const svc = buildEnterpriseServices(baseConfig());
    const viewer = svc.principalById("vince");

    const decision = svc.authorizeAndAudit(viewer, "write", "tool:fs_write");
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("rbac");

    const records = svc.auditLog.query({ decision: "deny" });
    expect(records.length).toBe(1);
    expect(records[0]?.resource).toBe("tool:fs_write");
    expect(records[0]?.actor).toBe("vince");
    expect(records[0]?.role).toBe("viewer");
  });

  it("allows a viewer a read tool and a developer a write tool", () => {
    const svc = buildEnterpriseServices(baseConfig());
    expect(svc.authorize(svc.principalById("vince"), "read", "tool:fs_read").allowed).toBe(true);
    expect(svc.authorize(svc.principalById("dana"), "write", "tool:fs_write").allowed).toBe(true);
  });

  it("fails closed for an unknown principal on a write action", () => {
    const svc = buildEnterpriseServices(baseConfig());
    // unknown id resolves to defaultRole (read provider/model only).
    const decision = svc.authorize(svc.principalById("ghost"), "write", "tool:fs_write");
    expect(decision.allowed).toBe(false);
  });
});

describe("EnterpriseServices — policy deny-overrides", () => {
  it("an explicit deny rule overrides an RBAC grant", () => {
    const svc = buildEnterpriseServices(
      baseConfig({
        policies: [
          { id: "no-shell", effect: "deny", actions: ["execute"], resources: ["tool:shell"] },
        ],
      }),
    );
    // developer would be granted execute, but the policy denies it.
    const d = svc.authorize(svc.principalById("dana"), "execute", "tool:shell");
    expect(d.allowed).toBe(false);
    expect(d.source).toBe("policy");
  });
});

describe("EnterpriseServices — audit chain integrity", () => {
  it("appends a hash-chained, tamper-evident record and verifies it on disk", () => {
    const file = join(TMP, "audit-1.ndjson");
    const svc = buildEnterpriseServices(baseConfig(), { auditFile: file });
    svc.authorizeAndAudit(svc.principalById("vince"), "write", "tool:fs_write");
    svc.authorizeAndAudit(svc.principalById("dana"), "read", "tool:fs_read");

    const result = svc.auditLog.verifyFile();
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.tampered).toEqual([]);
  });

  it("detects a tampered record", () => {
    const svc = buildEnterpriseServices(baseConfig(), { auditKey: TEST_AUDIT_KEY });
    svc.authorizeAndAudit(svc.principalById("vince"), "write", "tool:fs_write");
    svc.authorizeAndAudit(svc.principalById("dana"), "read", "tool:fs_read");
    const records = svc.auditLog.all();
    // Flip a stored field without recomputing the hash.
    const forged = records.map((r, i) => (i === 0 ? { ...r, decision: "allow" as const } : r));
    const verdict = verifyChain(forged, TEST_AUDIT_KEY);
    expect(verdict.ok).toBe(false);
    expect(verdict.tampered.some((t) => t.reason === "hash-mismatch")).toBe(true);
  });
});

describe("EnterpriseServices — cost budget gate", () => {
  it("blocks an over-limit run and accrues post-run spend", () => {
    const svc = buildEnterpriseServices(
      baseConfig({
        budgets: [{ id: "b1", scope: "principal", key: "dana", limitUsd: 1.0, window: "day" }],
      }),
    );
    const cp = { principal: "dana", role: "developer" };

    // Under the limit → allow.
    expect(svc.enforceBudget(cp, 0.5).decision).toBe("allow");

    // Record a run that consumes most of the budget.
    const usage: Usage = { inputTokens: 80_000, outputTokens: 0 }; // 80k * $10/1M = $0.80
    svc.recordRun(cp, usage, PRICING, { provider: "mock", model: "mock-fast" });

    // A further $0.50 run would exceed $1.00 → deny (audited).
    const verdict = svc.enforceBudget(cp, 0.5);
    expect(verdict.decision).toBe("deny");
    const denies = svc.auditLog.query({}).filter((r) => r.details?.kind === "budget");
    expect(denies.length).toBeGreaterThan(0);
  });
});

describe("EnterpriseServices — token resolution + gateways + off-mode", () => {
  it("resolves a principal from its bearer token, and nothing for a wrong token", () => {
    const svc = buildEnterpriseServices(baseConfig());
    expect(svc.principalForToken("tok-viewer")?.id).toBe("vince");
    expect(svc.principalForToken("tok-dev")?.id).toBe("dana");
    expect(svc.principalForToken("tok-nope")).toBeUndefined();
    expect(svc.principalForToken("")).toBeUndefined();
  });

  it("assembles a gateway set from config", () => {
    const svc = buildEnterpriseServices(
      baseConfig({
        gateways: {
          global: { baseUrl: "https://gw.corp.example.com" },
          byProvider: { openai: { baseUrl: "https://openai-gw.corp.example.com" } },
        },
      }),
    );
    expect(svc.gatewaySet.global?.baseUrl).toBe("https://gw.corp.example.com");
    expect(svc.gatewaySet.byProvider?.openai?.baseUrl).toBe("https://openai-gw.corp.example.com");
  });

  it("is inert when mode is off (enabled=false) but decisions still compute fail-closed", () => {
    const svc = buildEnterpriseServices({ mode: "off", principals: [{ id: "vince", roles: ["viewer"] }] });
    expect(svc.enabled).toBe(false);
    // The decision logic is unchanged (callers just skip it in off-mode).
    expect(svc.authorize(svc.principalById("vince"), "write", "tool:fs_write").allowed).toBe(false);
  });
});
