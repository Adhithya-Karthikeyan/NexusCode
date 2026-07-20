#!/usr/bin/env node
/**
 * Deterministic fake `codex` CLI for offline tests. Emits a scripted sequence of
 * the assumed `codex exec --json` JSONL events (see provider ASSUMPTIONS), keyed
 * by FAKE_CODEX_MODE. Never touches the network; not the real codex binary.
 *
 * Modes: success | error | malformed | hang | version
 */

const mode = process.env.FAKE_CODEX_MODE || "success";
const SID = "codex-sess-xyz";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (mode === "version") {
  process.stdout.write("codex 0.9.0 (fake)\n");
  process.exit(0);
}

// Newer codex-rs schema: thread/turn/item envelopes (bare events, no `msg`).
// This is the shape the REAL `codex exec --json` emits today; the older flat
// `agent_message` schema below is kept for back-compat coverage.
if (mode === "thread") {
  emit({ type: "thread.started", thread_id: SID });
  emit({ type: "turn.started" });
  emit({ type: "item.started", item: { id: "item_0", type: "reasoning", text: "" } });
  emit({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Planning." } });
  emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "ls" } });
  emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", aggregated_output: "app.ts\n", exit_code: 0 } });
  emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "pong" } });
  emit({ type: "turn.completed", usage: { input_tokens: 29, cached_input_tokens: 27, output_tokens: 3, reasoning_output_tokens: 2 } });
  // Fall off the end so Node flushes buffered stdout before exiting (an explicit
  // process.exit(0) can truncate a piped write mid-flush).
}

// Uses the `{id, msg:{type,…}}` envelope form to exercise unwrapping.
else emit({ id: "0", msg: { type: "session_configured", session_id: SID, model: "gpt-fake" } });

if (mode !== "thread") switch (mode) {
  case "success":
    emit({ id: "1", msg: { type: "agent_reasoning_delta", delta: "Planning. " } });
    emit({ id: "2", msg: { type: "agent_message_delta", delta: "Running " } });
    emit({ id: "3", msg: { type: "agent_message_delta", delta: "the command." } });
    emit({ id: "4", msg: { type: "exec_command_begin", call_id: "call_1", command: ["bash", "-lc", "ls"] } });
    emit({ id: "5", msg: { type: "exec_command_end", call_id: "call_1", exit_code: 0, stdout: "app.ts\n" } });
    emit({ id: "6", msg: { type: "apply_patch", changes: { "src/added.ts": { content: "export const y = 1;\n" } } } });
    emit({ id: "7", msg: { type: "token_count", usage: { input_tokens: 50, output_tokens: 12, cached_input_tokens: 4 } } });
    emit({ id: "8", msg: { type: "task_complete", last_agent_message: "All done." } });
    break;
  case "error":
    emit({ id: "1", msg: { type: "agent_message_delta", delta: "Trying…" } });
    emit({ id: "2", msg: { type: "error", message: "model overloaded" } });
    break;
  case "malformed":
    process.stdout.write("<<not json>>\n");
    emit({ id: "1", msg: { type: "agent_message_delta", delta: "recovered" } });
    emit({ id: "2", msg: { type: "task_complete", last_agent_message: "ok" } });
    break;
  case "hang":
    emit({ id: "1", msg: { type: "agent_message_delta", delta: "long work…" } });
    setInterval(() => {}, 1000);
    break;
  default:
    emit({ id: "9", msg: { type: "task_complete" } });
}
