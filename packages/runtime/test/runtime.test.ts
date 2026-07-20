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
import { binaryOnPath, buildRuntime, routerMetadataFrom } from "../src/index.js";

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
