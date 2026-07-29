/**
 * THE REAL-RUN WIRE TEST for `--effort` against the native Anthropic adapter
 * — through the REAL compiled `nexus` binary, the REAL `@nexuscode/provider-
 * anthropic` package (unmodified `createAnthropicAdapter`/`toNativeRequest`),
 * and a REAL network round trip (loopback, not a spy). This is deliberately
 * NOT a unit test: `effort-wire.test.ts` already proved `dispatch()` attaches
 * `reasoning` to a synthetic spy adapter, and `reasoning.test.ts`
 * (`packages/providers/anthropic`) already proved `toNativeRequest` turns
 * `reasoning.enabled` into `thinking` in isolation — neither proves the value
 * survives the FULL path a real `nexus ask -p anthropic` run takes: CLI arg
 * parsing → `applyEffort` → `runOrchestration` → the engine → `dispatch()` →
 * the REAL adapter's `stream()` → the SDK client → an actual HTTP POST.
 *
 * A local HTTP server stands in for `api.anthropic.com` (same pattern as
 * `chat-quota.integration.test.ts`'s OpenAI-compat stand-in), registered via
 * an explicit `providers[]` config entry with `kind: "anthropic"` — the SAME
 * `loadConfiguredAdapter` path (`packages/runtime/src/index.ts`) the real
 * default "anthropic" OAuth provider also goes through, just with the plain
 * `apiKeyEnv` credential instead of an OAuth bearer. This environment has no
 * live OAuth session to test that specific leg with — a live account is the
 * only way to confirm the OAuth-bearer path matches (still open, reported
 * separately). It captures the EXACT JSON body the adapter sent and asserts
 * `thinking` is present, and that `max_tokens` actually leaves room for it —
 * the two things no earlier test in this area proved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnCli } from "./helpers/spawn-cli.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * A best-effort Anthropic Messages streaming SSE response. It does NOT get
 * the real `nexus ask` run to a clean exit 0 — the pinned SDK's stream
 * helper still reports "stream ended without producing a Message with
 * role=assistant" against it, some framing detail of the real protocol this
 * hand-rolled fixture doesn't reproduce exactly. That is a LIMITATION OF
 * THIS FIXTURE, not evidence about the bug under test: the request body is
 * captured by this file's own HTTP server BEFORE any response is even sent,
 * so what matters for these assertions — the exact JSON NexusCode sent — is
 * captured regardless of how the fake reply is later received. Assertions
 * below check the captured body directly rather than `r.code`.
 */
const FAKE_SSE_BODY = [
  `event: message_start`,
  `data: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-fake",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  })}`,
  ``,
  `event: content_block_start`,
  `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
  ``,
  `event: content_block_delta`,
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}`,
  ``,
  `event: content_block_stop`,
  `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
  ``,
  `event: message_delta`,
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}`,
  ``,
  `event: message_stop`,
  `data: ${JSON.stringify({ type: "message_stop" })}`,
  ``,
].join("\n");

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

interface CapturedRequest {
  path: string;
  body: unknown;
}

function freshDirs(prefix: string): { configDir: string; dataDir: string; workDir: string } {
  const configDir = join(mkdtempSync(join(tmpdir(), `${prefix}-cfg-`)), "cfg");
  const dataDir = join(mkdtempSync(join(tmpdir(), `${prefix}-data-`)), "data");
  const workDir = mkdtempSync(join(tmpdir(), `${prefix}-work-`));
  return { configDir, dataDir, workDir };
}

let server: Server;
let port: number;
let captured: CapturedRequest[] = [];

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before this test`);
  }
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep raw string — still useful evidence if the SDK ever sends non-JSON
      }
      captured.push({ path: req.url ?? "", body });
      // `GET /v1/models` (health/model-listing probes the runtime may issue) —
      // answer harmlessly so registration never blocks on this endpoint.
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(FAKE_SSE_BODY);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * `id: "anthropic"` — NOT a made-up id. Verified live (against the REAL
 * `@nexuscode/provider-anthropic` package): `createAnthropicAdapter()`
 * returns an adapter object whose `id` is the package's own hardcoded
 * `PROVIDER_ID` constant ("anthropic"), completely ignoring whatever `id`
 * the `providers[]` config entry that constructed it used. A config entry
 * with `kind: "anthropic"` and a custom id (e.g. "work-anthropic") silently
 * registers under "anthropic" instead — a separate, narrower finding
 * reported alongside this test's real subject, not fixed here (out of
 * scope for the effort-wiring bug this file exists to prove/disprove; flag
 * it if a second Anthropic-kind provider entry is ever wanted).
 */
/**
 * `apiKeyEnv: "ANTHROPIC_API_KEY"` — NOT the custom env this config entry's
 * OWN `apiKeyEnv` field would suggest. Verified live: `cmdAsk` builds its
 * runtime through `buildAuthedRuntime`, which wires an id-"anthropic" entry
 * through `packages/cli/src/auth.ts`'s auth registry — that registry
 * HARDCODES `apiKeyEnv: ANTHROPIC_API_KEY_ENV` ("ANTHROPIC_API_KEY") for id
 * "anthropic" specifically, ignoring whatever `apiKeyEnv` the `providers[]`
 * entry itself declares (a plain `buildRuntime()` with no auth registry, by
 * contrast, DOES honor the config's own `apiKeyEnv` — confirmed by direct
 * comparison). So the credential this test's server actually receives must
 * be supplied via the STANDARD env var, or the CLI resolves no credential at
 * all and every request 401s before reasoning is even relevant.
 */
function writeConfig(configDir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      defaultProvider: "anthropic",
      defaultModel: "claude-fake",
      providers: [
        {
          id: "anthropic",
          kind: "anthropic",
          adapter: "@nexuscode/provider-anthropic",
          baseUrl: `http://127.0.0.1:${port}`,
          apiKeyEnv: "ANTHROPIC_API_KEY",
          modelMap: { "claude-fake": "claude-fake" },
        },
      ],
      ...extra,
    }),
  );
}

function runNexus(dirs: ReturnType<typeof freshDirs>, args: string[]) {
  return spawnCli(BIN, args, {
    cwd: dirs.workDir,
    env: {
      ...process.env,
      NEXUS_CONFIG_DIR: dirs.configDir,
      NEXUS_DATA_DIR: dirs.dataDir,
      NEXUSCODE_DATA_DIR: dirs.dataDir,
      NEXUS_HISTORY_DISABLED: "1",
      NEXUS_VAULT_PASSPHRASE: "test-passphrase",
      ANTHROPIC_API_KEY: "test-key-123",
    },
  });
}

describe("nexus ask -p <anthropic-kind provider> --effort — the request that ACTUALLY leaves the process", () => {
  it("an EXPLICIT --effort high produces a POST body carrying thinking:{type:'enabled', budget_tokens:24000}", async () => {
    captured = [];
    const dirs = freshDirs("nx-effort-anthropic-explicit");
    writeConfig(dirs.configDir);
    const r = await runNexus(dirs, ["ask", "-p", "anthropic", "--effort", "high", "hi there"]);
    // Not asserting r.code here — see FAKE_SSE_BODY's doc: this fixture's
    // reply doesn't get the SDK to a clean finish, but the REQUEST (what
    // this test actually verifies) was already captured before any reply
    // was sent.
    expect(r.stderr).not.toContain("does not support reasoning effort");

    const messageCalls = captured.filter((c) => c.path.includes("/v1/messages"));
    expect(messageCalls).toHaveLength(1);
    const body = messageCalls[0]!.body as { thinking?: unknown; max_tokens?: number };
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 24_000 });
    // Real Anthropic constraint: max_tokens must exceed thinking.budget_tokens.
    // The CLI has no --max-tokens flag, so the DEFAULT (4096) would otherwise
    // sit well under a 24k "high" budget — this is the second half of the bug
    // a live run surfaced that no earlier unit test caught.
    expect(body.max_tokens).toBeGreaterThan(24_000);
  }, 20_000);

  it("NO --effort flag at all still enables thinking — the implicit 'medium' default reaches the real wire", async () => {
    captured = [];
    const dirs = freshDirs("nx-effort-anthropic-implicit");
    writeConfig(dirs.configDir);
    await runNexus(dirs, ["ask", "-p", "anthropic", "hi there"]);

    const messageCalls = captured.filter((c) => c.path.includes("/v1/messages"));
    expect(messageCalls).toHaveLength(1);
    const body = messageCalls[0]!.body as { thinking?: unknown; max_tokens?: number };
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10_000 });
    expect(body.max_tokens).toBeGreaterThan(10_000);
  }, 20_000);

  it("an EXPLICIT --effort off produces a POST body with NO thinking key at all — fully overridable", async () => {
    captured = [];
    const dirs = freshDirs("nx-effort-anthropic-off");
    writeConfig(dirs.configDir);
    await runNexus(dirs, ["ask", "-p", "anthropic", "--effort", "off", "hi there"]);

    const messageCalls = captured.filter((c) => c.path.includes("/v1/messages"));
    expect(messageCalls).toHaveLength(1);
    const body = messageCalls[0]!.body as { thinking?: unknown };
    expect(body.thinking).toBeUndefined();
  }, 20_000);
});
