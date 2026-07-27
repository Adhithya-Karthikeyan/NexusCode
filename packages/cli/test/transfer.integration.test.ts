/**
 * Production transfer wiring, exercised through the built CLI rather than a
 * package-level test double. This pins three invariants:
 *
 *  - ordinary `ask` runs actually create ZLCTS rows;
 *  - verbatim payloads are marked encrypted;
 *  - neither the prompt nor the provider answer appears in the blob files.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { spawnCli } from "./helpers/spawn-cli.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "nx-transfer-cli-"));
const CONFIG_DIR = join(ROOT, "config");
const DATA_DIR = join(ROOT, "data");
const WORK_DIR = join(ROOT, "work");
const HISTORY_DB = join(CONFIG_DIR, "history.db");
const SECRET_PROMPT = "transfer-secret-NX-7429";

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnCli(BIN, args, {
    cwd: WORK_DIR,
    env: {
      ...process.env,
      NEXUS_CONFIG_DIR: CONFIG_DIR,
      NEXUS_DATA_DIR: DATA_DIR,
      NEXUS_VAULT_PASSPHRASE: "integration-only-passphrase",
    },
  });
}

function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(path));
    else out.push(path);
  }
  return out;
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite`);
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(join(WORK_DIR, "AGENTS.md"), "Transfer integration project context.\n");
  writeFileSync(
    join(CONFIG_DIR, "config.json"),
    JSON.stringify({
      defaultProvider: "mock",
      defaultModel: "mock-fast",
      history: { enabled: true, dbPath: HISTORY_DB, storePrompts: false },
      transfer: { enabled: true },
    }),
  );
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("production ZLCTS wiring", () => {
  it("captures an ordinary run and encrypts every raw blob at rest", async () => {
    const run = await runCli([
      "ask",
      "-p",
      "mock",
      "-m",
      "mock-fast",
      "-o",
      "json",
      SECRET_PROMPT,
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(SECRET_PROMPT);

    const db = new Database(HISTORY_DB, { readonly: true });
    try {
      const verbatim = db
        .prepare(
          "SELECT COUNT(*) AS count, MIN(encrypted) AS minEncrypted FROM zlcts_verbatim",
        )
        .get() as { count: number; minEncrypted: number };
      const wal = db
        .prepare(
          "SELECT COUNT(*) AS count, MIN(folded) AS minFolded, MIN(durably_written) AS minDurable FROM zlcts_wal",
        )
        .get() as { count: number; minFolded: number; minDurable: number };

      expect(verbatim.count).toBeGreaterThan(0);
      expect(verbatim.minEncrypted).toBe(1);
      expect(wal.count).toBeGreaterThan(0);
      expect(wal.minFolded).toBe(1);
      expect(wal.minDurable).toBe(1);
    } finally {
      db.close();
    }

    const blobFiles = filesBelow(`${HISTORY_DB}.zlcts`).filter(
      (path) => !path.endsWith(".encryption-key"),
    );
    expect(blobFiles.length).toBeGreaterThan(0);
    for (const file of blobFiles) {
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("NXB1");
      expect(bytes.includes(Buffer.from(SECRET_PROMPT))).toBe(false);
      expect(bytes.includes(Buffer.from("[mock-fast] Echo"))).toBe(false);
    }

    const doctor = await runCli(["doctor"]);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain("transfer: [ok] enabled · encrypted");
  }, 60_000);
});
