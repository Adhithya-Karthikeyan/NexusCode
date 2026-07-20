import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCodexAdapter, buildCodexArgs } from "@nexuscode/provider-codex";
import { defaultSpawn, type SpawnedChild } from "@nexuscode/provider-subprocess";
import type { CallContext } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

beforeAll(() => {
  chmodSync(FAKE, 0o755);
});

function ctx(signal: AbortSignal, runId = "run_cx"): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId };
}
function req(text = "list files", model = "gpt"): ChatRequest {
  return { model, messages: [{ role: "user", content: [{ type: "text", text }] }] };
}
async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}
function adapterFor(mode: string) {
  return createCodexAdapter({
    bin: FAKE,
    resolveEnv: async () => ({ FAKE_CODEX_MODE: mode }),
    modelMap: { gpt: "gpt-5-codex" },
  });
}

describe("codex adapter — argv", () => {
  it("builds `codex exec --json` with model, sandbox, approval and trailing prompt", () => {
    const args = buildCodexArgs(
      { modelMap: { gpt: "gpt-5-codex" }, sandbox: "workspace-write", approvalMode: "on-request", skipGitRepoCheck: true },
      req("do it"),
    );
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args.join(" ")).toContain("--model gpt-5-codex");
    expect(args.join(" ")).toContain("--sandbox workspace-write");
    expect(args.join(" ")).toContain("--ask-for-approval on-request");
    expect(args).toContain("--skip-git-repo-check");
    expect(args[args.length - 1]).toBe("do it");
  });
});

describe("codex adapter — stream mapping", () => {
  it("maps session/reasoning/text/exec/patch/usage/complete into StreamChunk", async () => {
    const chunks = await collect(adapterFor("success").stream(req(), ctx(new AbortController().signal)));
    const types = chunks.map((c) => c.type);
    expect(types[0]).toBe("run-start");
    expect(types[types.length - 1]).toBe("run-end");

    const init = chunks.find((c) => c.type === "session-init");
    expect(init?.type === "session-init" && init.providerSessionId).toBe("codex-sess-xyz");

    expect(chunks.some((c) => c.type === "reasoning-delta")).toBe(true);
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => (c.type === "text-delta" ? c.text : "")).join("");
    expect(text).toBe("Running the command.");

    const start = chunks.find((c) => c.type === "tool-call-start");
    expect(start?.type === "tool-call-start" && start.name).toBe("shell");
    const tr = chunks.find((c) => c.type === "tool-result");
    expect(tr?.type === "tool-result" && tr.toolCallId).toBe("call_1");

    const fe = chunks.find((c) => c.type === "file-edit");
    expect(fe?.type === "file-edit" && fe.path).toBe("src/added.ts");
    expect(fe?.type === "file-edit" && fe.status).toBe("applied");
    expect(fe?.type === "file-edit" && fe.diff).toContain("+export const y = 1;");

    const usage = chunks.find((c) => c.type === "usage");
    expect(usage?.type === "usage" && usage.usage.inputTokens).toBe(50);
    expect(usage?.type === "usage" && usage.usage.cacheReadTokens).toBe(4);

    const end = chunks[chunks.length - 1];
    expect(end?.type === "run-end" && end.message.content.some((b) => b.type === "text" && b.text === "All done.")).toBe(true);
  });

  it("an error event maps to cli_exit", async () => {
    const chunks = await collect(adapterFor("error").stream(req(), ctx(new AbortController().signal)));
    const last = chunks[chunks.length - 1];
    expect(last?.type === "error" && last.error.code).toBe("cli_exit");
    expect(last?.type === "error" && last.error.message).toContain("overloaded");
  });

  it("a malformed line emits a parse error but the stream continues", async () => {
    const chunks = await collect(adapterFor("malformed").stream(req(), ctx(new AbortController().signal)));
    expect(chunks.some((c) => c.type === "error" && c.error.code === "parse")).toBe(true);
    expect(chunks[chunks.length - 1]?.type).toBe("run-end");
  });

  // Regression: the REAL `codex exec --json` uses the newer thread/turn/item
  // envelope schema (agent text arrives as `item.completed`→`item.type:
  // "agent_message"`). The old mapper only knew the flat `agent_message` type,
  // so text was never captured and every run failed as "completed with no
  // content". This exercises the item-envelope path end-to-end.
  it("maps the newer thread/turn/item schema into text + usage + run-end", async () => {
    const chunks = await collect(adapterFor("thread").stream(req(), ctx(new AbortController().signal)));

    const init = chunks.find((c) => c.type === "session-init");
    expect(init?.type === "session-init" && init.providerSessionId).toBe("codex-sess-xyz");

    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c.type === "text-delta" ? c.text : ""))
      .join("");
    expect(text).toBe("pong");

    expect(chunks.some((c) => c.type === "reasoning-delta")).toBe(true);

    const start = chunks.find((c) => c.type === "tool-call-start");
    expect(start?.type === "tool-call-start" && start.name).toBe("shell");
    const tr = chunks.find((c) => c.type === "tool-result");
    expect(tr?.type === "tool-result" && tr.toolCallId).toBe("item_1");

    const usage = chunks.find((c) => c.type === "usage");
    expect(usage?.type === "usage" && usage.usage.inputTokens).toBe(29);
    expect(usage?.type === "usage" && usage.usage.cacheReadTokens).toBe(27);
    expect(usage?.type === "usage" && usage.usage.reasoningTokens).toBe(2);

    const end = chunks[chunks.length - 1];
    expect(end?.type).toBe("run-end");
    expect(
      end?.type === "run-end" &&
        end.message.content.some((b) => b.type === "text" && b.text === "pong"),
    ).toBe(true);
  });
});

describe("codex adapter — cancellation & capabilities", () => {
  it("aborting kills the child, emits cancelled, no orphan", async () => {
    let last: SpawnedChild | undefined;
    const adapter = createCodexAdapter({
      bin: FAKE,
      spawn: (bin, args, opts) => (last = defaultSpawn(bin, args, opts)),
      resolveEnv: async () => ({ FAKE_CODEX_MODE: "hang" }),
    });
    const ac = new AbortController();
    const chunks: StreamChunk[] = [];
    for await (const c of adapter.stream(req(), ctx(ac.signal))) {
      chunks.push(c);
      if (c.type === "session-init") ac.abort();
    }
    expect(chunks[chunks.length - 1]?.type === "error" && (chunks[chunks.length - 1] as { error: { code: string } }).error.code).toBe("cancelled");
    expect(last).toBeDefined();
    await last!.done;
    expect(last!.killed).toBe(true);
  });

  it("declares coding capabilities and process-kill cancel", async () => {
    const caps = await adapterFor("success").capabilities();
    expect(caps.fileEdit).toBe(true);
    expect(caps.shellExec).toBe(true);
    expect(caps.cancel).toBe("process-kill");
    expect(caps.models.map((m) => m.id)).toContain("gpt-5-codex");
  });
});
