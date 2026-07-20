import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ProviderRegistry, createEngine, userText, type Message } from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  CapabilityProvider,
  StatusHud,
  ThemeProvider,
  Workspace,
  chunkToUiEvents,
  createEventStore,
  laneKey,
  runTui,
  runTurn,
  type Capabilities,
} from "../src/index.js";
import { singleDispatch, type TurnDispatcher } from "../src/bridge/runTui.js";

/** Text of a message's blocks joined (helper for the memory assertions). */
function messageText(m: Message): string {
  return m.content.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("");
}

const richCaps: Partial<Capabilities> = {
  truecolor: true,
  colors256: true,
  unicode: true,
  noColor: false,
  isTTY: true,
  termDumb: false,
  width: 100,
  height: 40,
};

function wrap(node: React.ReactNode): React.JSX.Element {
  return (
    <CapabilityProvider caps={richCaps}>
      <ThemeProvider>{node}</ThemeProvider>
    </CapabilityProvider>
  );
}

async function mockSession() {
  const registry = new ProviderRegistry();
  await registry.register(createMockAdapter());
  const engine = createEngine({ registry });
  const session = await engine.openSession();
  return { engine, session };
}

describe("engine bridge — projection", () => {
  it("projects a StreamChunk into the matching UiEvent", () => {
    const [ev] = chunkToUiEvents(
      { type: "text-delta", runId: "r", text: "hi", channel: "answer" },
      "main",
    );
    expect(ev).toEqual({ t: "text", lane: "main", delta: "hi" });
  });

  it("resolves the lane key (single collapses to main, compare keeps adapter id)", () => {
    expect(laneKey(0, ["mock"], true)).toBe("main");
    expect(laneKey(1, ["anthropic", "openai"], false)).toBe("openai");
  });
});

describe("engine bridge — runTurn streams a real mock run into the store", () => {
  it("accumulates streamed text + usage from an `ask -p mock` run", async () => {
    const { engine, session } = await mockSession();
    const store = createEventStore();

    const outcome = await runTurn(session, store, {
      provider: "mock",
      model: "mock-fast",
      text: "hello",
    });

    expect(outcome.winner?.status).toBe("ok");

    const view = store.getView();
    // Streamed text landed as a finalized main-lane turn.
    const main = view.lanes["main"];
    expect(main).toBeTruthy();
    const finalText = main!.finalized.map((t) => t.text).join("");
    expect(finalText).toContain("[mock-fast] Echo: hello");
    // Usage was projected into the totals (drives the HUD gauge/cost).
    expect(view.totals.outputTokens).toBeGreaterThan(0);
    expect(view.eventCount).toBeGreaterThan(0);

    await engine.dispose();
  });

  it("renders the streamed run into the conversation + HUD (headless frame)", async () => {
    const { engine, session } = await mockSession();
    const store = createEventStore();
    await runTurn(session, store, { provider: "mock", model: "mock-smart", text: "ping" });
    const view = store.getView();

    // Conversation (Mode A scrollback flushes finalized turns to <Static>).
    const convo = render(wrap(<Workspace view={view} viewport={{ cols: 100, rows: 40 }} preset="chat" />));
    expect(convo.lastFrame() ?? "").toContain("mock-smart");

    // The HUD shows the context gauge fed by the run's usage.
    const hud = render(wrap(<StatusHud view={view} cols={100} contextMax={200000} />));
    const hudFrame = hud.lastFrame() ?? "";
    expect(hudFrame).toContain("ctx");
    expect(hudFrame).toContain("200.0k");

    await engine.dispose();
  });
});

describe("engine bridge — conversation memory (transcript accumulates across turns)", () => {
  it("dispatches turn N with the FULL prior transcript, not just the new line", async () => {
    const { engine, session } = await mockSession();
    const store = createEventStore();

    // Capture the exact `input` (message list) each turn is dispatched with, then
    // delegate to the real mock run so the outcome carries the echo reply.
    const captured: Message[][] = [];
    const dispatchTurn: TurnDispatcher = (input, ctx) => {
      captured.push([...input]);
      return singleDispatch("mock", "mock-fast", input, ctx);
    };

    // Faithfully replicate runTui.onSubmit's accumulation for two user turns.
    const transcript: Message[] = [];
    async function submit(text: string): Promise<void> {
      const userMsgs = userText(text);
      const outcome = await runTurn(session, store, {
        provider: "mock",
        model: "mock-fast",
        text,
        history: transcript,
        dispatchTurn,
      });
      const result = outcome.winner ?? outcome.runs[0];
      transcript.push(...userMsgs);
      if (result && result.text.length > 0) {
        transcript.push({ role: "assistant", content: [{ type: "text", text: result.text }] });
      }
    }

    await submit("hello");
    await submit("say it");

    // Turn 1 saw only the first user line…
    expect(captured[0]!.map((m) => m.role)).toEqual(["user"]);
    // …but turn 2 saw the WHOLE conversation: user1, assistant1, user2. This is
    // the exact "say it" → amnesia scenario, now fixed.
    expect(captured[1]!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messageText(captured[1]![0]!)).toContain("hello"); // remembered the 1st user line
    expect(messageText(captured[1]![1]!)).toContain("Echo: hello"); // remembered its own reply
    expect(messageText(captured[1]![2]!)).toContain("say it"); // the new line

    await engine.dispose();
  });
});

describe("runTui — non-TTY boot guard (hard rule 4)", () => {
  it("refuses to mount and prints a graceful fallback instead of crashing", async () => {
    const { engine } = await mockSession();
    let out = "";
    const fakeStdout = { write: (s: string) => { out += s; return true; } } as unknown as NodeJS.WriteStream;

    const result = await runTui(engine, {
      provider: "mock",
      model: "mock-fast",
      stdout: fakeStdout,
      capabilities: { ...richCaps, isTTY: false } as Capabilities,
      env: {},
    });

    expect(result.mounted).toBe(false);
    expect(result.reason).toBe("non-tty");
    expect(out).toContain("linear mode");

    await engine.dispose();
  });
});
