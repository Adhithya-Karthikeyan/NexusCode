/**
 * Background indexing (system-spec §23): `nexus index --background` must launch a
 * DETACHED re-index and return immediately, never blocking interactive use. This
 * verifies the launch semantics with an injected spawn — offline, no real fork.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The fork-bomb-guard test below exercises `cmdIndex` directly (NOT via
// `runIndexInBackground`'s injected spawn) with the child-marker env var set.
// If the guard ever regressed, `cmdIndex` would call the REAL
// `runIndexInBackground`, which spawns via `node:child_process`'s `spawn` —
// replace it with a pure stub (never the real implementation) so such a
// regression can be OBSERVED by the test without ever actually forking a
// process from the test run.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ pid: -1, unref: () => {} }) as unknown as ReturnType<typeof actual.spawn>),
  };
});

import { spawn as mockedSpawn } from "node:child_process";
import {
  runIndexInBackground,
  cmdIndex,
  NEXUS_INDEX_CHILD_ENV,
  type IndexSpawnLike,
} from "../src/commands.js";
import type { ParsedArgs } from "../src/args.js";

interface CapturedIo {
  out: (s: string) => void;
  err: (s: string) => void;
  stdout: string;
  stderr: string;
}
function makeIo(): CapturedIo {
  const io: CapturedIo = {
    stdout: "",
    stderr: "",
    out: (s: string) => {
      io.stdout += s;
    },
    err: (s: string) => {
      io.stderr += s;
    },
  };
  return io;
}

describe("runIndexInBackground", () => {
  it("spawns a DETACHED, unref'd child that re-runs `index` without --background", () => {
    const calls: Array<{ command: string; args: string[]; options: { detached: boolean; stdio: string } }> = [];
    let unrefed = false;
    const spawn: IndexSpawnLike = (command, args, options) => {
      calls.push({ command, args, options });
      return {
        pid: 4242,
        unref: () => {
          unrefed = true;
        },
      };
    };

    const io = makeIo();
    const code = runIndexInBackground("/repo/root", "text", io, spawn);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    // Detached + no inherited stdio so the parent can exit cleanly.
    expect(calls[0]!.options.detached).toBe(true);
    expect(calls[0]!.options.stdio).toBe("ignore");
    expect(unrefed).toBe(true);
    // The child re-invokes `index <root>` — and crucially NOT `--background`
    // (otherwise it would fork forever).
    expect(calls[0]!.args).toContain("index");
    expect(calls[0]!.args).toContain("/repo/root");
    expect(calls[0]!.args).not.toContain("--background");
    // Reports the pid to the user, and never blocks.
    expect(io.stdout).toContain("4242");
    expect(io.stdout).toContain("background");
  });

  it("emits JSON when the output mode is json", () => {
    const spawn: IndexSpawnLike = () => ({ pid: 7, unref: () => {} });
    const io = makeIo();
    const code = runIndexInBackground("/r", "json", io, spawn);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdout.trim());
    expect(parsed).toMatchObject({ background: true, pid: 7, root: "/r" });
  });

  it("stamps the child with the NEXUS_INDEX_CHILD marker so it cannot re-fork", () => {
    // Fork-bomb guard: the detached child must carry an explicit env marker.
    // cmdIndex short-circuits on it, so neither --background NOR
    // config.performance.background can re-trigger backgrounding in the child.
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawn: IndexSpawnLike = (_command, _args, options) => {
      capturedEnv = options.env;
      return { pid: 99, unref: () => {} };
    };
    const io = makeIo();
    const code = runIndexInBackground("/repo", "text", io, spawn);
    expect(code).toBe(0);
    expect(capturedEnv?.[NEXUS_INDEX_CHILD_ENV]).toBe("1");
  });
});

describe("cmdIndex — child-side fork-bomb guard", () => {
  const dirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(name: string, value: string): void {
    if (!(name in savedEnv)) savedEnv[name] = process.env[name];
    process.env[name] = value;
  }

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const k of Object.keys(savedEnv)) delete savedEnv[k];
    while (dirs.length) {
      const d = dirs.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
    vi.mocked(mockedSpawn).mockClear();
  });

  it("runs the FOREGROUND index even when config.performance.background is true, because the child marker is set", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "nx-idx-cfg-"));
    dirs.push(configDir);
    const dataDir = mkdtempSync(join(tmpdir(), "nx-idx-data-"));
    dirs.push(dataDir);
    const repoDir = mkdtempSync(join(tmpdir(), "nx-idx-repo-"));
    dirs.push(repoDir);
    writeFileSync(join(repoDir, "a.txt"), "hello world, index me\n");

    // The config a real detached child would inherit: backgrounding ON.
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ performance: { background: true } }));

    setEnv("NEXUS_CONFIG_DIR", configDir);
    setEnv("NEXUS_DATA_DIR", dataDir);
    setEnv("NEXUSCODE_DATA_DIR", dataDir);
    // The marker `runIndexInBackground` stamps on its detached child.
    setEnv(NEXUS_INDEX_CHILD_ENV, "1");

    const args: ParsedArgs = {
      positionals: [repoDir],
      flags: new Map([["output", "json"]]),
      multi: new Map(),
      bools: new Set(), // NOTE: no "--background" flag either — config alone would trigger it.
    };
    let stdout = "";
    const io = { out: (s: string) => (stdout += s), err: () => {} };

    const code = await cmdIndex(args, io);

    // Foreground work actually ran (real index output), NOT a "launched in the
    // background" message — and critically, the spawn path was never taken at
    // all, so no re-fork could have happened.
    expect(code).toBe(0);
    expect(stdout).not.toContain("background");
    const parsed = JSON.parse(stdout.trim()) as { root: string };
    expect(parsed.root).toBe(repoDir);
    expect(mockedSpawn).not.toHaveBeenCalled();
  }, 20_000);
});
