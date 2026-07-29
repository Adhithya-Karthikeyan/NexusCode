/**
 * `nexus chat --persistent`'s `{"type":"switch","provider":"…","model":"…"}`
 * control line (§ CAPABILITIES.md G5) — a REAL in-process provider/model
 * switch, proven end-to-end over the BUILT binary.
 *
 * Before this feature, the only way to change provider mid-conversation left
 * the engine process entirely (the app tore the backend down and started a
 * fresh `chat --persistent --resume <id>`, whose own `[resume]` notice
 * already says "(including any tool calls)"). This control line
 * is symmetric with the approval control line `chat-approvals.integration
 * .test.ts` already proves: parsed out of the same stdin, handled inline in
 * the reading loop, never confused with an ordinary prompt.
 *
 * Uses the built-in offline `mock`/`mock-slow` adapters (two genuinely
 * distinct, always-registered providers) rather than a custom HTTP server —
 * a real switch between two real providers, fully offline.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnCli } from "./helpers/spawn-cli.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatswitch-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatswitch-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-chatswitch-cwd-"));

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite (CI builds first)`);
  }
});

interface ChatResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One line of the `-o ndjson` stream, loosely typed for the fields this file asserts on. */
interface NdjsonLine {
  t: string;
  provider?: string;
  sessionId?: string;
  accepted?: boolean;
  blockers?: string[];
  preserved?: string[];
  adaptations?: string[];
  from?: { providerId: string; modelId: string };
  to?: { providerId: string; modelId: string };
  delta?: string;
  [key: string]: unknown;
}

function parseNdjson(stdout: string): NdjsonLine[] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as NdjsonLine);
}

/** Same "write every line up front, close stdin, wait for exit" shape `chat-persistent` already uses. */
function runPersistentChat(lines: string[], extraArgs: string[] = []): Promise<ChatResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BIN, "chat", "--persistent", "-p", "mock", "-m", "mock-fast", "-o", "ndjson", ...extraArgs],
      {
        cwd: WORK_DIR,
        env: {
          ...process.env,
          NEXUS_CONFIG_DIR: CONFIG_DIR,
          NEXUS_DATA_DIR: DATA_DIR,
          NEXUS_HISTORY_DISABLED: "1",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    for (const line of lines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

describe("nexus chat --persistent — switch control line", () => {
  it("switches provider in-process, dispatches the NEXT turn to the new target, and emits an accepted receipt", async () => {
    const r = await runPersistentChat([
      "hello before switch",
      JSON.stringify({ type: "switch", provider: "mock-slow" }),
      "hello after switch",
    ]);
    expect(r.code).toBe(0);
    const events = parseNdjson(r.stdout);

    const sessions = events.filter((e) => e.t === "session");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.provider).toBe("mock");
    // The decisive proof this is a REAL in-process switch, not a no-op: the
    // SECOND turn's own session/run-start event names the NEW provider.
    expect(sessions[1]!.provider).toBe("mock-slow");

    // Session id (the durable conversation identity) is IDENTICAL across the
    // switch — this is one process, one session, the whole time.
    expect(sessions[0]!.sessionId).toBeDefined();
    expect(sessions[1]!.sessionId).toBe(sessions[0]!.sessionId);

    const sw = events.find((e) => e.t === "switch");
    expect(sw).toBeDefined();
    expect(sw!.accepted).toBe(true);
    expect(sw!.from).toEqual({ providerId: "mock", modelId: "mock-fast" });
    expect(sw!.to).toEqual({ providerId: "mock-slow", modelId: "mock-fast" });
    // The receipt's own claim — never inflated to "everything", worded to
    // match what actually survives (see provider-switch.test.ts for the
    // tool-call counter-proof).
    expect(sw!.preserved).toContain("conversation transcript");

    // The switch event lands strictly BETWEEN the two turns' event streams,
    // not interleaved mid-turn.
    const swIndex = events.indexOf(sw!);
    const secondSessionIndex = events.indexOf(sessions[1]!);
    const firstDoneIndex = events.findIndex((e) => e.t === "done");
    expect(firstDoneIndex).toBeGreaterThanOrEqual(0);
    expect(swIndex).toBeGreaterThan(firstDoneIndex);
    expect(secondSessionIndex).toBeGreaterThan(swIndex);

    // Both turns actually answered (mock's deterministic echo).
    const textDeltas = events.filter((e) => e.t === "text").map((e) => e.delta ?? "").join("");
    expect(textDeltas).toContain("hello before");
    expect(textDeltas).toContain("hello after");
  }, 30_000);

  it("a switch to an unavailable provider is BLOCKED, reports why, and the conversation stays on the current provider — never a silent no-op", async () => {
    const r = await runPersistentChat([
      JSON.stringify({ type: "switch", provider: "anthropic" }),
      "still here?",
    ]);
    expect(r.code).toBe(0);
    const events = parseNdjson(r.stdout);

    const sw = events.find((e) => e.t === "switch");
    expect(sw).toBeDefined();
    expect(sw!.accepted).toBe(false);
    expect(sw!.blockers && sw!.blockers.length).toBeGreaterThan(0);
    expect(sw!.blockers![0]).toContain("anthropic");
    // A blocked switch has nothing preserved/adapted — there was no switch.
    expect(sw!.preserved).toEqual([]);
    expect(sw!.adaptations).toEqual([]);

    // The one and only turn still ran on the ORIGINAL provider — the block
    // was not a silent degrade to some other fallback either.
    const session = events.find((e) => e.t === "session");
    expect(session).toBeDefined();
    expect(session!.provider).toBe("mock");
  }, 30_000);

  it("the switch control line is never mistaken for a prompt (and vice versa)", async () => {
    // A message that merely CONTAINS the word "switch" as prose must still
    // dispatch as an ordinary turn — only a well-formed {"type":"switch",…}
    // JSON line is a control line, same discipline as the approval line.
    const r = await runPersistentChat(["please switch topics to gardening"]);
    expect(r.code).toBe(0);
    const events = parseNdjson(r.stdout);
    expect(events.some((e) => e.t === "switch")).toBe(false);
    const textDeltas = events.filter((e) => e.t === "text").map((e) => e.delta ?? "").join("");
    expect(textDeltas).toContain("please switch topics to gardening");
  }, 30_000);
});

/**
 * The bug this section exists to catch: switching to a provider whose REAL
 * model catalog is live-probed, not static (codex/gemini/anthropic — see
 * `listModelsForProvider`'s doc, `../src/runtime.ts`), used to be rejected
 * with "model … is not advertised by …" for every model that only the live
 * probe knew about, because `performSwitch` validated against
 * `capabilitiesOf`'s CURATED snapshot alone. Reproduced here with a small
 * `openai-compat` provider whose curated `models` config and its live `GET
 * /models` response are deliberately DISJOINT — exactly the codex shape
 * (`nexus models -p codex -o json` returns ids `capabilities().models` has
 * never heard of), fully offline via a local HTTP server.
 */
describe("nexus chat --persistent — switch control line, live-probed (non-curated) model", () => {
  const LIVE_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatswitch-live-cfg-")), "cfg");
  const LIVE_DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-chatswitch-live-data-")), "data");
  const LIVE_WORK_DIR = mkdtempSync(join(tmpdir(), "nx-chatswitch-live-cwd-"));
  let server: Server;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method !== "POST") {
        // The provider's REAL model catalog — disjoint from the curated
        // `models: ["curated-only"]` config below, mirroring codex's live
        // `doctor`-probed catalog vs. its static curated snapshot.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "live-only-model", object: "model" }] }));
        return;
      }
      // Never exercised by these tests (both assert on the `switch` event
      // itself, before any turn dispatches to the new target) but present so
      // a POST never hangs the child process if that ever changes.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "noted" }, finish_reason: "stop" }],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    mkdirSync(LIVE_CONFIG_DIR, { recursive: true });
    writeFileSync(
      join(LIVE_CONFIG_DIR, "config.json"),
      JSON.stringify({
        defaultProvider: "mock",
        providers: [
          {
            id: "live-probe",
            kind: "openai-compat",
            adapter: "@nexuscode/provider-openai",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKeyEnv: "LIVE_PROBE_API_KEY",
            models: ["curated-only"],
          },
        ],
      }),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function runLiveProbeChat(lines: string[]): ReturnType<typeof spawnCli> {
    return spawnCli(BIN, ["chat", "--persistent", "-p", "mock", "-m", "mock-fast", "-o", "ndjson"], {
      cwd: LIVE_WORK_DIR,
      input: lines.map((line) => `${line}\n`).join(""),
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: LIVE_CONFIG_DIR,
        NEXUS_DATA_DIR: LIVE_DATA_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        LIVE_PROBE_API_KEY: "test-key",
      },
    });
  }

  it("ACCEPTS a switch to a model the live probe advertises but the curated snapshot never listed", async () => {
    const r = await runLiveProbeChat([
      JSON.stringify({ type: "switch", provider: "live-probe", model: "live-only-model" }),
    ]);
    expect(r.code).toBe(0);
    const events = parseNdjson(r.stdout);
    const sw = events.find((e) => e.t === "switch");
    expect(sw).toBeDefined();
    expect(sw!.accepted, `blockers: ${JSON.stringify(sw!.blockers)}`).toBe(true);
    expect(sw!.to).toEqual({ providerId: "live-probe", modelId: "live-only-model" });
  }, 30_000);

  it("still REJECTS a model neither the live probe nor the curated snapshot advertises — the check stays real", async () => {
    const r = await runLiveProbeChat([
      JSON.stringify({ type: "switch", provider: "live-probe", model: "totally-bogus-model-xyz" }),
    ]);
    expect(r.code).toBe(0);
    const events = parseNdjson(r.stdout);
    const sw = events.find((e) => e.t === "switch");
    expect(sw).toBeDefined();
    expect(sw!.accepted).toBe(false);
    expect(sw!.blockers && sw!.blockers.length).toBeGreaterThan(0);
    expect(sw!.blockers!.join(" ")).toContain("totally-bogus-model-xyz");
    expect(sw!.blockers!.join(" ")).toContain("not advertised");
  }, 30_000);
});
