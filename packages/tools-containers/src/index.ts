/**
 * @nexuscode/tools-containers — read-oriented container tools for Docker,
 * Kubernetes, and OpenShift, built on the `@nexuscode/tools` Tool contract.
 *
 * Every tool wraps a CLI (`docker` / `kubectl` / `oc`) invoked via `execFile`
 * (argv array, never a shell), with a secret-scrubbed environment, a wall-clock
 * timeout, and a bounded output buffer. The CLIs are *feature-detected* at call
 * time: when a binary is not on PATH the tool returns a clear "not installed"
 * `ToolResult` (isError) instead of crashing, so nothing is a hard dependency.
 *
 * Tools:
 *   - `docker_ps`     (exec)    — list containers
 *   - `docker_images` (exec)    — list images
 *   - `docker_logs`   (exec)    — container logs
 *   - `k8s_get`       (network) — get pods/services/deployments (kubectl or oc)
 *   - `k8s_logs`      (network) — pod logs (kubectl or oc)
 *
 * `createContainerTools(config)` returns the group's `Tool[]` so an integration
 * layer can register them in a `ToolRegistry`. Bin paths are injectable, which
 * is how the offline test suite points the tools at deterministic fake CLIs.
 */

import type { Tool } from "@nexuscode/tools";
import type { ContainerToolsConfig } from "./common.js";
import { resolveConfig } from "./common.js";
import { makeDockerImagesTool, makeDockerLogsTool, makeDockerPsTool } from "./docker.js";
import { makeK8sGetTool, makeK8sLogsTool } from "./kube.js";

export type { ContainerToolsConfig, ResolvedConfig } from "./common.js";
export {
  runCli,
  DEFAULT_CLI_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "./exec.js";
export type { CliExecOptions, CliExecResult } from "./exec.js";
export { parseNdjson, makeDockerPsTool, makeDockerImagesTool, makeDockerLogsTool } from "./docker.js";
export { makeK8sGetTool, makeK8sLogsTool, K8S_CLIS, ALLOWED_RESOURCES } from "./kube.js";
export type { K8sCli } from "./kube.js";

/**
 * Build the container tool group. Returns a fresh `Tool[]` on every call; each
 * tool closes over the resolved (injectable) configuration.
 */
export function createContainerTools(config?: ContainerToolsConfig): Tool[] {
  const cfg = resolveConfig(config);
  return [
    makeDockerPsTool(cfg),
    makeDockerImagesTool(cfg),
    makeDockerLogsTool(cfg),
    makeK8sGetTool(cfg),
    makeK8sLogsTool(cfg),
  ];
}
