/**
 * Kubernetes / OpenShift tools — read-oriented inspection via the `kubectl` (or
 * `oc`) CLI.
 *
 *   - `k8s_get`  — list pods / services / deployments (`kubectl get <res> -o json`).
 *   - `k8s_logs` — fetch a pod's logs (`kubectl logs <pod> …`).
 *
 * Both accept an optional `cli: "kubectl" | "oc"` selector so the same tools
 * drive vanilla Kubernetes and OpenShift clusters. They are read-only and classed
 * `network` (they reach a remote cluster API server). Every invocation is
 * `execFile` (argv, no shell), secret-scrubbed, timeout- and output-capped, and
 * gracefully degrades to a clear "not installed" ToolResult when the binary is
 * absent.
 *
 * `k8s_get` restricts the resource kind to a read-safe allowlist
 * (pods/services/deployments and their common aliases). Any resource outside the
 * list is rejected up front — the tools never expose a mutating verb.
 */

import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import { errText } from "@nexuscode/tools";
import type { ResolvedConfig } from "./common.js";
import { failureResult, textResult } from "./common.js";
import type { CliExecOptions } from "./exec.js";
import { runCli } from "./exec.js";
import { asObject, optBool, optEnum, optNumber, optString, reqString, safeIdentifier } from "./validate.js";

/** CLI variants the k8s tools can drive. */
export const K8S_CLIS = ["kubectl", "oc"] as const;
export type K8sCli = (typeof K8S_CLIS)[number];

/**
 * The read-safe resource kinds `k8s_get` accepts, mapped to their canonical
 * `kubectl get` argument. Anything not in this map is refused, keeping the tool
 * strictly read-only over a bounded surface.
 */
const RESOURCE_ALIASES: Record<string, string> = {
  pod: "pods",
  pods: "pods",
  po: "pods",
  service: "services",
  services: "services",
  svc: "services",
  deployment: "deployments",
  deployments: "deployments",
  deploy: "deployments",
};

export const ALLOWED_RESOURCES = Object.keys(RESOURCE_ALIASES);

function execOptions(cfg: ResolvedConfig, ctx: ToolContext): CliExecOptions {
  return { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: cfg.timeoutMs, maxOutputBytes: cfg.maxOutputBytes };
}

function binFor(cfg: ResolvedConfig, cli: K8sCli): string {
  return cli === "oc" ? cfg.ocBin : cfg.kubectlBin;
}

export function makeK8sGetTool(cfg: ResolvedConfig): Tool {
  return {
    name: "k8s_get",
    description:
      "List Kubernetes/OpenShift pods, services, or deployments (kubectl/oc get -o json). Read-only.",
    permission: "network",
    timeoutMs: cfg.timeoutMs,
    parameters: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          description: `Resource kind: one of ${ALLOWED_RESOURCES.join(", ")}.`,
        },
        namespace: { type: "string", description: "Namespace (-n). Omit for the current context's namespace." },
        allNamespaces: { type: "boolean", description: "List across all namespaces (--all-namespaces)." },
        selector: { type: "string", description: "Label selector (-l), e.g. \"app=web,tier=frontend\"." },
        name: { type: "string", description: "A specific resource name to get (positional; no leading dash)." },
        cli: { type: "string", enum: [...K8S_CLIS], description: "CLI to use: kubectl (default) or oc." },
      },
      required: ["resource"],
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const rawResource = reqString(o, "resource").toLowerCase();
      const resource = RESOURCE_ALIASES[rawResource];
      if (resource === undefined) {
        return errText(`"resource" must be one of: ${ALLOWED_RESOURCES.join(", ")}`);
      }
      const cli = optEnum(o, "cli", K8S_CLIS) ?? "kubectl";
      const namespace = optString(o, "namespace");
      const allNamespaces = optBool(o, "allNamespaces") ?? false;
      const selector = optString(o, "selector");
      const name = optString(o, "name");

      const args = ["get", resource];
      if (name !== undefined) args.push(safeIdentifier(name, "name"));
      if (allNamespaces) args.push("--all-namespaces");
      else if (namespace !== undefined) args.push("-n", safeIdentifier(namespace, "namespace"));
      if (selector !== undefined) args.push("-l", selector);
      args.push("-o", "json");

      const bin = binFor(cfg, cli);
      const r = await runCli(bin, args, execOptions(cfg, ctx));
      const failure = failureResult(bin, r);
      if (failure) return failure;
      // Pretty-print when it parses; otherwise hand back the raw text unharmed.
      try {
        return textResult(JSON.stringify(JSON.parse(r.stdout), null, 2));
      } catch {
        return textResult(r.stdout);
      }
    },
  };
}

export function makeK8sLogsTool(cfg: ResolvedConfig): Tool {
  return {
    name: "k8s_logs",
    description:
      "Fetch a Kubernetes/OpenShift pod's logs (kubectl/oc logs). Read-only; supports container, tail, since, previous.",
    permission: "network",
    timeoutMs: cfg.timeoutMs,
    parameters: {
      type: "object",
      properties: {
        pod: { type: "string", description: "Pod name (positional; no leading dash)." },
        namespace: { type: "string", description: "Namespace (-n)." },
        container: { type: "string", description: "Container within the pod (-c)." },
        tail: { type: "number", description: "Number of trailing lines to return (--tail)." },
        since: { type: "string", description: "Only logs newer than this, e.g. \"10m\" or \"1h\" (--since)." },
        previous: { type: "boolean", description: "Logs from the previous terminated container (--previous)." },
        cli: { type: "string", enum: [...K8S_CLIS], description: "CLI to use: kubectl (default) or oc." },
      },
      required: ["pod"],
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const pod = safeIdentifier(reqString(o, "pod"), "pod");
      const cli = optEnum(o, "cli", K8S_CLIS) ?? "kubectl";
      const namespace = optString(o, "namespace");
      const container = optString(o, "container");
      const tail = optNumber(o, "tail");
      const since = optString(o, "since");
      const previous = optBool(o, "previous") ?? false;

      const args = ["logs", pod];
      if (namespace !== undefined) args.push("-n", safeIdentifier(namespace, "namespace"));
      if (container !== undefined) args.push("-c", safeIdentifier(container, "container"));
      if (tail !== undefined) {
        if (!Number.isInteger(tail) || tail < 0) return errText('"tail" must be a non-negative integer');
        args.push("--tail", String(tail));
      }
      if (since !== undefined) args.push("--since", safeIdentifier(since, "since"));
      if (previous) args.push("--previous");

      const bin = binFor(cfg, cli);
      const r = await runCli(bin, args, execOptions(cfg, ctx));
      const failure = failureResult(bin, r);
      if (failure) return failure;
      return textResult(r.stdout);
    },
  };
}
