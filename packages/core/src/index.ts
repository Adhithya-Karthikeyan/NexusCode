/**
 * @nexuscode/core — the kernel: the `ProviderAdapter` contract, provider
 * registry + capability negotiation, centralized resilience, the in-process
 * event bus, the session/turn/run engine, and orchestration dispatch.
 *
 * Re-exports `@nexuscode/shared` so provider packages can import every contract
 * from a single entry point (matching the adapter examples in the plan).
 */

export * from "@nexuscode/shared";

export * from "./adapter.js";
export * from "./cancel.js";
export * from "./resilience.js";
export * from "./stream-contract.js";
export * from "./switching.js";
export * from "./bus.js";
export * from "./registry.js";
export * from "./types.js";
export * from "./engine.js";
export {
  dispatch,
  dispatchAgent,
  dispatchRoute,
  selectRoute,
  // Write-time `RunResult.toolExchange` guards — see the doc comment above
  // their definitions. Exported for offline whitebox tests.
  guardToolExchange,
  truncateToolResultForHistory,
  MAX_TOOL_RESULT_HISTORY_BYTES,
  type AgentOptions,
  type ToolInterceptor,
  type ToolInterceptRequest,
  type ToolInterceptVerdict,
  type DispatchOptions,
  type RouteDispatchOptions,
  type RouteRunSpec,
} from "./orchestrate/orchestrator.js";
export * from "./orchestrate/judge.js";
export * from "./router.js";
export * from "./provider-circuit.js";
export * from "./projection.js";
export * from "./trace.js";
export * from "./partial-recovery.js";
