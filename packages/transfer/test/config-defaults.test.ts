import { describe, it, expect } from "vitest";
import { NexusConfigSchema } from "@nexuscode/config";

describe("ContextTransferConfig defaults", () => {
  const cfg = NexusConfigSchema.parse({}).transfer;

  it("is enabled by default and keyed under `transfer`", () => {
    expect(cfg.enabled).toBe(true);
  });

  it("defaults to the safe no-model embedder", () => {
    expect(cfg.embedder).toBe("hashing");
  });

  it("defaults to semantic compression and strict validation", () => {
    expect(cfg.compressionPolicy).toBe("semantic");
    expect(cfg.validationStrictness).toBe("strict");
  });

  it("defaults handoff knobs sensibly", () => {
    expect(cfg.handoff.mode).toBe("full");
    expect(cfg.handoff.inflightWaitMs).toBe(30000);
    expect(cfg.handoff.preventRetryWindow).toBe(5);
  });

  it("dbPath is optional (resolved to history.db at runtime)", () => {
    expect(cfg.dbPath).toBeUndefined();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => NexusConfigSchema.parse({ transfer: { bogus: 1 } })).toThrow();
  });
});