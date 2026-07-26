import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "nx-handoff-wire-"));
const CONFIG_DIR = join(ROOT, "config");
const DATA_DIR = join(ROOT, "data");
const WORK_DIR = join(ROOT, "work");
let server: Server;
const healthyBodies: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before this test`);
  }
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "spent-model", object: "model" },
              { id: "healthy-model", object: "model" },
            ],
          }),
        );
        return;
      }
      if (request.url?.includes("/spent/")) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Your monthly usage limit has expired.",
              type: "insufficient_quota",
              code: "insufficient_quota",
            },
          }),
        );
        return;
      }
      try {
        healthyBodies.push(
          JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> },
        );
      } catch {
        healthyBodies.push({});
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sse({
          id: "healthy-1",
          object: "chat.completion.chunk",
          created: 0,
          model: "healthy-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "continued safely" },
              finish_reason: null,
            },
          ],
        }),
      );
      response.write(
        sse({
          id: "healthy-1",
          object: "chat.completion.chunk",
          created: 0,
          model: "healthy-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(
    join(CONFIG_DIR, "config.json"),
    JSON.stringify({
      defaultProvider: "spent",
      defaultModel: "spent-model",
      providers: [
        {
          id: "spent",
          kind: "openai-compat",
          adapter: "@nexuscode/provider-openai",
          baseUrl: `http://127.0.0.1:${port}/spent/v1`,
          apiKeyEnv: "WIRE_API_KEY",
          models: ["spent-model"],
        },
        {
          id: "healthy",
          kind: "openai-compat",
          adapter: "@nexuscode/provider-openai",
          baseUrl: `http://127.0.0.1:${port}/healthy/v1`,
          apiKeyEnv: "WIRE_API_KEY",
          models: ["healthy-model"],
        },
      ],
      history: { enabled: true },
      transfer: {
        enabled: true,
        dbPath: join(DATA_DIR, "handoff.db"),
        handoff: { maxCapsuleTokens: 12000, maxCapsuleBytes: 65536 },
      },
      providerCircuit: {
        enabled: true,
        filePath: join(DATA_DIR, "circuits.json"),
      },
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runRoute(): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        BIN,
        "route",
        "test",
        "--optimize",
        "explicit",
        "--allow",
        "spent/spent-model",
        "--allow",
        "healthy/healthy-model",
        "--retries",
        "1",
        "-o",
        "json",
        "Continue the Aurora migration",
      ],
      {
        cwd: WORK_DIR,
        env: {
          ...process.env,
          NEXUS_CONFIG_DIR: CONFIG_DIR,
          NEXUS_DATA_DIR: DATA_DIR,
          NEXUS_VAULT_PASSPHRASE: "handoff-test-passphrase",
          WIRE_API_KEY: "test-key",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("routed provider handoff on the HTTP wire", () => {
  it("sends the healthy provider a signed same-project handoff capsule", async () => {
    healthyBodies.length = 0;
    const result = await runRoute();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      provider: "healthy",
      status: "ok",
      text: "continued safely",
    });
    expect(healthyBodies).toHaveLength(1);
    const messages = healthyBodies[0]?.messages ?? [];
    const handoff = messages.find((message) =>
      contentText(message.content).includes("[NEXUS PROVIDER HANDOFF"),
    );
    expect(handoff?.role).toBe("system");
    const text = contentText(handoff?.content);
    expect(text).toContain("nexus.handoff-capsule/v1");
    expect(text).toContain("Continue the Aurora migration");
    expect(text).toContain('"providerId":"spent"');
    expect(text).toContain('"providerId":"healthy"');
    expect(text).toMatch(/"algorithm":"hmac-sha256"/);
    expect(text).toMatch(/"hash":"hmac-sha256:[a-f0-9]{64}"/);
  }, 30_000);
});
