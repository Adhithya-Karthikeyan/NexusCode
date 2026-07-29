#!/usr/bin/env node
/**
 * Deterministic fake `claude` CLI for offline tests. For the chat path it
 * ignores its argv and emits a scripted sequence of the documented
 * `--output-format stream-json` NDJSON, selected by `FAKE_CLAUDE_MODE`. It
 * NEVER touches the network and is not the real Claude Code binary.
 *
 * Modes:
 *   success        init → text deltas → tool_use Edit → tool_result → result:success (exit 0)
 *   write          init → text delta → tool_use Write → tool_result → result:success
 *   error          init → text delta → result:error_max_turns (is_error, exit 0)
 *   malformed      init → <garbage line> → text delta → result:success   (parse-error mid-stream)
 *   empty          init → result:success with no content                  (empty_output)
 *   no-result      init → text delta → exit 0 with NO result line         (content, no terminal)
 *   exit-nonzero   init → process.exit(3) with no result line             (cli_exit)
 *   version        prints a version string to stdout and exits 0          (health probe)
 *   hang           init → text delta → stay alive forever                 (abort/cancel test)
 *   text-block-only    init → assistant text block (NO partial deltas) → result:success
 *   text-with-deltas   init → text delta → assistant text block (same text) → result:success
 *
 * `-p "/model" --output-format json` (real model discovery) is argv-gated
 * SEPARATELY from `FAKE_CLAUDE_MODE` above so the SAME fixture serves both the
 * chat path and the `listModels()` probe without cross-talk. Sub-modes:
 *   model-hang        never exits (probe timeout test)
 *   model-error       exit 1 with no reply
 *   model-malformed   non-JSON stdout
 *   model-empty       valid JSON reply with no "Available:" clause
 *   (anything else)   the real `/model` reply observed from `claude` 2.1.220
 *
 * `-p "/effort" --output-format json` (real effort discovery) is gated the
 * same way, for `listReasoningLevels()`. Sub-modes:
 *   effort-hang        never exits (probe timeout test)
 *   effort-error       exit 1 with no reply
 *   effort-malformed   non-JSON stdout
 *   effort-empty       valid JSON reply with no "Usage:" clause
 *   (anything else)    the real `/effort` reply observed from `claude` 2.1.220
 */

const mode = process.env.FAKE_CLAUDE_MODE || "success";
const SID = "sess-fake-abc123";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (process.argv[2] === "-p" && process.argv[3] === "/model") {
  if (mode === "model-hang") {
    setInterval(() => {}, 1000);
  } else if (mode === "model-error") {
    process.exit(1);
  } else if (mode === "model-malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  } else if (mode === "model-empty") {
    emit({ type: "result", subtype: "success", is_error: false, result: "Current model: X\nNo usage line here." });
    process.exit(0);
  } else {
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0,
      result:
        "Current model: Opus 5 (1M context) (effort: xhigh)\n" +
        "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.",
    });
    process.exit(0);
  }
}
if (process.argv[2] === "-p" && process.argv[3] === "/effort") {
  if (mode === "effort-hang") {
    setInterval(() => {}, 1000);
  } else if (mode === "effort-error") {
    process.exit(1);
  } else if (mode === "effort-malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  } else if (mode === "effort-empty") {
    emit({ type: "result", subtype: "success", is_error: false, result: "no usage clause here" });
    process.exit(0);
  } else {
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0,
      result: "Usage: /effort <low|medium|high|xhigh|max|ultracode|auto>",
    });
    process.exit(0);
  }
}
function init() {
  emit({
    type: "system",
    subtype: "init",
    session_id: SID,
    model: "claude-fake-1",
    tools: ["Edit", "Bash", "Read", "Write"],
    mcp_servers: [{ name: "filesystem" }, { name: "github" }],
  });
}
function textDelta(text) {
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
}
function reasoningDelta(text) {
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: text } } });
}
function toolUseEdit() {
  emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_edit_1",
          name: "Edit",
          input: { file_path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
        },
      ],
    },
  });
}
function toolUseWrite() {
  emit({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_write_1", name: "Write", input: { file_path: "src/new.ts", content: "export const x = 42;\n" } },
      ],
    },
  });
}
function textBlock(text) {
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
}
function toolResult(id) {
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] } });
}
function resultSuccess() {
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: SID,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 42, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    result: "Done — updated the file.",
  });
}

if (mode === "version") {
  process.stdout.write("1.2.3 (fake claude)\n");
  process.exit(0);
}

init();

switch (mode) {
  case "success":
    reasoningDelta("Let me think. ");
    textDelta("Updating ");
    textDelta("app.ts.");
    toolUseEdit();
    toolResult("toolu_edit_1");
    resultSuccess();
    break;
  case "write":
    textDelta("Creating file.");
    toolUseWrite();
    toolResult("toolu_write_1");
    resultSuccess();
    break;
  case "error":
    textDelta("Working…");
    emit({ type: "result", subtype: "error_max_turns", is_error: true, session_id: SID, usage: { input_tokens: 5, output_tokens: 1 } });
    break;
  case "malformed":
    process.stdout.write("this is not valid json at all\n");
    textDelta("recovered after bad line");
    resultSuccess();
    break;
  case "empty":
    emit({ type: "result", subtype: "success", is_error: false, session_id: SID, usage: { input_tokens: 3, output_tokens: 0 }, result: "" });
    break;
  case "no-result":
    textDelta("content but no terminal line");
    process.exit(0);
    break;
  case "exit-nonzero":
    process.exit(3);
    break;
  case "hang":
    textDelta("starting long work…");
    setInterval(() => {}, 1000);
    break;
  case "text-block-only":
    textBlock("Direct text block answer.");
    resultSuccess();
    break;
  case "text-with-deltas":
    textDelta("Streamed answer.");
    textBlock("Streamed answer.");
    resultSuccess();
    break;
  default:
    resultSuccess();
}
