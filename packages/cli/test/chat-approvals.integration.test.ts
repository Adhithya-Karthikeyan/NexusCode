/**
 * `nexus chat --persistent -t` — REAL tool approvals, proven end-to-end over the
 * BUILT binary.
 *
 * Before this feature, `nexus chat` had no tool loop at all (a plain single
 * dispatch), so an "ask"-tier tool call could never happen, let alone be
 * genuinely approved or denied. `-t`/`--tools` opts a persistent conversation
 * into the native agentic tool loop; with `--ask` (or the plain default), a
 * tool call needing approval emits `{"t":"approval",...}` and the turn BLOCKS
 * until a decision line arrives on the SAME stdin the prompts do — the control
 * -line contract documented on `ChatCommand`'s usage. This file drives that
 * live, back-and-forth conversation over real stdio: it writes the prompt,
 * waits for the approval event to appear on stdout, and only THEN writes the
 * decision — proving the block is real, not just plumbing that happens to be
 * present.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatappr-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatappr-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-chatappr-cwd-"));

interface RecordedRequest {
  messages: { role: string; content: unknown }[];
}

const received: RecordedRequest[] = [];
let server: Server;

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * First call in a test: the model asks to run `shell_exec`. Every call after
 * that: the model gives a plain final answer (whatever the tool call's outcome
 * was — approved or denied, the turn must still settle with a real reply,
 * never a crash or a hang).
 */
function respond(res: import("node:http").ServerResponse, seq: number): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (seq === 0) {
    res.write(
      sse({
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "spy-1",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "shell_exec", arguments: JSON.stringify({ command: "echo", args: ["approved-token"] }) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    res.write(
      sse({
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "spy-1",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    );
  } else {
    res.write(
      sse({
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "spy-1",
        choices: [{ index: 0, delta: { role: "assistant", content: "final answer after tool call" }, finish_reason: null }],
      }),
    );
    res.write(
      sse({
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "spy-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    );
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite (CI builds first)`);
  }

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += String(d);
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "spy-1", object: "model" }] }));
        return;
      }
      let parsed: RecordedRequest;
      try {
        parsed = JSON.parse(body) as RecordedRequest;
      } catch {
        parsed = { messages: [] };
      }
      const seq = received.length;
      received.push(parsed);
      respond(res, seq);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(CONFIG_DIR, "config.json"),
    JSON.stringify({
      defaultProvider: "spy",
      defaultModel: "spy-1",
      providers: [
        {
          id: "spy",
          kind: "openai-compat",
          adapter: "@nexuscode/provider-openai",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: "SPY_API_KEY",
          models: ["spy-1"],
        },
      ],
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** One line of the `-o ndjson` stream, loosely typed for the fields this file asserts on. */
interface NdjsonLine {
  t: string;
  id?: string;
  action?: string;
  detail?: string;
  ok?: boolean;
  result?: unknown;
  turnId?: string;
  [key: string]: unknown;
}

/**
 * Buffers a child's stdout into ndjson lines and lets a caller await the next
 * line matching a predicate — the real shape of a client that reacts to one
 * event (the approval) before producing the next one (the decision), rather
 * than a test that just replays a fixed script blind.
 */
function lineWaiter(child: ChildProcessWithoutNullStreams): {
  all: NdjsonLine[];
  waitFor: (pred: (ev: NdjsonLine) => boolean, timeoutMs?: number) => Promise<NdjsonLine>;
} {
  const seen: NdjsonLine[] = [];
  const waiters: { pred: (ev: NdjsonLine) => boolean; resolve: (ev: NdjsonLine) => void }[] = [];
  let buffer = "";
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let ev: NdjsonLine;
      try {
        ev = JSON.parse(line) as NdjsonLine;
      } catch {
        continue;
      }
      seen.push(ev);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.pred(ev)) {
          waiters.splice(i, 1);
          w.resolve(ev);
        }
      }
    }
  });
  return {
    all: seen,
    waitFor(pred, timeoutMs = 10_000) {
      const already = seen.find(pred);
      if (already) return Promise.resolve(already);
      return new Promise<NdjsonLine>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for a matching ndjson line`)), timeoutMs);
        waiters.push({
          pred,
          resolve: (ev) => {
            clearTimeout(timer);
            resolve(ev);
          },
        });
      });
    },
  };
}

function spawnChat(extraArgs: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, "chat", "--persistent", "-t", "-p", "spy", "-m", "spy-1", "-o", "ndjson", ...extraArgs], {
    cwd: WORK_DIR,
    env: {
      ...process.env,
      NEXUS_CONFIG_DIR: CONFIG_DIR,
      NEXUS_DATA_DIR: DATA_DIR,
      NEXUS_HISTORY_DISABLED: "1",
      SPY_API_KEY: "test-key",
    },
  });
}

describe("nexus chat --persistent -t — real tool approvals", () => {
  it("blocks the tool call on an approval event, then runs it once allowed", async () => {
    received.length = 0;
    const child = spawnChat(["--ask"]);
    const closed = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
    const lines = lineWaiter(child);

    child.stdin.write("please run the command\n");

    const approval = await waitForApproval(lines);
    expect(approval.action).toBe("shell");
    const detail = JSON.parse(String(approval.detail)) as { toolName: string; permission: string; mode: string };
    expect(detail.toolName).toBe("shell_exec");
    expect(detail.permission).toBe("exec");
    expect(detail.mode).toBe("ask");

    // The tool must NOT have run yet — no tool_result exists before the decision.
    expect(lines.all.some((e) => e.t === "tool_result")).toBe(false);

    child.stdin.write(`${JSON.stringify({ type: "approval", id: approval.id, decision: "allow" })}\n`);

    const toolResult = await lines.waitFor((e) => e.t === "tool_result");
    expect(toolResult.ok).toBe(true);
    expect(JSON.stringify(toolResult.result)).toContain("approved-token");

    const turnEnd = await lines.waitFor((e) => e.t === "turn_end");
    expect(turnEnd.ok).toBe(true);

    child.stdin.end();
    expect(await closed).toBe(0);

    expect(received).toHaveLength(2);
    const second = received[1]!;
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
  }, 30_000);

  it("denies the tool call cleanly when the decision is 'deny' — the turn still settles", async () => {
    received.length = 0;
    const child = spawnChat(["--ask"]);
    const closed = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
    const lines = lineWaiter(child);

    child.stdin.write("please run the command\n");

    const approval = await waitForApproval(lines);
    child.stdin.write(`${JSON.stringify({ type: "approval", id: approval.id, decision: "deny" })}\n`);

    const toolResult = await lines.waitFor((e) => e.t === "tool_result");
    expect(toolResult.ok).toBe(false);
    expect(JSON.stringify(toolResult.result)).toMatch(/denied/i);
    expect(JSON.stringify(toolResult.result)).toContain("shell_exec");

    // Denied, not crashed: the turn still settles with a real reply.
    const turnEnd = await lines.waitFor((e) => e.t === "turn_end");
    expect(turnEnd.ok).toBe(true);
    expect(lines.all.some((e) => e.t === "text" && String(e["delta"]).length > 0)).toBe(true);

    child.stdin.end();
    expect(await closed).toBe(0);
  }, 30_000);

  it("an unanswered approval is denied by default after the timeout, never hanging the process", async () => {
    received.length = 0;
    const child = spawn(
      process.execPath,
      [BIN, "chat", "--persistent", "-t", "--ask", "-p", "spy", "-m", "spy-1", "-o", "ndjson"],
      {
        cwd: WORK_DIR,
        env: {
          ...process.env,
          NEXUS_CONFIG_DIR: CONFIG_DIR,
          NEXUS_DATA_DIR: DATA_DIR,
          NEXUS_HISTORY_DISABLED: "1",
          SPY_API_KEY: "test-key",
          // Real default is 120s; this proves the SAME code path denies on
          // timeout without a 2-minute test.
          NEXUS_APPROVAL_TIMEOUT_MS: "300",
        },
      },
    );
    const closed = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
    const lines = lineWaiter(child);

    child.stdin.write("please run the command\n");
    await waitForApproval(lines);
    // No decision line ever written — the broker's own timeout must fire.

    const toolResult = await lines.waitFor((e) => e.t === "tool_result", 5_000);
    expect(toolResult.ok).toBe(false);
    expect(JSON.stringify(toolResult.result)).toMatch(/denied/i);

    const turnEnd = await lines.waitFor((e) => e.t === "turn_end", 5_000);
    expect(turnEnd.ok).toBe(true);

    child.stdin.end();
    expect(await closed).toBe(0);
  }, 30_000);

  it("default mode (no --ask/--yolo/--approve) denies exec outright, with no approval prompt at all", async () => {
    received.length = 0;
    const child = spawnChat([]); // bare -t: read-only — exec is a hard deny, never an "ask"
    const closed = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
    const lines = lineWaiter(child);

    child.stdin.write("please run the command\n");

    const toolResult = await lines.waitFor((e) => e.t === "tool_result");
    expect(toolResult.ok).toBe(false);
    expect(lines.all.some((e) => e.t === "approval")).toBe(false);

    const turnEnd = await lines.waitFor((e) => e.t === "turn_end");
    expect(turnEnd.ok).toBe(true);

    child.stdin.end();
    expect(await closed).toBe(0);
  }, 30_000);
});

/** Small named indirection so every test's intent reads the same at the call site. */
function waitForApproval(lines: ReturnType<typeof lineWaiter>): Promise<NdjsonLine> {
  return lines.waitFor((e) => e.t === "approval");
}
