#!/usr/bin/env node
/**
 * Deterministic fake `claude` CLI for offline CLI-integration tests. It ignores
 * its argv and emits the documented `--output-format stream-json` NDJSON:
 * init → text delta → tool_use Edit (a file edit) → tool_result → result:success.
 * NEVER touches the network; not the real Claude Code binary. Pointed at via the
 * `NEXUS_CLAUDE_CODE_BIN` env override so `nexus code` drives it through the
 * SAME engine path as any provider.
 *
 * TWO exceptions to "ignores argv":
 *   - it simulates the real vendor CLI's 404 when handed its own provider id
 *     as a `--model` value (`--model claude-code`) — exactly the bug this
 *     fixture exists to catch (nexus must never invent that flag; a
 *     subprocess provider with no explicit model must omit `--model`
 *     entirely and let the vendor CLI use its own signed-in default).
 *   - when `--effort <level>` is present, the level is echoed into the
 *     STREAMED text delta (`"... effort=<level>"`) — not just the final
 *     `result` line, which a caller may never re-print once the answer was
 *     already streamed — so a CLI-integration test asserting on raw stdout
 *     can see proof the flag genuinely reached this subprocess's argv, the
 *     same proof-of-wire discipline `effort-wire.test.ts` uses at the unit
 *     level.
 */
const SID = "sess-fake-cli-1";
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (process.argv.includes("--version")) {
  process.stdout.write("9.9.9 (fake claude cli)\n");
  process.exit(0);
}

const modelIdx = process.argv.indexOf("--model");
const modelArg = modelIdx >= 0 ? process.argv[modelIdx + 1] : undefined;
if (modelArg === "claude-code" || modelArg === "codex") {
  emit({
    type: "result",
    subtype: "success",
    is_error: true,
    session_id: SID,
    result: `model not found: ${modelArg}`,
  });
  process.exit(0);
}

emit({
  type: "system",
  subtype: "init",
  session_id: SID,
  model: "claude-fake-1",
  tools: ["Edit", "Bash", "Read"],
  mcp_servers: [],
});
const effortIdx = process.argv.indexOf("--effort");
const effortArg = effortIdx >= 0 ? process.argv[effortIdx + 1] : undefined;
const deltaText = effortArg ? `Editing app.ts. effort=${effortArg}` : "Editing app.ts.";
emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: deltaText } } });
emit({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_cli_1",
        name: "Edit",
        input: { file_path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      },
    ],
  },
});
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_cli_1", content: "ok", is_error: false }] } });
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: SID,
  total_cost_usd: 0.001,
  usage: { input_tokens: 20, output_tokens: 8 },
  result: "Done — edited src/app.ts.",
});
