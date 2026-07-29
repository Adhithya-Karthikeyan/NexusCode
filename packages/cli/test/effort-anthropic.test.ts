/**
 * Proves `implicitEffortDefaultFor`/`reasoningSupportedFor` resolve as
 * intended against the REAL, unmocked `@nexuscode/provider-anthropic`
 * package — not a synthetic `http-sdk` stand-in — closing the loop on
 * "Anthropic API: enable extended thinking by default" end to end at the
 * registration/capability layer (no live network call is needed for that:
 * registering the real adapter and reading its declared `capabilities()`/
 * `transport` never dispatches a request — see `registerDefaultAnthropicProvider`,
 * `@nexuscode/runtime`).
 *
 * The reported bug this closes: `config.defaultEffort` defaulted to "off"
 * everywhere, so a plain `nexus ask -p anthropic ...` with no `--effort`
 * flag sent NO `reasoning` param at all — a REAL run confirmed zero
 * `reasoning` events (`session, text×3, usage, turn_end, done`). This
 * environment has no `ANTHROPIC_API_KEY`/OAuth session, so a live dispatch
 * can't run here; this test instead proves the exact registration + policy
 * chain a live run would go through, up to (not including) the network call
 * itself — see `packages/providers/anthropic/test/reasoning.test.ts` for the
 * adapter-side proof that `reasoning.enabled` really becomes `thinking` on
 * the wire once it reaches `toNativeRequest`.
 */
import { describe, it, expect } from "vitest";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { buildAuthedRuntime } from "../src/runtime.js";
import { implicitEffortDefaultFor, reasoningSupportedFor } from "../src/model-switch.js";

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

describe("the real anthropic adapter, registered for real (no live network call)", () => {
  it("registers as available (needing a key) even with none configured — 'signed-in-but-not-keyed' still shows up", async () => {
    const config = NexusConfig.parse({ defaultProvider: "anthropic" });
    const runtime = await buildAuthedRuntime(config, { secrets: stubSecrets });
    const status = runtime.statuses.find((s) => s.id === "anthropic");
    expect(status?.kind).toBe("anthropic");
    expect(status?.available).toBe(true);
  });

  it("reasoningSupportedFor is TRUE — the real adapter's capabilities().reasoning + http-sdk transport both check out", async () => {
    const config = NexusConfig.parse({ defaultProvider: "anthropic" });
    const runtime = await buildAuthedRuntime(config, { secrets: stubSecrets });
    expect(reasoningSupportedFor(runtime, "anthropic")).toBe(true);
  });

  it("implicitEffortDefaultFor is \"medium\" — extended thinking is genuinely on by default now, not \"off\" forever", async () => {
    const config = NexusConfig.parse({ defaultProvider: "anthropic" });
    const runtime = await buildAuthedRuntime(config, { secrets: stubSecrets });
    expect(implicitEffortDefaultFor(runtime, "anthropic")).toBe("medium");
  });
});
