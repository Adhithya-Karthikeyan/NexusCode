import { describe, expect, it } from "vitest";
import {
  AdapterError,
  DEFAULT_RETRY_POLICY,
  enforceStreamContract,
  type StreamChunk,
  withRetry,
} from "@nexuscode/core";

async function drain(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

function start(runId = "run-a"): StreamChunk {
  return { type: "run-start", runId, adapterId: "fixture", model: "m", ts: 1 };
}

function end(runId = "run-a"): StreamChunk {
  return {
    type: "run-end",
    runId,
    finishReason: "stop",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ts: 2,
  };
}

function terminalCode(chunks: StreamChunk[]): string | undefined {
  const terminal = chunks.at(-1);
  return terminal?.type === "error" ? terminal.error.code : undefined;
}

describe("provider stream contract — chaos boundary", () => {
  it("turns content before run-start into one terminal parse error", async () => {
    async function* malformed(): AsyncIterable<StreamChunk> {
      yield { type: "text-delta", runId: "run-a", text: "orphan" };
      yield end();
    }

    const chunks = await drain(enforceStreamContract(malformed()));
    expect(chunks).toHaveLength(1);
    expect(terminalCode(chunks)).toBe("parse");
  });

  it("rejects duplicate starts and closes the provider iterator", async () => {
    let closed = false;
    async function* malformed(): AsyncIterable<StreamChunk> {
      try {
        yield start();
        yield start();
        yield { type: "text-delta", runId: "run-a", text: "must not leak" };
      } finally {
        closed = true;
      }
    }

    const chunks = await drain(enforceStreamContract(malformed()));
    expect(chunks.map((chunk) => chunk.type)).toEqual(["run-start", "error"]);
    expect(terminalCode(chunks)).toBe("parse");
    expect(closed).toBe(true);
  });

  it("rejects a runId change before it can corrupt another run", async () => {
    async function* malformed(): AsyncIterable<StreamChunk> {
      yield start("run-a");
      yield { type: "text-delta", runId: "run-b", text: "wrong lane" };
    }

    const chunks = await drain(enforceStreamContract(malformed()));
    expect(terminalCode(chunks)).toBe("parse");
    expect(chunks.some((chunk) => chunk.type === "text-delta")).toBe(false);
  });

  it("rejects orphaned and duplicate tool-call chunks", async () => {
    for (const malformedChunk of [
      { type: "tool-call-delta", runId: "run-a", id: "t", argsJsonDelta: "{}" },
      { type: "tool-call-end", runId: "run-a", id: "t", input: {} },
    ] satisfies StreamChunk[]) {
      async function* malformed(): AsyncIterable<StreamChunk> {
        yield start();
        yield malformedChunk;
      }
      const chunks = await drain(enforceStreamContract(malformed()));
      expect(terminalCode(chunks)).toBe("parse");
    }

    async function* duplicate(): AsyncIterable<StreamChunk> {
      yield start();
      yield { type: "tool-call-start", runId: "run-a", id: "t", name: "write" };
      yield { type: "tool-call-end", runId: "run-a", id: "t", input: {} };
      yield { type: "tool-call-start", runId: "run-a", id: "t", name: "write" };
    }
    expect(terminalCode(await drain(enforceStreamContract(duplicate())))).toBe("parse");
  });

  it("stops at the first terminal and never evaluates post-terminal garbage", async () => {
    let advancedPastTerminal = false;
    async function* malformed(): AsyncIterable<StreamChunk> {
      yield start();
      yield end();
      advancedPastTerminal = true;
      yield new AdapterError("unknown", "not a chunk") as unknown as StreamChunk;
    }

    const chunks = await drain(enforceStreamContract(malformed()));
    expect(chunks.map((chunk) => chunk.type)).toEqual(["run-start", "run-end"]);
    expect(advancedPastTerminal).toBe(false);
  });

  it("allows a setup failure to be represented as a terminal-only error", async () => {
    const error = new AdapterError("transport", "spawn failed", { retryable: true });
    async function* failedSetup(): AsyncIterable<StreamChunk> {
      yield { type: "error", runId: "run-a", error, retryable: true };
    }

    const chunks = await drain(enforceStreamContract(failedSetup()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: "error", error: { code: "transport" } });
  });

  it("is enforced by the retry boundary without retrying malformed output", async () => {
    let attempts = 0;
    const chunks = await drain(
      withRetry(
        () => {
          attempts += 1;
          return (async function* (): AsyncIterable<StreamChunk> {
            yield start();
            yield { type: "tool-call-delta", runId: "run-a", id: "missing", argsJsonDelta: "{" };
            yield end();
          })();
        },
        { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        new AbortController().signal,
      ),
    );

    expect(attempts).toBe(1);
    expect(chunks.filter((chunk) => chunk.type === "error")).toHaveLength(1);
    expect(terminalCode(chunks)).toBe("parse");
  });
});
