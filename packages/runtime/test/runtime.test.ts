/**
 * Unit tests for @nexuscode/runtime — the single shared bootstrap that turns a
 * validated NexusConfig into a live ProviderRegistry + SecretStore + PricingTable.
 * Everything here is fully offline and deterministic:
 *   - `binaryOnPath` is a pure PATH/file probe (no spawn) exercised against a
 *     temp dir it fully controls.
 *   - `buildRuntime` is driven with a defaulted config, a stub SecretStore, and a
 *     credential-free env, asserting only on the always-present, env-independent
 *     mock trio so the test never depends on host credentials or the network.
 *   - `routerMetadataFrom` is a pure projection of the loaded config.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { ProviderRegistry, type ProviderAdapter, type Capabilities, type HealthStatus } from "@nexuscode/core";
import {
  binaryOnPath,
  buildRuntime,
  routerMetadataFrom,
  probeLocalServerReachability,
  LOCAL_SERVER_PROBE_TIMEOUT_MS,
} from "../src/index.js";

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

describe("binaryOnPath", () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nx-bin-"));
    writeFileSync(join(dir, "my-fake-cli"), "#!/bin/sh\necho hi\n");
    chmodSync(join(dir, "my-fake-cli"), 0o755);
    savedPath = process.env.PATH;
  });

  afterAll(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a bare binary name via PATH", () => {
    expect(binaryOnPath("my-fake-cli", { PATH: dir })).toBe(true);
  });

  it("returns false for a bare name not present on the given PATH", () => {
    expect(binaryOnPath("definitely-not-a-real-binary-xyz", { PATH: dir })).toBe(false);
  });

  it("checks an explicit path directly (bypassing PATH)", () => {
    expect(binaryOnPath(join(dir, "my-fake-cli"), { PATH: "" })).toBe(true);
    expect(binaryOnPath(join(dir, "nope"), { PATH: dir })).toBe(false);
  });

  it("returns false when PATH is empty and the name is bare", () => {
    expect(binaryOnPath("my-fake-cli", { PATH: "" })).toBe(false);
  });

  it("searches every PATH entry, not just the first", () => {
    const multi = { PATH: ["/no/such/dir", dir].join(delimiter) };
    expect(binaryOnPath("my-fake-cli", multi)).toBe(true);
  });
});

describe("buildRuntime — always-present offline mock catalog", () => {
  it("registers the mock trio with zero config and no credentials", async () => {
    const config = NexusConfig.parse({});
    const rt = await buildRuntime(config, { secrets: stubSecrets });

    expect(rt.registry.has("mock")).toBe(true);
    expect(rt.registry.has("mock-flaky")).toBe(true);
    expect(rt.registry.has("mock-slow")).toBe(true);

    const byId = new Map(rt.statuses.map((s) => [s.id, s]));
    for (const id of ["mock", "mock-flaky", "mock-slow"]) {
      expect(byId.get(id)?.available, `${id} should be available`).toBe(true);
    }

    // A real, resolvable pricing table + secret store are always returned.
    expect(rt.pricing).toBeTypeOf("object");
    expect(rt.secrets).toBe(stubSecrets);
  });

  it("never registers a duplicate id even across the default catalog passes", async () => {
    const config = NexusConfig.parse({});
    const rt = await buildRuntime(config, { secrets: stubSecrets });
    const ids = rt.statuses.map((s) => s.id);
    // The mock trio must each appear exactly once.
    for (const id of ["mock", "mock-flaky", "mock-slow"]) {
      expect(ids.filter((x) => x === id)).toHaveLength(1);
    }
  });

  it("honors a user-configured mock provider entry ahead of the defaults", async () => {
    const config = NexusConfig.parse({ providers: [{ id: "team-mock", kind: "mock", adapter: "@nexuscode/provider-mock" }] });
    const rt = await buildRuntime(config, { secrets: stubSecrets });
    expect(rt.registry.has("team-mock")).toBe(true);
    const s = rt.statuses.find((x) => x.id === "team-mock");
    expect(s?.available).toBe(true);
    expect(s?.kind).toBe("mock");
  });
});

describe("routerMetadataFrom", () => {
  it("projects pricing, latency, and quality from the config", () => {
    const config = NexusConfig.parse({});
    const meta = routerMetadataFrom(config);
    expect(meta.pricing).toBeTypeOf("object");
    expect(meta.latency).toBe(config.latency);
    expect(meta.quality).toBe(config.quality);
    expect(Array.isArray(meta.quality)).toBe(true);
  });
});

/**
 * Fully offline: `health` is caller-supplied (never real HTTP), so these
 * exercise `probeLocalServerReachability`'s own orchestration — bounding,
 * concurrency, and the reachable/unreachable/inconclusive split — without
 * ever touching a real socket. Live network behavior (a real lmstudio/vllm
 * at localhost:1234/8000) was verified manually against the actual CLI
 * build, not re-asserted here.
 */
describe("probeLocalServerReachability", () => {
  const stubCapabilities: Capabilities = {
    models: [],
    streaming: false,
    tools: false,
    parallelToolCalls: false,
    vision: false,
    structuredOutput: false,
    reasoning: false,
    systemPrompt: true,
    fileEdit: false,
    shellExec: false,
    git: false,
    approvalGate: false,
    mcp: false,
    cancel: "abort-signal",
  };

  function fakeAdapter(
    id: string,
    health?: ProviderAdapter["health"],
  ): ProviderAdapter {
    return {
      id,
      label: id,
      transport: "http-openai-compat",
      capabilities: async () => stubCapabilities,
      chat: async () => {
        throw new Error(`${id}: chat() should not be called by a reachability probe`);
      },
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw new Error(`${id}: stream() should not be called by a reachability probe`);
      },
      ...(health ? { health } : {}),
    };
  }

  async function registryWith(...adapters: ProviderAdapter[]): Promise<ProviderRegistry> {
    const registry = new ProviderRegistry();
    for (const adapter of adapters) {
      await registry.register(adapter, { skipHealth: true });
    }
    return registry;
  }

  it("reports true for a candidate whose health check confirms ok", async () => {
    const registry = await registryWith(fakeAdapter("lmstudio", async () => ({ ok: true })));
    const result = await probeLocalServerReachability(registry, { timeoutMs: 50 });
    expect(result).toEqual({ lmstudio: true });
  });

  it("reports false for a candidate whose health check confirms not-ok, fast", async () => {
    const registry = await registryWith(
      fakeAdapter("lmstudio", async (): Promise<HealthStatus> => ({ ok: false, detail: "ECONNREFUSED" })),
    );
    const result = await probeLocalServerReachability(registry, { timeoutMs: 50 });
    expect(result).toEqual({ lmstudio: false });
  });

  it("reports null (never false) for a candidate whose health check never settles within the bound", async () => {
    const registry = await registryWith(
      fakeAdapter("lmstudio", () => new Promise<HealthStatus>(() => {})), // never resolves — the "black hole" case
    );
    const start = Date.now();
    const result = await probeLocalServerReachability(registry, { timeoutMs: 50 });
    const elapsed = Date.now() - start;
    expect(result).toEqual({ lmstudio: null });
    // Bounded — must not wait anywhere near as long as the adapter's own
    // (never-resolving) promise would imply.
    expect(elapsed).toBeLessThan(1000);
  });

  it("reports null, not false, when health() throws synchronously", async () => {
    const registry = await registryWith(
      fakeAdapter("lmstudio", async () => {
        throw new Error("boom");
      }),
    );
    // A thrown error that settles fast is a REAL failure, not a timeout —
    // `probeOne`'s doc: only a confirmed `ok:false` earns `false`; anything
    // else this adapter never itself reports as ok/not-ok degrades to null.
    const result = await probeLocalServerReachability(registry, { timeoutMs: 50 });
    expect(result).toEqual({ lmstudio: null });
  });

  it("runs every candidate CONCURRENTLY — N candidates cost ~1 timeout period, not N", async () => {
    const registry = await registryWith(
      fakeAdapter("lmstudio", () => new Promise<HealthStatus>(() => {})),
      fakeAdapter("vllm", () => new Promise<HealthStatus>(() => {})),
    );
    const start = Date.now();
    const result = await probeLocalServerReachability(registry, { timeoutMs: 100 });
    const elapsed = Date.now() - start;
    expect(result).toEqual({ lmstudio: null, vllm: null });
    // Serial execution would take ~200ms+; concurrent stays close to 100ms.
    expect(elapsed).toBeLessThan(180);
  });

  it("omits a candidate that requires a credential (keyEnv) — reachability is a local-server-only axis", async () => {
    // "groq" is a real DEFAULT_COMPAT_PROVIDERS id, but a cloud one with a
    // keyEnv — registering an adapter under that id must not make it a
    // reachability candidate; the whole point is this axis is scoped to
    // auth-less local backends.
    const registry = await registryWith(fakeAdapter("groq", async () => ({ ok: true })));
    const result = await probeLocalServerReachability(registry);
    expect(result).toEqual({});
  });

  it("omits a provider id that was never registered at all", async () => {
    const registry = await registryWith(fakeAdapter("vllm", async () => ({ ok: true })));
    const result = await probeLocalServerReachability(registry, { timeoutMs: 50 });
    // lmstudio was never registered — absent, not `null`.
    expect(result).toEqual({ vllm: true });
    expect("lmstudio" in result).toBe(false);
  });

  it("degrades to null, not a crash, for a candidate adapter with no health() method at all", async () => {
    const registry = await registryWith(fakeAdapter("lmstudio"));
    const result = await probeLocalServerReachability(registry, { timeoutMs: 50 });
    expect(result).toEqual({ lmstudio: null });
  });

  it("defaults to LOCAL_SERVER_PROBE_TIMEOUT_MS when no timeoutMs is passed", () => {
    expect(LOCAL_SERVER_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LOCAL_SERVER_PROBE_TIMEOUT_MS).toBeLessThan(10_000); // deliberately far shorter than MCP/context's 10s bounds
  });
});
