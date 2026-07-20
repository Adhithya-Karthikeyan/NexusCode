import { describe, it, expect } from "vitest";
import { shellExecTool, runTool, scrubSecretEnv, type ToolContext, type ToolEvent } from "@nexuscode/tools";

function textOf(content: { type: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

describe("shell_exec", () => {
  it("captures stdout and reports a zero exit code", async () => {
    const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd() };
    const r = await runTool(shellExecTool, { command: "node", args: ["-e", "process.stdout.write('hello')"] }, ctx);
    expect(r.ok).toBe(true);
    const body = textOf(r.content);
    expect(body).toContain("hello");
    expect(body).toMatch(/exit code 0/);
  });

  it("captures stderr and flags a non-zero exit as an error", async () => {
    const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd() };
    const r = await runTool(
      shellExecTool,
      { command: "node", args: ["-e", "process.stderr.write('boom'); process.exit(3)"] },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    const body = textOf(r.content);
    expect(body).toContain("boom");
    expect(body).toMatch(/exit code 3/);
  });

  it("does NOT interpret shell metacharacters (no injection)", async () => {
    const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd() };
    // If a shell were involved, `$(...)` would expand. As an argv it is literal.
    const r = await runTool(
      shellExecTool,
      { command: "node", args: ["-e", "process.stdout.write(process.argv[1])", "$(echo pwned)"] },
      ctx,
    );
    expect(textOf(r.content)).toContain("$(echo pwned)");
    expect(textOf(r.content)).not.toContain("pwned\n");
  });

  it("kills the process on timeout and flags an error", async () => {
    const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd() };
    const start = Date.now();
    const r = await runTool(
      shellExecTool,
      { command: "node", args: ["-e", "setTimeout(() => {}, 60000)"], timeoutMs: 250 },
      ctx,
    );
    expect(Date.now() - start).toBeLessThan(5000);
    expect(r.ok).toBe(false);
    expect(textOf(r.content)).toMatch(/timed out/);
  });

  it("cancels via AbortSignal", async () => {
    const ac = new AbortController();
    const ctx: ToolContext = { signal: ac.signal, cwd: process.cwd() };
    setTimeout(() => ac.abort(), 150);
    const r = await runTool(shellExecTool, { command: "node", args: ["-e", "setTimeout(() => {}, 60000)"] }, ctx);
    expect(r.ok).toBe(false);
    expect(textOf(r.content)).toMatch(/cancelled/);
  });

  it("streams incremental output events then a terminal result", async () => {
    const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd() };
    const events: ToolEvent[] = [];
    const iter = shellExecTool.run(
      { command: "node", args: ["-e", "process.stdout.write('streamed')"] },
      ctx,
    ) as AsyncIterable<ToolEvent>;
    for await (const ev of iter) events.push(ev);
    expect(events.some((e) => e.type === "output")).toBe(true);
    const last = events[events.length - 1]!;
    expect(last.type).toBe("result");
  });

  it("returns an error result when the command does not exist", async () => {
    const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd() };
    const r = await runTool(shellExecTool, { command: "definitely-not-a-real-binary-xyz" }, ctx);
    expect(r.ok).toBe(false);
    expect(textOf(r.content)).toMatch(/spawn error/);
  });

  it("scrubs secret-shaped env vars from the spawned child while PATH survives", async () => {
    const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd() };
    const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, MY_TOKEN: process.env.MY_TOKEN };
    process.env.OPENAI_API_KEY = "sk-should-not-leak-into-child";
    process.env.MY_TOKEN = "super-secret-token-value";
    try {
      const r = await runTool(
        shellExecTool,
        {
          command: "node",
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({hasKey:'OPENAI_API_KEY' in process.env,hasToken:'MY_TOKEN' in process.env,hasPath:Boolean(process.env.PATH)}))",
          ],
        },
        ctx,
      );
      expect(r.ok).toBe(true);
      const body = textOf(r.content);
      const jsonLine = body.split("--- stdout ---\n")[1]!.split("\n")[0]!;
      const parsed = JSON.parse(jsonLine) as { hasKey: boolean; hasToken: boolean; hasPath: boolean };
      expect(parsed.hasKey).toBe(false);
      expect(parsed.hasToken).toBe(false);
      expect(parsed.hasPath).toBe(true);
    } finally {
      if (saved.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
      if (saved.MY_TOKEN === undefined) delete process.env.MY_TOKEN;
      else process.env.MY_TOKEN = saved.MY_TOKEN;
    }
  });

  it("kills the process and flags an error once combined output exceeds maxOutputBytes", async () => {
    const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd() };
    // A well-behaved unbounded writer (honors backpressure via write()/'drain',
    // like `yes`/`cat` would) — the classic "yes > /dev/full firehose" shape,
    // without actually depending on the `yes` binary being on PATH.
    const script =
      "function loop(){const ok=process.stdout.write('a'.repeat(65536));" +
      "if(ok)setImmediate(loop);else process.stdout.once('drain',loop);}loop();";
    const start = Date.now();
    const r = await runTool(
      shellExecTool,
      {
        command: "node",
        args: ["-e", script],
        maxOutputBytes: 200_000,
        timeoutMs: 10_000,
      },
      ctx,
    );
    expect(Date.now() - start).toBeLessThan(8_000);
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toMatch(/output truncated at 200000 bytes/);
  }, 10_000);
});

describe("scrubSecretEnv", () => {
  it("removes secret-shaped names (KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL, provider prefixes) but keeps everything else", () => {
    const scrubbed = scrubSecretEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      OPENAI_API_KEY: "sk-abc",
      ANTHROPIC_API_KEY: "sk-ant-abc",
      MY_TOKEN: "tok",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      DB_PASSWORD: "pw",
      SOME_PASSWD: "pw2",
      API_CREDENTIAL: "cred",
      RANDOM_VAR: "keep-me",
    });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/x");
    expect(scrubbed.RANDOM_VAR).toBe("keep-me");
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.MY_TOKEN).toBeUndefined();
    expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(scrubbed.DB_PASSWORD).toBeUndefined();
    expect(scrubbed.SOME_PASSWD).toBeUndefined();
    expect(scrubbed.API_CREDENTIAL).toBeUndefined();
  });
});
