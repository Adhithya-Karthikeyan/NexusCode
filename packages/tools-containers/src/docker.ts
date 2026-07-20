/**
 * Docker container tools — read-oriented inspection via the `docker` CLI.
 *
 *   - `docker_ps`     — list containers (`docker ps --format '{{json .}}'`).
 *   - `docker_images` — list images (`docker images --format '{{json .}}'`).
 *   - `docker_logs`   — fetch a container's logs (`docker logs …`).
 *
 * All three are read-only and classed `exec` (they drive a local CLI that talks
 * to the Docker daemon). Every invocation is `execFile` (argv, no shell),
 * secret-scrubbed, timeout- and output-capped, and gracefully degrades to a
 * clear "not installed" ToolResult when `docker` is absent.
 */

import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import { errText } from "@nexuscode/tools";
import type { ResolvedConfig } from "./common.js";
import { failureResult, textResult } from "./common.js";
import type { CliExecOptions, CliExecResult } from "./exec.js";
import { runCli } from "./exec.js";
import { asObject, optBool, optNumber, optString, reqString, safeIdentifier } from "./validate.js";

/**
 * Parse newline-delimited JSON (one object per line, docker's `{{json .}}`
 * format) into an array. Blank lines are skipped; a malformed line yields a
 * `parseError` rather than throwing, so partial daemon output is still useful.
 */
export function parseNdjson(stdout: string): { rows: unknown[]; parseError?: string } {
  const rows: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      return { rows, parseError: `could not parse docker output line: ${trimmed.slice(0, 200)}` };
    }
  }
  return { rows };
}

function jsonResult(bin: string, r: CliExecResult): ToolResult {
  const failure = failureResult(bin, r);
  if (failure) return failure;
  const { rows, parseError } = parseNdjson(r.stdout);
  if (parseError && rows.length === 0) return errText(`docker: ${parseError}`);
  return textResult(JSON.stringify(rows, null, 2));
}

function execOptions(cfg: ResolvedConfig, ctx: ToolContext): CliExecOptions {
  return { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: cfg.timeoutMs, maxOutputBytes: cfg.maxOutputBytes };
}

export function makeDockerPsTool(cfg: ResolvedConfig): Tool {
  return {
    name: "docker_ps",
    description:
      "List Docker containers (running by default; set `all` for stopped too). Returns parsed JSON rows.",
    permission: "exec",
    timeoutMs: cfg.timeoutMs,
    parameters: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include stopped containers (docker ps -a)." },
        filter: {
          type: "string",
          description: "A single docker filter expression, e.g. \"status=running\" or \"name=web\".",
        },
      },
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const all = optBool(o, "all") ?? false;
      const filter = optString(o, "filter");
      const args = ["ps", "--no-trunc", "--format", "{{json .}}"];
      if (all) args.push("-a");
      if (filter !== undefined) args.push("--filter", filter);
      const r = await runCli(cfg.dockerBin, args, execOptions(cfg, ctx));
      return jsonResult(cfg.dockerBin, r);
    },
  };
}

export function makeDockerImagesTool(cfg: ResolvedConfig): Tool {
  return {
    name: "docker_images",
    description: "List Docker images (docker images). Returns parsed JSON rows.",
    permission: "exec",
    timeoutMs: cfg.timeoutMs,
    parameters: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include intermediate images (docker images -a)." },
        filter: { type: "string", description: "A single docker filter expression, e.g. \"dangling=true\"." },
      },
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const all = optBool(o, "all") ?? false;
      const filter = optString(o, "filter");
      const args = ["images", "--no-trunc", "--format", "{{json .}}"];
      if (all) args.push("-a");
      if (filter !== undefined) args.push("--filter", filter);
      const r = await runCli(cfg.dockerBin, args, execOptions(cfg, ctx));
      return jsonResult(cfg.dockerBin, r);
    },
  };
}

export function makeDockerLogsTool(cfg: ResolvedConfig): Tool {
  return {
    name: "docker_logs",
    description:
      "Fetch a Docker container's logs (docker logs). Read-only; supports tail, timestamps, and since.",
    permission: "exec",
    timeoutMs: cfg.timeoutMs,
    parameters: {
      type: "object",
      properties: {
        container: { type: "string", description: "Container name or id (positional; no leading dash)." },
        tail: { type: "number", description: "Number of trailing lines to return (docker logs --tail)." },
        timestamps: { type: "boolean", description: "Prefix each line with a timestamp." },
        since: { type: "string", description: "Only logs since this time, e.g. \"10m\" or an RFC3339 stamp." },
      },
      required: ["container"],
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const container = safeIdentifier(reqString(o, "container"), "container");
      const tail = optNumber(o, "tail");
      const timestamps = optBool(o, "timestamps") ?? false;
      const since = optString(o, "since");
      const args = ["logs"];
      if (tail !== undefined) {
        if (!Number.isInteger(tail) || tail < 0) return errText('"tail" must be a non-negative integer');
        args.push("--tail", String(tail));
      }
      if (timestamps) args.push("--timestamps");
      if (since !== undefined) args.push("--since", safeIdentifier(since, "since"));
      args.push(container);
      const r = await runCli(cfg.dockerBin, args, execOptions(cfg, ctx));
      const failure = failureResult(cfg.dockerBin, r);
      if (failure) return failure;
      // docker writes container logs to BOTH stdout and stderr; merge them.
      const merged = [r.stdout, r.stderr].filter((s) => s.trim().length > 0).join("\n");
      return textResult(merged);
    },
  };
}
