import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSubprocessAdapter,
  defaultSpawn,
  type CliSpec,
  type SpawnExit,
  type SpawnedChild,
  type SpawnFn,
  type SubprocessConfig,
} from "@nexuscode/provider-subprocess";
import type { CallContext } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANG_FIXTURE = path.join(HERE, "fixtures", "fake-claude-hang.mjs");

function ctx(signal: AbortSignal, runId = "run_base"): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId };
}
function req(): ChatRequest {
  return { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
}
async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

// A minimal spec that never maps a terminal line — used to exercise base rules.
const noopSpec: CliSpec<SubprocessConfig> = {
  id: "test-cli",
  label: "Test CLI",
  defaultBin: "test-cli",
  resolveModel: (_cfg, r) => r.model,
  buildArgs: () => [],
  handleEvent: () => {},
};

describe("subprocess base — transport failures", () => {
  it("a missing binary (ENOENT) maps to a retryable transport error, not a throw", async () => {
    const adapter = createSubprocessAdapter({ bin: "definitely-not-real-binary-xyz-123" }, noopSpec);
    const chunks = await collect(adapter.stream(req(), ctx(new AbortController().signal)));
    expect(chunks[0]?.type).toBe("run-start");
    const last = chunks[chunks.length - 1];
    expect(last?.type === "error" && last.error.code).toBe("transport");
    expect(last?.type === "error" && last.retryable).toBe(true);
  });

  it("a synchronous spawn throw maps to a transport error", async () => {
    const adapter = createSubprocessAdapter(
      {
        bin: "x",
        spawn: () => {
          throw new Error("boom");
        },
      },
      noopSpec,
    );
    const chunks = await collect(adapter.stream(req(), ctx(new AbortController().signal)));
    const last = chunks[chunks.length - 1];
    expect(last?.type === "error" && last.error.code).toBe("transport");
    expect(last?.type === "error" && last.error.message).toContain("boom");
  });

  it("run-start is always first and exactly one terminal chunk is emitted", async () => {
    const adapter = createSubprocessAdapter({ bin: "definitely-not-real-binary-xyz-123" }, noopSpec);
    const chunks = await collect(adapter.stream(req(), ctx(new AbortController().signal)));
    expect(chunks.filter((c) => c.type === "run-start")).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "run-end" || c.type === "error")).toHaveLength(1);
    expect(chunks[0]?.type).toBe("run-start");
  });
});

// A spec that launches the fixture via `node <fixture>` and never maps a
// terminal line — abort is the only way this run ends.
const hangSpec: CliSpec<SubprocessConfig> = {
  id: "hang-cli",
  label: "Hang CLI",
  defaultBin: process.execPath,
  resolveModel: (_cfg, r) => r.model,
  buildArgs: () => [HANG_FIXTURE],
  handleEvent: () => {},
};

// A spec whose `stream()` argv is a `node -e` one-liner that exits immediately
// with code 0 — deterministic and fast, no reliance on stdin/EOF timing
// quirks across platforms. Used to inspect the env actually handed to spawn.
const quickExitSpec: CliSpec<SubprocessConfig> = {
  id: "quick-exit-cli",
  label: "Quick Exit CLI",
  defaultBin: process.execPath,
  resolveModel: (_cfg, r) => r.model,
  buildArgs: () => ["-e", "process.exit(0)"],
  handleEvent: () => {},
};

describe("subprocess base — abort reaping (SIGINT → SIGTERM escalation)", () => {
  it("force-kills a child that ignores SIGINT once the grace window elapses", async () => {
    // Observe the real child's exit disposition by wrapping defaultSpawn.
    let observedExit: SpawnExit | undefined;
    let spawnedChild: SpawnedChild | undefined;
    const spawn: SpawnFn = (bin, args, opts) => {
      const child = defaultSpawn(bin, args, opts);
      spawnedChild = child;
      void child.done.then((e) => {
        observedExit = e;
      });
      return child;
    };

    const ac = new AbortController();
    const adapter = createSubprocessAdapter(
      { bin: process.execPath, spawn, killGraceMs: 150 },
      hangSpec,
    );

    // Drain the stream in the background; abort once the child is up.
    const chunks: StreamChunk[] = [];
    const drained = (async () => {
      for await (const c of adapter.stream(req(), ctx(ac.signal))) chunks.push(c);
    })();

    // Give the fixture a beat to install its SIGINT handler, then abort. The
    // child ignores the SIGINT; only the SIGTERM escalation can reap it.
    await new Promise((r) => setTimeout(r, 250));
    ac.abort();

    await drained;

    // The child actually exited (was reaped) — `child.done` resolved.
    expect(observedExit).toBeDefined();
    expect(spawnedChild).toBeDefined();
    // SIGTERM is what ended it — the ignored SIGINT could not. (The fixture
    // traps SIGTERM and exits 143; without a trap the signal would be SIGTERM.)
    expect(observedExit?.signal === "SIGTERM" || observedExit?.exitCode === 143).toBe(true);

    // Terminal chunk reflects the abort.
    const last = chunks[chunks.length - 1];
    expect(last?.type === "error" && last.error.code).toBe("cancelled");
  }, 10_000);
});

describe("subprocess base — secret env scrubbing (resolveChildEnv)", () => {
  it("scrubs secret-shaped ambient env vars from the spawned child, merging `extra` on top", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-should-not-leak-into-child";
    try {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const spawn: SpawnFn = (bin, args, opts) => {
        capturedEnv = opts.env;
        return defaultSpawn(bin, args, opts);
      };

      const adapter = createSubprocessAdapter(
        {
          bin: process.execPath,
          spawn,
          // The adapter's own resolveEnv is how a real CLI gets its needed
          // credential (e.g. ANTHROPIC_API_KEY) — it must survive scrubbing.
          resolveEnv: async () => ({ ANTHROPIC_API_KEY: "explicit-extra-key" }),
        },
        quickExitSpec,
      );

      await collect(adapter.stream(req(), ctx(new AbortController().signal)));

      expect(capturedEnv).toBeDefined();
      // The ambient secret never reaches the child...
      expect(capturedEnv?.OPENAI_API_KEY).toBeUndefined();
      // ...but the explicitly-resolved credential does.
      expect(capturedEnv?.ANTHROPIC_API_KEY).toBe("explicit-extra-key");
      // Non-secret ambient vars (PATH, HOME) survive untouched.
      expect(capturedEnv?.PATH).toBe(process.env.PATH);
      if (process.env.HOME !== undefined) expect(capturedEnv?.HOME).toBe(process.env.HOME);
    } finally {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });
});

describe("subprocess base — health() probe reaping and timeout", () => {
  it("reaps a hung `--version` child via a timeout instead of hanging or leaking it", async () => {
    let observedExit: SpawnExit | undefined;
    let spawnedChild: SpawnedChild | undefined;
    const spawn: SpawnFn = (bin, args, opts) => {
      const child = defaultSpawn(bin, args, opts);
      spawnedChild = child;
      void child.done.then((e) => {
        observedExit = e;
      });
      return child;
    };

    // Reuse the fixture that idles forever once started — the `--version`
    // probe never gets a response, so only the health timeout can end it.
    const hangHealthSpec: CliSpec<SubprocessConfig> = { ...hangSpec, versionArgs: [HANG_FIXTURE] };
    const adapter = createSubprocessAdapter(
      { bin: process.execPath, spawn, healthTimeoutMs: 200 },
      hangHealthSpec,
    );

    const health = await adapter.health!(ctx(new AbortController().signal));

    expect(health.ok).toBe(false);
    expect(health.detail).toContain("timed out");
    // The child was actually reaped (its `done` resolved), not left running.
    expect(spawnedChild).toBeDefined();
    expect(observedExit).toBeDefined();
  }, 10_000);
});
