import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createEngine,
  dispatch,
  projectLabeled,
  userText,
  ProviderRegistry,
  type OrchestrationSpec,
  type UiEvent,
} from "@nexuscode/core";
import { createClaudeCodeAdapter } from "@nexuscode/provider-claude-code";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

beforeAll(() => {
  chmodSync(FAKE, 0o755);
});

/**
 * Drive the claude-code subprocess adapter through the SAME engine path every
 * provider uses (register → openSession → dispatch single) against the
 * deterministic fake CLI, and project its `StreamChunk`s to `UiEvent`s. This is
 * the offline proof that a wrapped coding CLI's file-edit / tool-result events
 * flow through the engine and render like any other provider.
 */
async function runViaEngine(): Promise<UiEvent[]> {
  const registry = new ProviderRegistry();
  await registry.register(createClaudeCodeAdapter({ bin: FAKE }), { skipHealth: true });

  const engine = createEngine({ registry, pricing: {} });
  const session = await engine.openSession();
  const turn = session.newTurn({ messages: userText("fix the bug") });

  const spec: OrchestrationSpec = {
    kind: "single",
    run: { adapterId: "claude-code", model: "claude-fake-1", input: turn.input, idempotencyKey: "idem-cc" },
  };

  const events: UiEvent[] = [];
  const handle = dispatch(spec, turn.context());
  for await (const labeled of handle.events()) {
    for (const ev of projectLabeled(labeled, ["claude-code"], true)) {
      events.push(ev);
    }
  }
  const outcome = await handle.outcome();
  expect(outcome.winner?.status).toBe("ok");

  await session.dispose();
  await engine.dispose();
  return events;
}

describe("subprocess provider driven via the engine (fake claude CLI)", () => {
  it("projects file-edit and tool-result StreamChunks to diff/tool_result UiEvents", async () => {
    const events = await runViaEngine();
    const types = events.map((e) => e.t);

    // The session banner, the streamed answer, and terminal are all present.
    expect(types).toContain("session");
    expect(types).toContain("text");
    expect(types).toContain("done");

    // The load-bearing coding-agent events:
    expect(types).toContain("diff");
    expect(types).toContain("tool_result");

    const diff = events.find((e): e is Extract<UiEvent, { t: "diff" }> => e.t === "diff");
    expect(diff?.path).toBe("src/app.ts");
    expect(diff?.patch).toContain("-const a = 1;");
    expect(diff?.patch).toContain("+const a = 2;");

    const toolResult = events.find((e): e is Extract<UiEvent, { t: "tool_result" }> => e.t === "tool_result");
    expect(toolResult?.ok).toBe(true);

    const answer = events
      .filter((e): e is Extract<UiEvent, { t: "text" }> => e.t === "text")
      .map((e) => e.delta)
      .join("");
    expect(answer).toContain("Editing app.ts.");
  }, 20_000);
});
