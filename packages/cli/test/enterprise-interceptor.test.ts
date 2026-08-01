/**
 * Direct, in-process coverage for the RBAC enforcement glue in
 * `packages/cli/src/enterprise.ts` (audit finding ENT-02, critical, zero tests):
 *
 *  1. `enterpriseToolInterceptor` — authorizes every native-tool-loop call for a
 *     fixed principal, vetoes a denied call with the RBAC reason, and records
 *     the decision to the audit log.
 *  2. `composeInterceptors` — chains two interceptors so a `first` veto
 *     short-circuits `second`'s `preTool`, while both `postTool` hooks always
 *     run on a successful call.
 *  3. `recordRunSpend` — prices a completed run's usage and records it where
 *     the code says it goes: `services.usageStore`.
 *
 * These call the CLI glue functions directly (no CLI process spawned) against a
 * tmp-dir audit file + an in-memory `SecretStore`, mirroring the sandbox
 * pattern of `enterprise-usage-attribution.test.ts`.
 */

import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import type { ToolInterceptor } from "@nexuscode/core";
import type { AuditRecord, Principal } from "@nexuscode/enterprise";

import {
  buildEnterprise,
  enterpriseToolInterceptor,
  composeInterceptors,
  recordRunSpend,
} from "../src/enterprise.js";

// Every root `sandbox()` mkdtemps, so they can all be drained together once at
// the end of the file instead of tracking each call site individually.
const sandboxRoots: string[] = [];

/** One isolated sandbox: its own data dir + audit file. */
function sandbox(): { dataDir: string; auditFile: string } {
  const root = mkdtempSync(join(tmpdir(), "nx-ent-interceptor-"));
  sandboxRoots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  return { dataDir, auditFile: join(root, "audit.ndjson") };
}

afterAll(() => {
  for (const root of sandboxRoots) rmSync(root, { recursive: true, force: true });
});

/** In-memory SecretStore so the audit HMAC key never touches a real keychain/vault. */
function fakeSecretStore(): SecretStore {
  const store = new Map<string, string>();
  return {
    async get(ref) {
      return store.get(ref) ?? null;
    },
    async set(ref, value) {
      store.set(ref, value);
    },
    async delete(ref) {
      store.delete(ref);
    },
    async source(ref) {
      return store.has(ref) ? "file" : null;
    },
  };
}

/** Read every committed NDJSON audit record straight off disk. */
function readAuditRecords(auditFile: string): AuditRecord[] {
  const text = readFileSync(auditFile, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

const VIEWER: Principal = { id: "viewer1", roles: ["viewer"] };
const ADMIN: Principal = { id: "admin1", roles: ["admin"] };

const WRITE_TOOL: Tool = {
  name: "fs_write",
  description: "Write a file.",
  permission: "write",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async run() {
    return okText("written");
  },
};

async function buildServices(box: { dataDir: string; auditFile: string }) {
  const config = NexusConfig.parse({
    enterprise: {
      mode: "on",
      principals: [
        { id: VIEWER.id, roles: VIEWER.roles },
        { id: ADMIN.id, roles: ADMIN.roles },
      ],
      audit: { file: box.auditFile },
    },
  });
  return buildEnterprise(config, fakeSecretStore(), {
    env: { ...process.env, NEXUS_DATA_DIR: box.dataDir },
  });
}

describe("enterpriseToolInterceptor — RBAC enforcement on the native tool loop (ENT-02)", () => {
  it("blocks a write-permission tool call for a viewer principal and audits the deny", async () => {
    const box = sandbox();
    const services = await buildServices(box);
    const registry = new ToolRegistry();
    registry.register(WRITE_TOOL);
    const interceptor = enterpriseToolInterceptor(services, VIEWER, registry, "sess-1");

    const verdict = await interceptor.preTool?.({ name: "fs_write", input: {} });

    expect(verdict?.block).toBe(true);
    // The RBAC deny reason (RoleStore.explain's fail-closed message).
    expect(verdict?.reason).toMatch(/denied \(fail closed\)/);
    expect(verdict?.reason).toContain("write");
    expect(verdict?.reason).toContain("tool:fs_write");

    // …and a deny record landed in the audit log FILE (not just in memory).
    const records = readAuditRecords(box.auditFile);
    const denyRecord = records.find((r) => r.decision === "deny");
    expect(denyRecord).toBeDefined();
    expect(denyRecord?.actor).toBe("viewer1");
    expect(denyRecord?.resource).toBe("tool:fs_write");
    expect(denyRecord?.action).toBe("rbac.decision");
  });

  it("allows the same write-permission tool call for an admin principal", async () => {
    const box = sandbox();
    const services = await buildServices(box);
    const registry = new ToolRegistry();
    registry.register(WRITE_TOOL);
    const interceptor = enterpriseToolInterceptor(services, ADMIN, registry, "sess-1");

    const verdict = await interceptor.preTool?.({ name: "fs_write", input: {} });

    // Nothing returned ⇒ the tool loop proceeds unblocked.
    expect(verdict).toBeUndefined();

    const records = readAuditRecords(box.auditFile);
    const allowRecord = records.find((r) => r.actor === "admin1");
    expect(allowRecord?.decision).toBe("allow");
    expect(allowRecord?.resource).toBe("tool:fs_write");
  });
});

describe("composeInterceptors — first veto short-circuits second; both postTool run", () => {
  it("a first-interceptor veto blocks the call and the second's preTool never runs", async () => {
    let secondPreToolCalls = 0;
    const first: ToolInterceptor = {
      preTool() {
        return { block: true, reason: "vetoed by first" };
      },
    };
    const second: ToolInterceptor = {
      preTool() {
        secondPreToolCalls += 1;
        return undefined;
      },
    };
    const composed = composeInterceptors(first, second);

    const verdict = await composed?.preTool?.({ name: "any_tool", input: {} });

    expect(verdict).toEqual({ block: true, reason: "vetoed by first" });
    expect(secondPreToolCalls).toBe(0);
  });

  it("runs both postTool hooks on a successful call", async () => {
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const first: ToolInterceptor = {
      postTool(res) {
        firstCalls.push(res.name);
      },
    };
    const second: ToolInterceptor = {
      postTool(res) {
        secondCalls.push(res.name);
      },
    };
    const composed = composeInterceptors(first, second);

    await composed?.postTool?.({ name: "fs_write", ok: true, output: "written" });

    expect(firstCalls).toEqual(["fs_write"]);
    expect(secondCalls).toEqual(["fs_write"]);
  });
});

describe("recordRunSpend — post-run spend lands where the code says it goes (§25)", () => {
  it("prices the usage and records it against the acting principal in services.usageStore", async () => {
    const box = sandbox();
    const services = await buildServices(box);

    const cost = recordRunSpend(
      services,
      ADMIN,
      { inputTokens: 1000, outputTokens: 500 },
      { inputPerMTok: 3, outputPerMTok: 15 },
      { provider: "mock", model: "mock-fast", runId: "run-1" },
    );

    // (1000 * 3 + 500 * 15) / 1_000_000 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);

    const report = services.usageStore.report({ principal: ADMIN.id });
    expect(report.totals.count).toBe(1);
    expect(report.totals.costUsd).toBeCloseTo(0.0105, 6);
  });
});
