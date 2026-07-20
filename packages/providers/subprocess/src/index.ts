/**
 * @nexuscode/provider-subprocess — the shared base every wrapped coding-CLI
 * adapter is built on. See {@link createSubprocessAdapter}.
 */

export {
  createSubprocessAdapter,
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
