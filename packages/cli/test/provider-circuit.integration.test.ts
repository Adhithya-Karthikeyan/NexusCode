import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterError, ProviderCircuitBreaker } from "@nexuscode/core";
import { spawnCli } from "./helpers/spawn-cli.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "nx-provider-circuit-"));
const CONFIG_DIR = join(ROOT, "config");
const DATA_DIR = join(ROOT, "data");
const WORK_DIR = join(ROOT, "work");
const CIRCUIT_FILE = join(DATA_DIR, "provider-circuits.json");

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before this test`);
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(
    join(CONFIG_DIR, "config.json"),
    JSON.stringify({
      defaultProvider: "mock",
      defaultModel: "mock-fast",
      history: { enabled: false },
      transfer: { enabled: false },
      providerCircuit: {
        enabled: true,
        filePath: CIRCUIT_FILE,
        quotaCooldownMs: 60000,
      },
    }),
  );
});

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnCli(BIN, args, {
    cwd: WORK_DIR,
    env: {
      ...process.env,
      NEXUS_CONFIG_DIR: CONFIG_DIR,
      NEXUS_DATA_DIR: DATA_DIR,
      NO_COLOR: "1",
    },
  });
}

describe("nexus provider circuit status and reset", () => {
  it("skips a persistently exhausted provider, explains it, then allows manual reset", async () => {
    const breaker = new ProviderCircuitBreaker({
      filePath: CIRCUIT_FILE,
      quotaCooldownMs: 60_000,
    });
    breaker.recordFailure(
      { providerId: "mock", modelId: "mock-fast" },
      new AdapterError("quota_exhausted", "monthly usage limit expired", {
        providerId: "mock",
      }),
    );

    const blockedAsk = await runCli(["ask", "-p", "mock", "-m", "mock-fast", "hello"]);
    expect(blockedAsk.code).toBe(1);
    expect(blockedAsk.stderr).toContain("temporarily unavailable");
    expect(blockedAsk.stderr).toContain("usage limit");

    const status = await runCli(["providers", "status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("limit mock");
    expect(status.stdout).toContain("quota");
    expect(status.stdout).toContain(CIRCUIT_FILE);

    const json = await runCli(["providers", "status", "-o", "json"]);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      circuits: Array<{ target: { providerId: string }; reason?: string; state: string }>;
      circuitStore: string;
    };
    expect(payload.circuitStore).toBe(CIRCUIT_FILE);
    expect(payload.circuits).toContainEqual(
      expect.objectContaining({
        target: expect.objectContaining({ providerId: "mock" }),
        reason: "quota",
        state: "open",
      }),
    );

    const reset = await runCli(["providers", "reset", "mock"]);
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain("reset 1 circuit record");

    const recoveredAsk = await runCli(["ask", "-p", "mock", "-m", "mock-fast", "hello"]);
    expect(recoveredAsk.code).toBe(0);
    expect(recoveredAsk.stdout).toContain("Echo: hello");
  }, 30_000);
});
