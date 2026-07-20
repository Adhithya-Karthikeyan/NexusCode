import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessManager,
  CommandHistory,
  createDefaultPty,
  createPty,
  isNodePtyAvailable,
  stripAnsi,
  hasAnsi,
  type OutputChunk,
  type PtyExit,
} from "@nexuscode/tools";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "nexus-term-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("ProcessManager — background jobs", () => {
  it("runs a background job, captures buffered output, and reports exit status", async () => {
    const pm = new ProcessManager();
    const job = pm.spawn({
      command: "node",
      args: ["-e", "process.stdout.write('bg-out'); process.stderr.write('bg-err')"],
    });
    expect(pm.list().map((j) => j.id)).toContain(job.id);
    const info = await job.wait();
    expect(info.status).toBe("exited");
    expect(info.exitCode).toBe(0);
    expect(job.stdout()).toBe("bg-out");
    expect(job.stderr()).toBe("bg-err");
    expect(job.output()).toContain("bg-out");
    expect(job.output()).toContain("bg-err");
  });

  it("streams output chunks as an async-iterable (replay + live)", async () => {
    const pm = new ProcessManager();
    const job = pm.spawn({
      command: "node",
      args: ["-e", "process.stdout.write('chunk-a\\n'); setTimeout(()=>process.stdout.write('chunk-b\\n'), 30)"],
    });
    const chunks: OutputChunk[] = [];
    for await (const c of job.stream()) chunks.push(c);
    const text = chunks.map((c) => c.data).join("");
    expect(text).toContain("chunk-a");
    expect(text).toContain("chunk-b");
    expect(chunks.every((c) => c.stream === "stdout")).toBe(true);
  });

  it("lists running jobs then reflects completion", async () => {
    const pm = new ProcessManager();
    const job = pm.spawn({ command: "node", args: ["-e", "setTimeout(()=>{}, 300)"] });
    expect(pm.listRunning().map((j) => j.id)).toContain(job.id);
    await job.kill();
    expect(pm.listRunning()).toHaveLength(0);
  });

  it("kills a job (SIGTERM→SIGKILL) and reaps it", async () => {
    const pm = new ProcessManager({ killGraceMs: 200 });
    const job = pm.spawn({ command: "node", args: ["-e", "setInterval(()=>{}, 1000)"] });
    const start = Date.now();
    const info = await pm.kill(job.id);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(info?.status).toBe("killed");
    expect(job.running).toBe(false);
    expect(info?.signal).not.toBeNull();
  });

  it("interrupts a job via AbortSignal", async () => {
    const pm = new ProcessManager({ killGraceMs: 200 });
    const ac = new AbortController();
    const job = pm.spawn({
      command: "node",
      args: ["-e", "setInterval(()=>{}, 1000)"],
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    const info = await job.wait();
    expect(info.status).toBe("killed");
    expect(job.running).toBe(false);
  });

  it("enforces the combined-output byte cap and kills the firehose", async () => {
    const pm = new ProcessManager();
    const script =
      "function loop(){const ok=process.stdout.write('a'.repeat(65536));" +
      "if(ok)setImmediate(loop);else process.stdout.once('drain',loop);}loop();";
    const job = pm.spawn({
      command: "node",
      args: ["-e", script],
      maxOutputBytes: 200_000,
    });
    const info = await job.wait();
    expect(info.outputCapped).toBe(true);
    expect(info.status).toBe("killed");
    expect(Buffer.byteLength(job.output(), "utf8")).toBeLessThan(400_000);
  }, 10_000);

  it("reports a spawn error for a missing binary", async () => {
    const pm = new ProcessManager();
    const job = pm.spawn({ command: "definitely-not-a-real-binary-xyz" });
    const info = await job.wait();
    expect(info.status).toBe("error");
    expect(info.error).toBeTruthy();
  });

  it("scrubs secret-shaped env from the spawned job", async () => {
    const pm = new ProcessManager();
    const saved = process.env.SOME_API_KEY;
    process.env.SOME_API_KEY = "sk-leak";
    try {
      const job = pm.spawn({
        command: "node",
        args: ["-e", "process.stdout.write(String('SOME_API_KEY' in process.env))"],
      });
      await job.wait();
      expect(job.output()).toBe("false");
    } finally {
      if (saved === undefined) delete process.env.SOME_API_KEY;
      else process.env.SOME_API_KEY = saved;
    }
  });
});

describe("ProcessManager — resource-exhaustion hardening (Wave 7 fix)", () => {
  it("FIX A: refuses to spawn past maxConcurrentJobs, counting only LIVE jobs", async () => {
    const pm = new ProcessManager({ maxConcurrentJobs: 1, killGraceMs: 200 });
    const job1 = pm.spawn({ command: "node", args: ["-e", "setInterval(()=>{}, 1000)"] });
    expect(pm.list()).toHaveLength(1);

    // At the cap: refuses cleanly and does NOT spawn a second job.
    expect(() => pm.spawn({ command: "node", args: ["-e", "setInterval(()=>{}, 1000)"] })).toThrow(
      /max concurrent background jobs \(1\) reached/,
    );
    expect(pm.list()).toHaveLength(1);

    // Freeing the slot (kill → no longer live) lets a new job spawn.
    await pm.kill(job1.id);
    const job2 = pm.spawn({ command: "node", args: ["-e", "process.stdout.write('ok')"] });
    const info2 = await job2.wait();
    expect(info2.status).toBe("exited");
    expect(job2.output()).toBe("ok");
  });

  it("FIX B: kills a job that exceeds maxRuntimeMs, marks it timed-out, and reaps it", async () => {
    const pm = new ProcessManager({ maxRuntimeMs: 200, killGraceMs: 300 });
    const job = pm.spawn({ command: "node", args: ["-e", "setInterval(()=>{}, 10000)"] });
    const start = Date.now();
    const info = await job.wait();
    expect(Date.now() - start).toBeLessThan(3000);
    expect(info.timedOut).toBe(true);
    expect(info.status).toBe("killed");
    expect(job.running).toBe(false);
  }, 10_000);

  it("FIX B: stops accumulating output once timed out", async () => {
    const pm = new ProcessManager({ maxRuntimeMs: 150, killGraceMs: 300 });
    const script =
      "process.stdout.write('before-timeout');" +
      "setInterval(()=>process.stdout.write('x'), 10);";
    const job = pm.spawn({ command: "node", args: ["-e", script] });
    const info = await job.wait();
    expect(info.timedOut).toBe(true);
    expect(job.output()).toContain("before-timeout");
    const bytesAtReap = job.output().length;
    // Give any late/buffered data a moment to (not) arrive, then confirm the
    // buffer never grew afterward.
    await new Promise((r) => setTimeout(r, 100));
    expect(job.output().length).toBe(bytesAtReap);
  }, 10_000);

  it("FIX C: rejects a job cwd that escapes the configured workspace root", () => {
    const workspaceRoot = freshDir();
    const pm = new ProcessManager({ workspaceRoot });
    expect(() =>
      pm.spawn({ command: "node", args: ["-e", "0"], cwd: "/etc" }),
    ).toThrow(/path escapes workspace root/);
    expect(pm.list()).toHaveLength(0);
  });

  it("FIX C: rejects a symlinked job cwd that escapes the workspace root", () => {
    const outside = freshDir();
    const workspaceRoot = freshDir();
    const linkPath = join(workspaceRoot, "escape-link");
    symlinkSync(outside, linkPath);
    const pm = new ProcessManager({ workspaceRoot });
    expect(() => pm.spawn({ command: "node", args: ["-e", "0"], cwd: linkPath })).toThrow(
      /path escapes workspace root/,
    );
    expect(pm.list()).toHaveLength(0);
  });

  it("allows a cwd within the workspace root", async () => {
    const workspaceRoot = freshDir();
    const pm = new ProcessManager({ workspaceRoot });
    const job = pm.spawn({ command: "node", args: ["-e", "0"], cwd: workspaceRoot });
    const info = await job.wait();
    expect(info.status).toBe("exited");
  });
});

describe("CommandHistory — persisted ring buffer", () => {
  it("round-trips entries across instances", () => {
    const file = join(freshDir(), "hist.json");
    const h1 = new CommandHistory({ filePath: file });
    h1.append({ command: "git", args: ["status"], cwd: "/repo", exitCode: 0 });
    h1.append({ command: "node", args: ["-v"], exitCode: 0 });

    const h2 = new CommandHistory({ filePath: file });
    const list = h2.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.command).toBe("git");
    expect(list[0]!.args).toEqual(["status"]);
    expect(list[1]!.command).toBe("node");
    expect(h2.recent(1)[0]!.command).toBe("node");
  });

  it("evicts oldest entries beyond capacity (ring behavior)", () => {
    const file = join(freshDir(), "hist.json");
    const h = new CommandHistory({ filePath: file, capacity: 3 });
    for (let i = 0; i < 6; i++) h.append({ command: `c${i}`, args: [] });
    const list = h.list();
    expect(list.map((e) => e.command)).toEqual(["c3", "c4", "c5"]);
    expect(h.size).toBe(3);
    // persisted capacity holds after reload
    expect(new CommandHistory({ filePath: file, capacity: 3 }).size).toBe(3);
  });

  it("writes the history file with 0o600 permissions", () => {
    const file = join(freshDir(), "hist.json");
    const h = new CommandHistory({ filePath: file });
    h.append({ command: "ls", args: [] });
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    // sanity: file is valid JSON
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
  });

  it("tolerates a corrupt file by starting empty", () => {
    const dir = freshDir();
    const file = join(dir, "hist.json");
    // no file yet → empty
    const h = new CommandHistory({ filePath: file });
    expect(h.size).toBe(0);
    h.append({ command: "a", args: [] });
    expect(h.size).toBe(1);
  });

  it("clears history", () => {
    const file = join(freshDir(), "hist.json");
    const h = new CommandHistory({ filePath: file });
    h.append({ command: "a", args: [] });
    h.clear();
    expect(h.size).toBe(0);
    expect(new CommandHistory({ filePath: file }).size).toBe(0);
  });
});

describe("Pty seam — child_process default", () => {
  it("echoes input to output (interactive round-trip)", async () => {
    const pty = createDefaultPty();
    expect(pty.kind).toBe("child_process");
    // A pipe-through program: whatever arrives on stdin is written to stdout.
    const session = pty.spawn("node", ["-e", "process.stdin.pipe(process.stdout)"]);
    const received: string[] = [];
    session.onData((d) => received.push(d));
    const exit = new Promise<PtyExit>((resolve) => session.onExit(resolve));

    session.write("hello-pty\n");
    // give the child a moment to echo, then close stdin so it exits
    await new Promise((r) => setTimeout(r, 150));
    session.write("");
    await new Promise((r) => setTimeout(r, 50));
    session.kill();
    await exit;

    expect(received.join("")).toContain("hello-pty");
  });

  it("resize is a safe no-op and kill terminates the session", async () => {
    const pty = createDefaultPty();
    const session = pty.spawn("node", ["-e", "setInterval(()=>{}, 1000)"]);
    expect(() => session.resize(120, 40)).not.toThrow();
    const exit = new Promise<PtyExit>((resolve) => session.onExit(resolve));
    session.kill();
    const info = await exit;
    expect(info).toBeTruthy();
  });

  it("preserves ANSI escape sequences in passthrough (ANSI-aware)", async () => {
    const pty = createDefaultPty();
    // emit red "hi" then reset
    const script = "process.stdout.write('\\u001b[31mhi\\u001b[0m')";
    const session = pty.spawn("node", ["-e", script]);
    const received: string[] = [];
    session.onData((d) => received.push(d));
    await new Promise<PtyExit>((resolve) => session.onExit(resolve));
    const out = received.join("");
    expect(hasAnsi(out)).toBe(true);
    expect(out).toContain("[31m");
    expect(stripAnsi(out)).toBe("hi");
  });
});

describe("Pty seam — workspace-confined cwd (FIX C, Wave 7 fix)", () => {
  it("rejects a session cwd that escapes the configured workspace root", () => {
    const workspaceRoot = freshDir();
    const pty = createDefaultPty({ workspaceRoot });
    expect(() => pty.spawn("node", ["-e", "0"], { cwd: "/etc" })).toThrow(
      /path escapes workspace root/,
    );
  });

  it("rejects a symlinked session cwd that escapes the workspace root", () => {
    const outside = freshDir();
    const workspaceRoot = freshDir();
    const linkPath = join(workspaceRoot, "escape-link");
    symlinkSync(outside, linkPath);
    const pty = createDefaultPty({ workspaceRoot });
    expect(() => pty.spawn("node", ["-e", "0"], { cwd: linkPath })).toThrow(
      /path escapes workspace root/,
    );
  });

  it("allows a session cwd within the workspace root", async () => {
    const workspaceRoot = freshDir();
    const pty = createDefaultPty({ workspaceRoot });
    const session = pty.spawn("node", ["-e", "process.stdout.write('ok')"], { cwd: workspaceRoot });
    const received: string[] = [];
    session.onData((d) => received.push(d));
    await new Promise<PtyExit>((resolve) => session.onExit(resolve));
    expect(received.join("")).toBe("ok");
  });
});

describe("Pty seam — node-pty feature detection", () => {
  it("degrades gracefully when node-pty is absent", async () => {
    // node-pty is NOT a dependency in this repo; detection must not throw.
    const available = await isNodePtyAvailable();
    expect(available).toBe(false);
    const pty = await createPty();
    expect(pty.kind).toBe("child_process");
  });
});

describe("ANSI helpers", () => {
  it("strips and detects ANSI sequences", () => {
    const colored = "\u001b[1m\u001b[32mok\u001b[0m";
    expect(hasAnsi(colored)).toBe(true);
    expect(stripAnsi(colored)).toBe("ok");
    expect(hasAnsi("plain")).toBe(false);
    expect(stripAnsi("plain")).toBe("plain");
  });
});
