/**
 * Shared plumbing for the container tools: the injectable configuration (bin
 * paths + limits) and the helpers that turn a {@link CliExecResult} into a
 * `ToolResult`, including the graceful "binary not installed" path required by
 * the uniform tool pattern (feature-detect; never crash when the CLI is absent).
 */

import type { ToolResult } from "@nexuscode/tools";
import { errText, okText } from "@nexuscode/tools";
import type { CliExecResult } from "./exec.js";
import { DEFAULT_CLI_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from "./exec.js";

/**
 * Injectable configuration for the container-tools factory. Bin paths default to
 * the bare command names (resolved on `PATH`); tests point them at a
 * deterministic fake CLI fixture. Limits are advisory defaults every tool
 * inherits.
 */
export interface ContainerToolsConfig {
  /** `docker` binary (path or name on PATH). Default `"docker"`. */
  dockerBin?: string;
  /** `kubectl` binary (path or name on PATH). Default `"kubectl"`. */
  kubectlBin?: string;
  /** `oc` (OpenShift) binary (path or name on PATH). Default `"oc"`. */
  ocBin?: string;
  /** Wall-clock timeout per invocation in ms. Default 30s. */
  timeoutMs?: number;
  /** Combined stdout+stderr byte cap before truncation. Default 16 MiB. */
  maxOutputBytes?: number;
}

export interface ResolvedConfig {
  dockerBin: string;
  kubectlBin: string;
  ocBin: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export function resolveConfig(config?: ContainerToolsConfig): ResolvedConfig {
  return {
    dockerBin: config?.dockerBin ?? "docker",
    kubectlBin: config?.kubectlBin ?? "kubectl",
    ocBin: config?.ocBin ?? "oc",
    timeoutMs: config?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
    maxOutputBytes: config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
}

/**
 * Map the structured failure fields of a {@link CliExecResult} onto a clear,
 * secret-free error `ToolResult`. Returns `undefined` when the call succeeded
 * (`ok`), letting the caller proceed to parse `stdout`.
 */
export function failureResult(bin: string, r: CliExecResult): ToolResult | undefined {
  if (r.notFound) {
    return errText(
      `${bin} not installed or not on PATH. Install it and ensure \`${bin}\` is runnable, then retry.`,
    );
  }
  if (r.aborted) return errText(`${bin} call was cancelled.`);
  if (r.timedOut) return errText(`${bin} call timed out and was killed.`);
  if (r.outputCapped) return errText(`${bin} output exceeded the byte cap and was truncated (killed).`);
  if (!r.ok) {
    const detail = r.stderr.trim() || r.stdout.trim() || `exit code ${r.exitCode ?? "unknown"}`;
    return errText(`${bin} failed: ${detail}`);
  }
  return undefined;
}

/** Success `ToolResult` carrying raw text (already output-capped by `runCli`). */
export function textResult(text: string): ToolResult {
  return okText(text.length > 0 ? text : "(no output)");
}
