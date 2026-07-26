/**
 * Regression for the user-visible blank reply when an account is out of usage.
 * Exercises the built CLI end-to-end against an OpenAI-compatible server that
 * returns the real `insufficient_quota` shape.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-quota-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-quota-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-quota-cwd-"));
let server: Server;

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before this test`);
  }
  server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "spent-1", object: "model" }] }));
      return;
    }
    res.writeHead(429, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "You exceeded your current quota. Check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    join(CONFIG_DIR, "config.json"),
    JSON.stringify({
      defaultProvider: "spent",
      defaultModel: "spent-1",
      providers: [
        {
          id: "spent",
          kind: "openai-compat",
          adapter: "@nexuscode/provider-openai",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: "SPENT_API_KEY",
          models: ["spent-1"],
        },
      ],
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runChat(): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BIN, "chat", "-p", "spent", "-m", "spent-1"],
      {
        cwd: WORK_DIR,
        env: {
          ...process.env,
          NEXUS_CONFIG_DIR: CONFIG_DIR,
          NEXUS_DATA_DIR: DATA_DIR,
          NEXUS_HISTORY_DISABLED: "1",
          SPENT_API_KEY: "test-key",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end("hello\n");
  });
}

describe("nexus chat — exhausted provider usage", () => {
  it("prints a clear limit-expired diagnosis and exits non-zero instead of returning empty", async () => {
    const result = await runChat();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error:");
    expect(result.stderr).toContain("You exceeded your current quota");
    expect(result.stderr).toContain("provider usage limit expired or quota exhausted");
  }, 20_000);
});
