/**
 * `@nexuscode/sdk` — the public embeddable API (system-spec §24).
 *
 * ```ts
 * import { createNexus } from "@nexuscode/sdk";
 *
 * const nexus = await createNexus({ config: { defaultProvider: "mock" } });
 * const run = nexus.ask("hello", { model: "mock-fast" });
 * for await (const delta of run.textStream()) process.stdout.write(delta);
 * const result = await run.result();
 * await nexus.dispose();
 * ```
 *
 * One import embeds the whole harness: the primitives (`ask` / `compare` /
 * `race` / `consensus` / `chain`), the agentic `agent` loop, provider + tool
 * registration, a live event stream, and session open/resume — all over the
 * SAME engine the CLI drives. The facade is a client of the kernel; it reuses
 * the shared `@nexuscode/runtime` bootstrap and never re-implements the engine.
 */

export {
  Nexus,
  NexusSession,
  createNexus,
} from "./nexus.js";
export type {
  NexusOptions,
  NexusEvents,
  Backend,
  SamplingOptions,
  AskOptions,
  MultiLaneOptions,
  RaceOptions,
  ConsensusOptions,
  ChainStageSpec,
  ChainOptions,
  AgentRunOptions,
  ProviderInfo,
  ToolInfo,
  RegisterProviderOptions,
} from "./nexus.js";

export { NexusRun } from "./run.js";
export type { RunProjection, RunSink } from "./run.js";

export { Broadcast, Emitter } from "./emitter.js";
export type { Unsubscribe } from "./emitter.js";

// Full typing for consumers: the frozen kernel/shared/tools/config contracts.
export * from "./types.js";
