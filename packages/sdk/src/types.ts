/**
 * Curated re-exports so a consumer gets full typing from one import — the
 * contracts an embedder touches when composing runs, reading results, wiring
 * tools/providers, or projecting events. These are the FROZEN kernel/shared
 * contracts; the SDK never redefines them, it only re-surfaces them.
 */

export type {
  // Run / orchestration model
  RunSpec,
  RunResult,
  RunStatus,
  RunContext,
  SamplingParams,
  OrchestrationSpec,
  OrchestrationKind,
  OrchestrationOutcome,
  OrchestrationHandle,
  ChainStage,
  JudgeSpec,
  Judge,
  Score,
  MergedResult,
  ToolCall,
  UnifiedDiff,
  PricingTable,
  EventStore,
  ContextAssembler,
  AssembledContext,
  // Eventing
  UiEvent,
  UiEventType,
  Labeled,
  // Engine + registry
  Engine,
  EngineConfig,
  Session,
  Turn,
  ProviderRegistry,
  ProviderAdapter,
  CallContext,
  CancelScope,
  CancelReason,
  TraceEvent,
  Bus,
} from "@nexuscode/core";

export type {
  // Shared wire contracts
  Message,
  ContentBlock,
  StreamChunk,
  Usage,
  Pricing,
  Capabilities,
  ModelInfo,
  ToolDef,
  FinishReason,
  AdapterError,
  ChatRequest,
} from "@nexuscode/shared";

export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolEvent,
  ToolPermission,
  PermissionMode,
  PermissionGateOptions,
  ApprovalRequest,
  ApproveFn,
} from "@nexuscode/tools";

export type {
  NexusConfig,
  NexusConfigInput,
  ProviderConfig,
  SecretStore,
} from "@nexuscode/config";
