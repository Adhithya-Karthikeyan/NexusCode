#!/usr/bin/env node
/**
 * Deterministic fake `kubectl` / `oc` CLI for offline tests. Emits canned JSON
 * for `get` and reflects the flags it received for `logs`, so tests can assert
 * both parsing and argv plumbing. No cluster, no network. Sentinel pod `missing`
 * exits non-zero.
 */

const args = process.argv.slice(2);
const cmd = args[0];

const SINGULAR = { pods: "Pod", services: "Service", deployments: "Deployment" };

if (cmd === "get") {
  const resource = args[1];
  const nsi = args.indexOf("-n");
  const ns = nsi !== -1 ? args[nsi + 1] : args.includes("--all-namespaces") ? "*" : "default";
  const items = [
    { apiVersion: "v1", kind: SINGULAR[resource] ?? "Unknown", metadata: { name: `${resource}-1`, namespace: ns } },
  ];
  process.stdout.write(JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  process.exit(0);
}

if (cmd === "logs") {
  const pod = args[1];
  if (pod === "missing") {
    process.stderr.write('Error from server (NotFound): pods "missing" not found\n');
    process.exit(1);
  }
  const parts = [`pod=${pod}`];
  const nsi = args.indexOf("-n");
  if (nsi !== -1) parts.push(`ns=${args[nsi + 1]}`);
  const ci = args.indexOf("-c");
  if (ci !== -1) parts.push(`container=${args[ci + 1]}`);
  const ti = args.indexOf("--tail");
  if (ti !== -1) parts.push(`tail=${args[ti + 1]}`);
  if (args.includes("--previous")) parts.push("previous");
  process.stdout.write(parts.join(" ") + "\nlog body line\n");
  process.exit(0);
}

process.stderr.write(`fake-kubectl: unknown command ${cmd}\n`);
process.exit(2);
