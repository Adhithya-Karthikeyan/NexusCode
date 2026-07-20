import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";

async function freshRegistry(): Promise<ProviderRegistry> {
  const reg = new ProviderRegistry();
  await reg.register(createMockAdapter());
  return reg;
}

describe("ProviderRegistry", () => {
  it("registers and looks up an adapter", async () => {
    const reg = await freshRegistry();
    expect(reg.has("mock")).toBe(true);
    expect(reg.get("mock").id).toBe("mock");
    expect(reg.ids()).toContain("mock");
  });

  it("caches capabilities and health probed at registration", async () => {
    const reg = await freshRegistry();
    expect(reg.capabilitiesOf("mock").streaming).toBe(true);
    expect(reg.healthOf("mock")?.ok).toBe(true);
  });

  it("select() filters by capability predicate", async () => {
    const reg = await freshRegistry();
    expect(reg.select((c) => c.streaming).map((a) => a.id)).toContain("mock");
    // The mock is chat-only: it must NOT match coding-agent capabilities.
    expect(reg.select((c) => c.fileEdit)).toHaveLength(0);
    expect(reg.select((c) => c.shellExec)).toHaveLength(0);
  });

  it("resolveModel maps a known model id to its owning provider", async () => {
    const reg = await freshRegistry();
    const models = reg.capabilitiesOf("mock").models;
    const known = models[0]!.id;
    expect(reg.resolveModel(known)).toEqual({ providerId: "mock", modelId: known });
    expect(reg.resolveModel("no-such-model")).toBeUndefined();
  });

  it("throws on duplicate provider id", async () => {
    const reg = await freshRegistry();
    await expect(reg.register(createMockAdapter())).rejects.toThrow();
  });

  it("throws an AdapterError when getting an unknown provider", async () => {
    const reg = await freshRegistry();
    expect(() => reg.get("ghost")).toThrow(/ghost/);
    expect(() => reg.capabilitiesOf("ghost")).toThrow();
    expect(reg.has("ghost")).toBe(false);
    expect(reg.healthOf("ghost")).toBeUndefined();
  });

  it("disposeAll clears the registry", async () => {
    const reg = await freshRegistry();
    await reg.disposeAll();
    expect(reg.has("mock")).toBe(false);
    expect(reg.ids()).toHaveLength(0);
  });
});
