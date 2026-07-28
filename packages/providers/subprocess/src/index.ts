/**
 * @nexuscode/provider-subprocess — the shared base every wrapped coding-CLI
 * adapter is built on. See {@link createSubprocessAdapter}.
 */

export {
  createSubprocessAdapter,
  // Exported for its own tests: a redactor that eats diagnostics turns a
  // recoverable error into an unrecoverable one, so its false-positive
  // behaviour needs pinning as tightly as its masking behaviour.
  redactDiagnostic,
  // Shared secret-shaped-env scrubber, reused by `runBoundedCapture` and by
  // any spec's own one-shot probes (e.g. real model discovery) that need to
  // spawn outside the chat/health paths.
  scrubSecretEnv,
  // A bounded, output-capturing one-shot probe (spawn + timeout + safe reap)
  // for real model discovery (`claude -p "/model"`, `codex doctor --json`)
  // and similar read-only CLI introspection — never the long-lived chat
  // stream, which owns its own cancellation dance.
  runBoundedCapture,
  DEFAULT_PROBE_TIMEOUT_MS,
  type SubprocessConfig,
  type CliSpec,
  type StreamState,
  type BoundedCaptureOptions,
  type BoundedCaptureResult,
} from "./base.js";
export {
  defaultSpawn,
  type SpawnFn,
  type SpawnOptions,
  type SpawnedChild,
  type SpawnExit,
} from "./spawn.js";
export { writeDiff, replaceDiff } from "./diff.js";
