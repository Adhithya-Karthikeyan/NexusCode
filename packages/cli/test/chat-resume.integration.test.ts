/**
 * `nexus chat --resume` / `--continue`, proven ACROSS PROCESSES over the built
 * binary. Process 1 holds a conversation and exits; process 2 is a completely
 * separate node process that resumes by id — and a local OpenAI-compatible server
 * records what it actually receives, so "it remembered" is asserted on the wire
 * rather than inferred from output.
 *
 * The opt-out path is pinned too: with `history.storePrompts` off (the default),
 * resume must SAY so rather than silently starting a fresh conversation.
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
const ROOT = mkdtempSync(join(tmpdir(), "nx-resume-"));
const CONFIG_DIR = join(ROOT, "cfg");
const NO_PROMPTS_CONFIG_DIR = join(ROOT, "cfg-noprompts");
const DATA_DIR = join(ROOT, "data");
const WORK_DIR = join(ROOT, "cwd");

interface RecordedRequest {
  messages: { role: string; content: unknown }[];
}

const received: RecordedRequest[] = [];
let server: Server;

function textOf(message: { content: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function writeConfig(dir: string, port: number, storePrompts: boolean): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      defaultProvider: "spy",
      defaultModel: "spy-1",
      history: {
        enabled: true,
        dbPath: join(dir, "history.db"),
        ...(storePrompts ? { storePrompts: true } : {}),
      },
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
}

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite (CI builds first)`);
  }
  mkdirSync(WORK_DIR, { recursive: true });

  let reply = "noted";
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
      res.write(sse({ id: "1", object: "chat.completion.chunk", created: 0, model: "spy-1", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] }));
      res.write(sse({ id: "1", object: "chat.completion.chunk", created: 0, model: "spy-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  reply = "noted";

  writeConfig(CONFIG_DIR, port, true);
  writeConfig(NO_PROMPTS_CONFIG_DIR, port, false);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runChat(
  args: string[],
  input: string,
  configDir = CONFIG_DIR,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "chat", "-p", "spy", "-m", "spy-1", ...args], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: configDir,
        NEXUS_DATA_DIR: DATA_DIR,
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

function sessionIdOf(stderr: string): string {
  const m = /\[session\] (\S+)/.exec(stderr);
  if (!m?.[1]) throw new Error(`no session id printed:\n${stderr}`);
  return m[1];
}

describe("nexus chat --resume (across two processes)", () => {
  it("continues a conversation started by an earlier process", async () => {
    received.length = 0;

    // ── Process 1 ────────────────────────────────────────────────────────────
    const first = await runChat([], "My name is Zebra.\nI work on NexusCode.\n");
    expect(first.code).toBe(0);
    const sessionId = sessionIdOf(first.stderr);
    expect(received).toHaveLength(2);

    // ── Process 2: a different node process, resuming by id ──────────────────
    const second = await runChat(["--resume", sessionId], "What is my name?\n");
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("[resume]");
    expect(second.stderr).toContain("restored 4 messages");
    // The limitation is stated, never glossed over.
    expect(second.stderr).toContain("text only");

    expect(received).toHaveLength(3);
    const resumed = received[2]!;
    expect(resumed.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    const bodies = resumed.messages.map(textOf);
    expect(bodies).toContain("My name is Zebra.");
    expect(bodies).toContain("I work on NexusCode.");
    expect(bodies.filter((t) => t === "My name is Zebra.")).toHaveLength(1);
  }, 60_000);

  it("--continue picks up the most recent stored conversation", async () => {
    received.length = 0;
    const first = await runChat([], "Remember the number 7.\n");
    expect(first.code).toBe(0);

    const second = await runChat(["--continue"], "What number?\n");
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("[resume]");

    const last = received[received.length - 1]!;
    expect(last.messages.map(textOf)).toContain("Remember the number 7.");
  }, 60_000);

  it("says plainly that it cannot resume when storePrompts is off (the default)", async () => {
    received.length = 0;
    const first = await runChat([], "My name is Zebra.\n", NO_PROMPTS_CONFIG_DIR);
    expect(first.code).toBe(0);
    const sessionId = sessionIdOf(first.stderr);

    const second = await runChat(["--resume", sessionId], "What is my name?\n", NO_PROMPTS_CONFIG_DIR);
    // Degrades honestly: exit 0, an explicit reason, and the fix.
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("cannot resume");
    expect(second.stderr).toContain("history.storePrompts");
    expect(second.stderr).toContain("nexus config set history.storePrompts true");
    // And it genuinely did NOT resume — no half-conversation was presented.
    expect(second.stderr).not.toContain("[resume]");
    const last = received[received.length - 1]!;
    expect(last.messages).toHaveLength(1);
    expect(textOf(last.messages[0]!)).toBe("What is my name?");
  }, 60_000);

  it("starts fresh, without error, on an unknown session id", async () => {
    received.length = 0;
    const r = await runChat(["--resume", "s_does_not_exist"], "hello\n");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("no stored transcript");
    expect(received[received.length - 1]!.messages).toHaveLength(1);
  }, 60_000);
});
