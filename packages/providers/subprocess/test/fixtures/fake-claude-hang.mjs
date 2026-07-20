#!/usr/bin/env node
/**
 * Deterministic fake coding CLI that TRAPS and IGNORES SIGINT, then idles
 * forever. It exits only when it receives SIGTERM. This exercises the
 * subprocess base's SIGINT→SIGTERM escalation: a well-behaved child dies on the
 * default SIGINT and never reaches the escalation path, so a child that ignores
 * SIGINT is required to prove the force-reap actually fires.
 *
 * No network, no real `claude` binary — just Node emitting one NDJSON line then
 * blocking, so the adapter has stdout activity and the abort path is reachable.
 */

// Swallow SIGINT — deliberately do NOT exit.
process.on("SIGINT", () => {
  /* ignored on purpose */
});

// Exit cleanly (with the conventional 128+15 code) once force-killed.
process.on("SIGTERM", () => {
  process.exit(143);
});

// Emit an init-style line so there is stdout activity before we block.
process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);

// Idle forever; keep the event loop alive so only a signal can end us.
setInterval(() => {}, 1 << 30);
