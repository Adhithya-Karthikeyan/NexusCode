#!/usr/bin/env node
/**
 * Deterministic fake `docker` CLI for offline tests. No daemon, no network —
 * just Node emitting canned, parseable output keyed off the argv. It reflects a
 * few flags (`-a`, `--tail`) so tests can prove flag plumbing, and supports two
 * sentinel container names: `missing` (non-zero exit) and `hang` (idles forever,
 * to exercise the timeout kill path).
 */

const args = process.argv.slice(2);
const cmd = args[0];

function emitNdjson(rows) {
  process.stdout.write(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

if (cmd === "ps") {
  const all = args.includes("-a");
  const rows = [
    { ID: "abc123def456", Names: "web", Image: "nginx:latest", State: "running", Status: "Up 2 minutes" },
  ];
  if (all) {
    rows.push({
      ID: "789ghi012jkl",
      Names: "db",
      Image: "postgres:16",
      State: "exited",
      Status: "Exited (0) 1 hour ago",
    });
  }
  const fi = args.indexOf("--filter");
  if (fi !== -1 && args[fi + 1] === "name=web") {
    emitNdjson([rows[0]]);
  } else {
    emitNdjson(rows);
  }
  process.exit(0);
}

if (cmd === "images") {
  emitNdjson([
    { Repository: "nginx", Tag: "latest", ID: "sha256:aaaa", Size: "142MB" },
    { Repository: "postgres", Tag: "16", ID: "sha256:bbbb", Size: "420MB" },
  ]);
  process.exit(0);
}

if (cmd === "logs") {
  const container = args[args.length - 1];
  if (container === "missing") {
    process.stderr.write("Error: No such container: missing\n");
    process.exit(1);
  }
  if (container === "hang") {
    // Idle forever so the caller's timeout must fire and kill us.
    setInterval(() => {}, 1 << 30);
  } else {
    let lines = ["log line 1", "log line 2", "log line 3"];
    const ti = args.indexOf("--tail");
    if (ti !== -1) lines = lines.slice(-Number(args[ti + 1]));
    if (args.includes("--timestamps")) lines = lines.map((l, i) => `2020-01-0${i + 1}T00:00:00Z ${l}`);
    process.stdout.write(lines.join("\n") + "\n");
    // A benign warning on stderr exercises the stdout+stderr merge.
    process.stderr.write("");
    process.exit(0);
  }
}

if (cmd === undefined || (cmd !== "ps" && cmd !== "images" && cmd !== "logs")) {
  process.stderr.write(`fake-docker: unknown command ${cmd}\n`);
  process.exit(2);
}
