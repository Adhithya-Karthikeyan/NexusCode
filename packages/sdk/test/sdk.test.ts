/**
 * SDK facade tests — fully offline (mock provider + a fake in-repo tool). They
 * exercise the public embeddable surface end-to-end: build, ask (stream +
 * result), compare, agent-with-tool, event subscription, provider/tool
 * registration + introspection, sessions, and disposal.
 */

import { describe, it, expect } from "vitest";
import { createMockAdapter } from "@nexuscode/provider-mock";
import { okText, type Tool } from "@nexuscode/tools";
import { createNexus, Nexus, type UiEvent } from "../src/index.js";

/** A deterministic, offline tool the agent loop can call (no I/O). */
function echoTool(): { tool: Tool; calls: unknown[] } {
  const calls: unknown[] = [];
  const tool: Tool = {
    name: "echo",
    description: "Echo the given text back.",
    permission: "read",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async run(input) {
      calls.push(input);
      const text = (input as { text?: string })?.text ?? "";
      return okText(`echoed: ${text}`);
    },
  };
  return { tool, calls };
}

/** A mock adapter whose `mock-tools` model calls our `echo` tool on turn one. */
function echoingToolAdapter(id = "mock-echo") {
  return createMockAdapter({
    id,
    models: ["mock-tools"],
    toolName: "echo",
    toolInput: (prompt: string) => ({ text: prompt }),
  });
}

async function makeNexus(): Promise<Nexus> {
  // `mock` is always registered by the runtime bootstrap; make it the default.
  return createNexus({ config: { defaultProvider: "mock", defaultModel: "mock-fast" } });
}

describe("createNexus", () => {
  it("builds over the mock provider with zero external config", async () => {
    const nexus = await makeNexus();
    try {
      const providers = nexus.listProviders();
      const ids = providers.map((p) => p.id);
      expect(ids).toContain("mock");
      const mock = providers.find((p) => p.id === "mock");
      expect(mock?.models).toContain("mock-fast");
      expect(mock?.available).toBe(true);
    } finally {
      await nexus.dispose();
    }
  });

  it("throws for an unknown provider", async () => {
    const nexus = await makeNexus();
    try {
      expect(() => nexus.ask("hi", { provider: "does-not-exist" })).toThrow(/not available/);
    } finally {
      await nexus.dispose();
    }
  });
});

describe("ask", () => {
  it("streams text deltas and settles into a result", async () => {
    const nexus = await makeNexus();
    try {
      const run = nexus.ask("hello world", { model: "mock-fast" });

      let streamed = "";
      for await (const delta of run.textStream()) streamed += delta;

      const result = await run.result();
      expect(result.status).toBe("ok");
      expect(result.adapterId).toBe("mock");
      expect(result.text.length).toBeGreaterThan(0);
      // The streamed text must match the settled result (same run, replayed).
      expect(streamed).toBe(result.text);

      const outcome = await run.outcome();
      expect(outcome.kind).toBe("single");
      expect(outcome.partial).toBe(false);
    } finally {
      await nexus.dispose();
    }
  });

  it("supports result() without consuming the stream", async () => {
    const nexus = await makeNexus();
    try {
      const text = await nexus.ask("no streaming here").text();
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    } finally {
      await nexus.dispose();
    }
  });
});

describe("compare", () => {
  it("fans one prompt across lanes and settles every lane", async () => {
    const nexus = await makeNexus();
    try {
      const run = nexus.compare("compare me", ["mock/mock-fast", "mock/mock-smart"]);
      const outcome = await run.outcome();
      expect(outcome.kind).toBe("compare");
      expect(outcome.runs).toHaveLength(2);
      for (const r of outcome.runs) expect(r.status).toBe("ok");
    } finally {
      await nexus.dispose();
    }
  });
});

describe("agent", () => {
  it("runs the native tool loop and calls a registered tool", async () => {
    const { tool, calls } = echoTool();
    const nexus = await createNexus({
      config: { defaultProvider: "mock-echo", defaultModel: "mock-tools" },
      providers: [echoingToolAdapter()],
      tools: [tool],
      permissionMode: "read-only",
    });
    try {
      const run = nexus.agent("please echo something", { model: "mock-tools" });

      const toolCalls: UiEvent[] = [];
      for await (const ev of run.events()) {
        if (ev.t === "tool_call") toolCalls.push(ev);
      }
      const result = await run.result();

      expect(result.status).toBe("ok");
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0] as { text?: string }).text).toContain("echo");
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolCalls[0]?.t === "tool_call" && toolCalls[0].name).toBe("echo");
      // The final answer references the tool output.
      expect(result.text).toContain("echo");
    } finally {
      await nexus.dispose();
    }
  });

  it("registerTool then agent() uses it", async () => {
    const { tool, calls } = echoTool();
    const nexus = await createNexus({
      config: { defaultProvider: "mock-echo", defaultModel: "mock-tools" },
      providers: [echoingToolAdapter()],
    });
    try {
      nexus.registerTool(tool);
      expect(nexus.listTools().map((t) => t.name)).toContain("echo");

      const run = nexus.agent("echo it", { model: "mock-tools" });
      await run.result();
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      await nexus.dispose();
    }
  });
});

describe("events", () => {
  it("global subscribers receive UiEvents from a run", async () => {
    const nexus = await makeNexus();
    try {
      const seen: UiEvent[] = [];
      const off = nexus.on("ui", (ev) => seen.push(ev));

      const run = nexus.ask("emit some events", { model: "mock-fast" });
      await run.result();
      // Let the broadcast pump flush the buffered chunks to subscribers.
      await new Promise((r) => setTimeout(r, 10));

      off();
      expect(seen.some((e) => e.t === "session")).toBe(true);
      expect(seen.some((e) => e.t === "text")).toBe(true);
      expect(seen.some((e) => e.t === "done")).toBe(true);
    } finally {
      await nexus.dispose();
    }
  });

  it("async stream() yields trace spans", async () => {
    const nexus = await makeNexus();
    try {
      const controller = new AbortController();
      const spans: unknown[] = [];
      const collect = (async () => {
        for await (const span of nexus.stream("trace", controller.signal)) {
          spans.push(span);
          if (spans.length >= 1) break;
        }
      })();

      const run = nexus.ask("trace me", { model: "mock-fast" });
      await run.result();
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await collect;

      expect(spans.length).toBeGreaterThan(0);
    } finally {
      await nexus.dispose();
    }
  });
});

describe("registerProvider + listProviders", () => {
  it("registers a second mock adapter and lists it", async () => {
    const nexus = await makeNexus();
    try {
      await nexus.registerProvider(createMockAdapter({ id: "mock-2" }), { skipHealth: true });
      const ids = nexus.listProviders().map((p) => p.id);
      expect(ids).toContain("mock-2");

      // The newly registered provider is usable through the same engine path.
      const result = await nexus.ask("via mock-2", { provider: "mock-2" }).result();
      expect(result.adapterId).toBe("mock-2");
    } finally {
      await nexus.dispose();
    }
  });
});

describe("sessions", () => {
  it("opens, resumes, and runs inside a session", async () => {
    const nexus = await makeNexus();
    try {
      const session = await nexus.openSession();
      expect(session.id).toMatch(/./);

      const result = await session.ask("in a session", { model: "mock-fast" }).result();
      expect(result.status).toBe("ok");

      const resumed = await nexus.resumeSession(session.id);
      expect(resumed.id).toBe(session.id);
      await session.dispose();
    } finally {
      await nexus.dispose();
    }
  });
});

describe("dispose", () => {
  it("rejects further use after disposal", async () => {
    const nexus = await makeNexus();
    await nexus.dispose();
    expect(() => nexus.ask("too late")).toThrow(/disposed/);
    expect(() => nexus.listProviders()).toThrow(/disposed/);
    // Idempotent.
    await expect(nexus.dispose()).resolves.toBeUndefined();
  });
});
