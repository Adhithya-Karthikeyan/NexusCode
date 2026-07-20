#!/usr/bin/env node
/**
 * A pre-tool command hook fixture. It reads the JSON envelope on stdin (the CLI
 * writes `{ event, payload }` there) and prints a block verdict on stdout with a
 * clean exit 0 — the canonical "veto this tool" response. Fully offline.
 */
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  raw += d;
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ block: true, reason: "vetoed by wave10 test hook" }));
  process.exit(0);
});
