import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClaudeCodeAdapter, buildClaudeCodeArgs } from "@nexuscode/provider-claude-code";
import { defaultSpawn, type SpawnedChild } from "@nexuscode/provider-subprocess";
import type { CallContext } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

beforeAll(() => {
  chmodSync(FAKE, 0o755);
});

function ctx(signal: AbortSignal, runId = "run_cc"): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId };
}
function req(text = "fix the bug", model = "sonnet"): ChatRequest {
  return { model, messages: [{ role: "user", content: [{ type: "text", text }] }] };
}
async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

/** A spawn wrapper that records the most recent child (to assert no orphan). */
function spyingSpawn() {
  let last: SpawnedChild | undefined;
  const spawn = (bin: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const child = defaultSpawn(bin, args, opts);
    last = child;
    return child;
  };
  return { spawn, get last() { return last; } };
}

function adapterFor(mode: string, extra: Record<string, unknown> = {}) {
  return createClaudeCodeAdapter({
    bin: FAKE,
    resolveEnv: async () => ({ FAKE_CLAUDE_MODE: mode }),
    modelMap: { sonnet: "claude-sonnet-4-6" },
    ...extra,
  });
}

describe("claude-code adapter — argv", () => {
  it("builds the documented stream-json drive contract", () => {
    const args = buildClaudeCodeArgs(
      { modelMap: { sonnet: "claude-sonnet-4-6" }, permissionMode: "acceptEdits", allowedTools: ["Edit", "Bash"], resume: "sess-9" },
      { model: "sonnet", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], system: "be terse" },
    );
    expect(args).toContain("-p");
    expect(args).toContain("hello");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args.join(" ")).toContain("--model claude-sonnet-4-6");
    expect(args.join(" ")).toContain("--permission-mode acceptEdits");
    expect(args.join(" ")).toContain("--allowedTools Edit,Bash");
    expect(args.join(" ")).toContain("--append-system-prompt be terse");
    expect(args.join(" ")).toContain("--resume sess-9");
  });
});

describe("claude-code adapter — full stream mapping", () => {
  it("maps init → deltas → tool_use Edit (file-edit) → tool_result → result:success", async () => {
    const ac = new AbortController();
    const chunks = await collect(adapterFor("success").stream(req(), ctx(ac.signal)));
    const types = chunks.map((c) => c.type);

    expect(types[0]).toBe("run-start");
    expect(types[types.length - 1]).toBe("run-end");
    // exactly one run-start, one terminal
    expect(types.filter((t) => t === "run-start")).toHaveLength(1);
    expect(types.filter((t) => t === "run-end" || t === "error")).toHaveLength(1);

    const init = chunks.find((c) => c.type === "session-init");
    expect(init?.type === "session-init" && init.providerSessionId).toBe("sess-fake-abc123");
    expect(init?.type === "session-init" && init.tools).toContain("Edit");
    expect(init?.type === "session-init" && init.mcpServers).toEqual(["filesystem", "github"]);

    expect(chunks.some((c) => c.type === "reasoning-delta")).toBe(true);
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => (c.type === "text-delta" ? c.text : "")).join("");
    expect(text).toBe("Updating app.ts.");

    const start = chunks.find((c) => c.type === "tool-call-start");
    expect(start?.type === "tool-call-start" && start.name).toBe("Edit");

    const fe = chunks.find((c) => c.type === "file-edit");
    expect(fe && fe.type === "file-edit").toBe(true);
    if (fe?.type === "file-edit") {
      expect(fe.path).toBe("src/app.ts");
      expect(fe.status).toBe("proposed"); // default permission mode
      expect(fe.diff).toContain("-const a = 1;");
      expect(fe.diff).toContain("+const a = 2;");
    }

    const tr = chunks.find((c) => c.type === "tool-result");
    expect(tr?.type === "tool-result" && tr.toolCallId).toBe("toolu_edit_1");

    const usage = chunks.find((c) => c.type === "usage");
    expect(usage?.type === "usage" && usage.usage.inputTokens).toBe(100);
    expect(usage?.type === "usage" && usage.usage.reportedCostUsd).toBe(0.0123);

    const end = chunks[chunks.length - 1];
    if (end?.type !== "run-end") throw new Error("expected run-end");
    expect(end.finishReason).toBe("stop");
    expect(end.providerSessionId).toBe("sess-fake-abc123");
    expect(end.message.content.some((b) => b.type === "text" && b.text === "Done — updated the file.")).toBe(true);
    expect(end.usage?.reportedCostUsd).toBe(0.0123);
    for (const c of chunks) expect(c.runId).toBe("run_cc");
  });

  it("marks file-edit applied under acceptEdits and maps Write", async () => {
    const ac = new AbortController();
    const chunks = await collect(adapterFor("write", { permissionMode: "acceptEdits" }).stream(req(), ctx(ac.signal)));
    const fe = chunks.find((c) => c.type === "file-edit");
    expect(fe?.type === "file-edit" && fe.path).toBe("src/new.ts");
    expect(fe?.type === "file-edit" && fe.status).toBe("applied");
    expect(fe?.type === "file-edit" && fe.diff).toContain("+export const x = 42;");
  });

  it("emits a text-delta fallback from the assistant message's text block when no partial-message deltas streamed (fix: dropped final answer)", async () => {
    const ac = new AbortController();
    const chunks = await collect(adapterFor("text-block-only").stream(req(), ctx(ac.signal)));
    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c.type === "text-delta" ? c.text : ""))
      .join("");
    expect(text).toBe("Direct text block answer.");
    expect(chunks[chunks.length - 1]?.type).toBe("run-end");
  });

  it("does not double-emit text when stream_event deltas already streamed it (guarded by emittedContent)", async () => {
    const ac = new AbortController();
    const chunks = await collect(adapterFor("text-with-deltas").stream(req(), ctx(ac.signal)));
    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c.type === "text-delta" ? c.text : ""))
      .join("");
    expect(text).toBe("Streamed answer.");
  });
});

describe("claude-code adapter — completion / error rules", () => {
  it("result error maps to a cli_exit error chunk (rule 1)", async () => {
    const ac = new AbortController();
    const chunks = await collect(adapterFor("error").stream(req(), ctx(ac.signal)));
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type !== "error") throw new Error("expected error");
    expect(last.error.code).toBe("cli_exit");
    expect(last.error.opts.subtype ?? last.error.message).toContain("error_max_turns");
    expect(last.retryable).toBe(false);
  });

  it("a malformed line emits a parse error but the stream keeps going (rule 5)", async () => {
    const ac = new AbortController();
    const chunks = await collect(adapterFor("malformed").stream(req(), ctx(ac.signal)));
    const parseErr = chunks.find((c) => c.type === "error");
    expect(parseErr?.type === "error" && parseErr.error.code).toBe("parse");
    // The stream still completes with a terminal run-end after recovery.
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("run-end");
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => (c.type === "text-delta" ? c.text : "")).join("");
    expect(text).toContain("recovered after bad line");
  });

  it("result:success with zero content is an empty_output soft failure (rule 6)", async () => {
    const ac = new AbortController();
    const chunks = await collect(adapterFor("empty").stream(req(), ctx(ac.signal)));
    const last = chunks[chunks.length - 1];
    expect(last?.type === "error" && last.error.code).toBe("empty_output");
  });

  it("clean exit with content but no result line yields run-end", async () => {
    const ac = new AbortController();
    const chunks = await collect(adapterFor("no-result").stream(req(), ctx(ac.signal)));
    expect(chunks[chunks.length - 1]?.type).toBe("run-end");
  });

  it("non-zero exit with no result line maps to cli_exit carrying the code (rule 3)", async () => {
    const ac = new AbortController();
    const chunks = await collect(adapterFor("exit-nonzero").stream(req(), ctx(ac.signal)));
    const last = chunks[chunks.length - 1];
    expect(last?.type === "error" && last.error.code).toBe("cli_exit");
    expect(last?.type === "error" && last.error.opts.exitCode).toBe(3);
  });
});

describe("claude-code adapter — cancellation (rule 4)", () => {
  it("aborting kills the child, emits cancelled, and leaves no orphan", async () => {
    const spy = spyingSpawn();
    const adapter = createClaudeCodeAdapter({
      bin: FAKE,
      spawn: spy.spawn,
      resolveEnv: async () => ({ FAKE_CLAUDE_MODE: "hang" }),
    });
    const ac = new AbortController();
    const chunks: StreamChunk[] = [];
    for await (const c of adapter.stream(req(), ctx(ac.signal))) {
      chunks.push(c);
      if (c.type === "session-init") ac.abort();
    }
    const last = chunks[chunks.length - 1];
    expect(last?.type === "error" && last.error.code).toBe("cancelled");

    // No orphan: the child was signalled and has exited.
    const child = spy.last;
    expect(child).toBeDefined();
    const exit = await child!.done;
    expect(child!.killed).toBe(true);
    expect(exit.exitCode == null ? exit.signal : "exited").toBeTruthy();
  });

  it("a pre-aborted signal short-circuits to cancelled without hanging", async () => {
    const ac = new AbortController();
    ac.abort();
    const chunks = await collect(adapterFor("hang").stream(req(), ctx(ac.signal)));
    expect(chunks[0]?.type).toBe("run-start");
    expect(chunks[chunks.length - 1]?.type === "error" && (chunks[chunks.length - 1] as { error: { code: string } }).error.code).toBe("cancelled");
  });
});

describe("claude-code adapter — capabilities, health, chat", () => {
  it("declares coding-agent capabilities with process-kill cancel", async () => {
    const caps = await adapterFor("success").capabilities();
    expect(caps.fileEdit).toBe(true);
    expect(caps.shellExec).toBe(true);
    expect(caps.git).toBe(true);
    expect(caps.approvalGate).toBe(true);
    expect(caps.mcp).toBe(true);
    expect(caps.cancel).toBe("process-kill");
    expect(caps.models.map((m) => m.id)).toContain("claude-sonnet-4-6");
  });

  it("health() is ok when the (fake) binary responds to --version", async () => {
    const adapter = createClaudeCodeAdapter({ bin: FAKE, resolveEnv: async () => ({ FAKE_CLAUDE_MODE: "version" }) });
    const h = await adapter.health!(ctx(new AbortController().signal));
    expect(h.ok).toBe(true);
    expect(h.detail).toContain("1.2.3");
  });

  it("health() returns ok:false (never throws) when the binary is not on PATH", async () => {
    const adapter = createClaudeCodeAdapter({ bin: "definitely-not-a-real-binary-xyz" });
    const h = await adapter.health!(ctx(new AbortController().signal));
    expect(h.ok).toBe(false);
  });

  it("chat() buffers the stream into a ChatResult", async () => {
    const res = await adapterFor("success").chat(req(), ctx(new AbortController().signal));
    expect(res.finishReason).toBe("stop");
    expect(res.usage?.inputTokens).toBe(100);
    expect(res.message.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("chat() throws the mapped error on a result:error", async () => {
    await expect(adapterFor("error").chat(req(), ctx(new AbortController().signal))).rejects.toMatchObject({ code: "cli_exit" });
  });
});
