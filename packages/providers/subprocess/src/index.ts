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
  type SubprocessConfig,
  type CliSpec,
  type StreamState,
} from "./base.js";
export {
  defaultSpawn,
  type SpawnFn,
  type SpawnOptions,
  type SpawnedChild,
  type SpawnExit,
} from "./spawn.js";
export { writeDiff, replaceDiff } from "./diff.js";
