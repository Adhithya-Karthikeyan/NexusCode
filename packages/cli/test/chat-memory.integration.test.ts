/**
 * `nexus chat` conversation memory, proven end-to-end over the BUILT binary.
 *
 * A local OpenAI-compatible server stands in for a provider and records every
 * request body, so the assertion is about what the CLI actually put on the wire:
 * turn 3 must carry turns 1 and 2 (and each of them exactly once). Before the
 * session transcript landed, every line of a piped `nexus chat` was dispatched as
 * an isolated single-message request — total amnesia.
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
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatmem-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatmem-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-chatmem-cwd-"));

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
        // Model discovery / health probes: answer with the one virtual model.
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

function runChat(input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "chat", "-p", "spy", "-m", "spy-1"], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: CONFIG_DIR,
        NEXUS_DATA_DIR: DATA_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        SPY_API_KEY: "test-key",
      },
    });
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
    child.stdin.end(input);
  });
}

describe("nexus chat — remembers the conversation across piped lines", () => {
  it("sends turn 1 and 2 back with turn 3, each exactly once", async () => {
    received.length = 0;
    const r = await runChat("My name is Zebra.\nWhat is my name?\nAnd again?\n");
    expect(r.stderr).not.toContain("not available");
    expect(r.code).toBe(0);

    const chats = received.filter((x) => Array.isArray(x.messages) && x.messages.length > 0);
    expect(chats).toHaveLength(3);

    // Turn 1 is a bare prompt; turn 3 carries the whole conversation.
    expect(chats[0]!.messages.map((m) => m.role)).toEqual(["user"]);
    expect(chats[2]!.messages.map((m) => m.role)).toEqual([
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

    // The assistant's answers are remembered too, not only the user's lines.
    expect(turn3.filter((t) => t === "noted")).toHaveLength(2);

    // The visible output is unchanged: one answer per line.
    expect(r.stdout.trim().split("\n").filter((l) => l.length > 0)).toHaveLength(3);
  }, 30_000);
});
