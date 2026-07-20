/**
 * ProcessManager-backed agent tools (system-spec §13 · §6). These expose the
 * background-job control surface of {@link ProcessManager} to the native tool
 * loop, so an agent can launch a long-running command, poll its output, list
 * running jobs, and kill one — without blocking the OODA step on completion.
 *
 * They are NOT part of `builtinTools()` (which stays a stable, filesystem-only
 * suite): a caller wires them explicitly with {@link jobTools}, passing the
 * shared {@link ProcessManager} whose lifecycle it owns (and reaps on exit).
 *
 * Safety mirrors `shell_exec`: argv arrays (never `shell:true`), a
 * secret-scrubbed base env, and a combined-output byte cap enforced by the
 * manager. A spawned job is deliberately NOT tied to the tool call's
 * `AbortSignal` — the call returns immediately while the job keeps running.
 */

import { okText, errText, type Tool, type ToolResult } from "../types.js";
import { asObject, optString, optStringArray, optStringRecord, reqString } from "../validate.js";
import type { JobInfo, ProcessManager } from "./process-manager.js";

/** One-line, secret-free summary of a job snapshot. */
function summarizeJob(info: JobInfo): string {
  const argv = [info.command, ...info.args].join(" ");
  const pid = info.pid ?? "?";
  const exit =
    info.status === "running"
      ? ""
      : ` exit=${info.exitCode ?? "null"}${info.signal ? ` signal=${info.signal}` : ""}`;
  const capped = info.outputCapped ? " (output capped)" : "";
  const timedOut = info.timedOut ? " (timed out)" : "";
  return `${info.id}  [${info.status}] pid=${pid} ${argv}${exit} bytes=${info.outputBytes}${capped}${timedOut}`;
}

/** `job_spawn` — launch a background job; returns its id immediately. */
export function jobSpawnTool(manager: ProcessManager): Tool {
  return {
    name: "job_spawn",
    description:
      "Launch a background job (argv array, no shell). Returns its job id immediately; the job keeps running. Poll it with job_output, list with job_list, stop with job_kill.",
    permission: "exec",
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "Executable to run (no shell interpretation)." },
        args: { type: "array", items: { type: "string" }, description: "Argument vector." },
        cwd: { type: "string", description: "Working directory." },
        env: { type: "object", additionalProperties: { type: "string" }, description: "Extra env vars." },
      },
    },
    run(input: unknown): Promise<ToolResult> {
      const o = asObject(input);
      const command = reqString(o, "command");
      const args = optStringArray(o, "args");
      const cwd = optString(o, "cwd");
      const env = optStringRecord(o, "env");
      try {
        const job = manager.spawn({
          command,
          ...(args !== undefined ? { args } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(env !== undefined ? { env } : {}),
        });
        return Promise.resolve(okText(`started ${summarizeJob(job.info())}`));
      } catch (err) {
        // FIX A/C: ProcessManager.spawn refuses (throws) at the concurrency cap
        // or on a workspace-escaping cwd — surface that as a clean tool error
        // rather than letting the exception propagate.
        return Promise.resolve(errText(err instanceof Error ? err.message : String(err)));
      }
    },
  };
}

/** `job_list` — snapshot every tracked job. */
export function jobListTool(manager: ProcessManager): Tool {
  return {
    name: "job_list",
    description: "List every tracked background job with its status, pid, and output byte count.",
    permission: "read",
    parameters: { type: "object", properties: {} },
    run(): Promise<ToolResult> {
      const jobs = manager.list();
      if (jobs.length === 0) return Promise.resolve(okText("no background jobs"));
      return Promise.resolve(okText(jobs.map(summarizeJob).join("\n")));
    },
  };
}

/** `job_output` — buffered combined output of a job by id. */
export function jobOutputTool(manager: ProcessManager): Tool {
  return {
    name: "job_output",
    description: "Return the buffered combined stdout+stderr of a background job by id.",
    permission: "read",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "The job id from job_spawn." } },
    },
    run(input: unknown): Promise<ToolResult> {
      const id = reqString(asObject(input), "id");
      const job = manager.get(id);
      if (!job) return Promise.resolve(errText(`no job with id "${id}"`));
      const out = job.output();
      return Promise.resolve(okText(out.length > 0 ? out : "(no output yet)"));
    },
  };
}

/** `job_kill` — terminate a background job (SIGTERM→SIGKILL) and report status. */
export function jobKillTool(manager: ProcessManager): Tool {
  return {
    name: "job_kill",
    description: "Terminate a background job by id (SIGTERM escalating to SIGKILL) and report its final status.",
    permission: "exec",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "The job id from job_spawn." } },
    },
    async run(input: unknown): Promise<ToolResult> {
      const id = reqString(asObject(input), "id");
      const info = await manager.kill(id);
      if (!info) return errText(`no job with id "${id}"`);
      return okText(`killed ${summarizeJob(info)}`);
    },
  };
}

/**
 * The full ProcessManager tool set, bound to one shared manager. Wire these into
 * the agent's tool registry when background-job control is desired; the caller
 * owns the manager and MUST reap it (e.g. `manager.killAll()`) on exit.
 */
export function jobTools(manager: ProcessManager): Tool[] {
  return [jobSpawnTool(manager), jobListTool(manager), jobOutputTool(manager), jobKillTool(manager)];
}
