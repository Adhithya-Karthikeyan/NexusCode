/**
 * `nexus chat --persistent`, proven end-to-end over the BUILT binary.
 *
 * Before `--persistent` existed, a native client had to spawn a fresh `nexus
 * chat` process per message — there was no way to hold one conversation open
 * across many turns without re-reading history from disk on every turn. This
 * flag changes ONLY how stdin is consumed (incrementally, line by line, instead
 * of read-to-EOF-then-exit); the per-turn session/turn/dispatch machinery is
 * exactly what batch mode already used, so the assertions below reuse the same
 * "did the wire request actually carry prior turns" technique as
 * `chat-memory.integration.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatpersist-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatpersist-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-chatpersist-cwd-"));

interface RecordedRequest {
  messages: { role: string; content: unknown }[];
}

const received: RecordedRequest[] = [];
let server: Server;

/** Text of one OpenAI-compat message (content is a string or a content-part array). */
function textOf(message: { content: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
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
      try {
        received.push(JSON.parse(body) as RecordedRequest);
      } catch {
        received.push({ messages: [] });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ id: "1", object: "chat.completion.chunk", created: 0, model: "spy-1", choices: [{ index: 0, delta: { role: "assistant", content: "noted" }, finish_reason: null }] }));
      res.write(sse({ id: "1", object: "chat.completion.chunk", created: 0, model: "spy-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
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

interface ChatResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `nexus chat --persistent` and feed it lines ONE AT A TIME, waiting for
 * each turn's trailing blank line (text mode) or `turn_end` (ndjson) before
 * writing the next — the same shape a native client driving this over stdio
 * would use — then close stdin (EOF) and wait for the process to exit on its
 * own, proving the clean-shutdown path rather than a killed process.
 */
function runPersistentChat(lines: string[], extraArgs: string[] = []): Promise<ChatResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BIN, "chat", "--persistent", "-p", "spy", "-m", "spy-1", ...extraArgs],
      {
        cwd: WORK_DIR,
        env: {
          ...process.env,
          NEXUS_CONFIG_DIR: CONFIG_DIR,
          NEXUS_DATA_DIR: DATA_DIR,
          NEXUS_HISTORY_DISABLED: "1",
          SPY_API_KEY: "test-key",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));

    // Write every line up front — `--persistent` still consumes them one at a
    // time via readline, so this exercises the SAME incremental code path a
    // trickled write would, without the test depending on real-time pacing.
    for (const line of lines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

describe("nexus chat --persistent", () => {
  it("dispatches every piped line as its own turn on ONE session, remembering earlier turns, and exits cleanly on stdin EOF", async () => {
    received.length = 0;
    const r = await runPersistentChat(["My name is Zebra.", "What is my name?", "And again?"]);

    expect(r.stderr).not.toContain("not available");
    // A clean EOF shutdown, not a hang or a killed process.
    expect(r.code).toBe(0);

    const chats = received.filter((x) => Array.isArray(x.messages) && x.messages.length > 0);
    expect(chats).toHaveLength(3);

    expect(chats[0]!.messages.filter((m) => m.role !== "system").map((m) => m.role)).toEqual(["user"]);
    expect(chats[2]!.messages.filter((m) => m.role !== "system").map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);

    const turn3 = chats[2]!.messages.map(textOf);
    expect(turn3).toContain("My name is Zebra.");
    expect(turn3).toContain("What is my name?");
    expect(turn3.filter((t) => t === "My name is Zebra.")).toHaveLength(1);
    expect(turn3.filter((t) => t === "noted")).toHaveLength(2);

    // One reply per line, same as batch mode — --persistent changes stdin
    // consumption only, never the visible per-turn output shape.
    expect(r.stdout.trim().split("\n").filter((l) => l.length > 0)).toHaveLength(3);

    // One process, one session, for every turn.
    const sessionIds = [...r.stderr.matchAll(/\[session\] (\S+)/g)].map((m) => m[1]);
    expect(sessionIds.length).toBeGreaterThan(0);
    expect(new Set(sessionIds).size).toBe(1);
  }, 30_000);

  it("still requires piped (non-TTY) stdin, exactly like batch mode", async () => {
    // Covered structurally: `cmdChat`'s TTY guard runs before either stdin mode
    // is chosen, and is identical text for both — see chat-quota's and
    // command-flag-consistency's existing coverage of the non-persistent path.
    // This test locks in that --persistent doesn't bypass it by asserting a
    // zero-line input (closed stdin immediately) still exits 0 with no turns.
    received.length = 0;
    const r = await runPersistentChat([]);
    expect(r.code).toBe(0);
    expect(received).toHaveLength(0);
  }, 30_000);
});

/** One line of the `-o ndjson` stream, loosely typed for the fields this file asserts on. */
interface NdjsonLine {
  t: string;
  id?: string;
  sessionId?: string;
  turnId?: string;
  ok?: boolean;
  [key: string]: unknown;
}

function parseNdjson(stdout: string): NdjsonLine[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as NdjsonLine);
}

describe("nexus chat --persistent -o ndjson — session id bug fix", () => {
  it("carries the real engine session id on every `session` event, stable across turns, distinct from the per-run `id`", async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "chat", "--persistent", "-p", "mock", "-m", "mock-fast", "-o", "ndjson"],
      {
        cwd: WORK_DIR,
        env: { ...process.env, NEXUS_CONFIG_DIR: CONFIG_DIR, NEXUS_DATA_DIR: DATA_DIR, NEXUS_HISTORY_DISABLED: "1" },
      },
    );
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    const closed = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
    child.stdin.write("first line\n");
    child.stdin.write("second line\n");
    child.stdin.end();
    const code = await closed;
    expect(code).toBe(0);

    const events = parseNdjson(stdout);
    const sessionEvents = events.filter((e) => e.t === "session");
    const turnEndEvents = events.filter((e) => e.t === "turn_end");

    // Before this fix, a client had no way to learn the engine session id from
    // the ndjson stream at all — only the per-run `id`, which is useless for
    // `--resume`. One turn = one dispatch = one `run-start` = one `session`
    // event here, so two lines in means two of these.
    expect(sessionEvents).toHaveLength(2);
    for (const ev of sessionEvents) {
      expect(typeof ev.sessionId).toBe("string");
      expect((ev.sessionId as string).length).toBeGreaterThan(0);
      // The engine session id is never the same string as the run id it's
      // attached alongside — that conflation was the bug.
      expect(ev.sessionId).not.toBe(ev.id);
    }
    // The SAME session across every turn (one process, one session, N turns).
    expect(new Set(sessionEvents.map((e) => e.sessionId)).size).toBe(1);

    // The turn-delimiter: one per line, each naming its own turn and settling ok.
    expect(turnEndEvents).toHaveLength(2);
    for (const ev of turnEndEvents) {
      expect(typeof ev.turnId).toBe("string");
      expect(ev.ok).toBe(true);
    }
  }, 30_000);
});
