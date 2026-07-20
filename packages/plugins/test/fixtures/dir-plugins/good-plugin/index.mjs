/**
 * A well-formed fixture plugin. Default export is a `register(host)` function —
 * the primary module contract. It contributes a provider adapter, a tool, a
 * prompt template, and a CLI command, each matching a declared id in plugin.json.
 * Pure ESM with zero external imports, so the whole load path stays offline.
 */

/** A minimal, offline `ProviderAdapter`. Enough to register + resolve + chat. */
const fixtureAdapter = {
  id: "fixture-llm",
  label: "Fixture LLM (offline)",
  transport: "http-openai-compat",
  async capabilities() {
    return {
      models: [{ id: "fixture-model", aliases: ["fixture-fast"] }],
      streaming: true,
      tools: false,
      parallelToolCalls: false,
      vision: false,
      structuredOutput: false,
      reasoning: false,
      systemPrompt: true,
      fileEdit: false,
      shellExec: false,
      git: false,
      approvalGate: false,
      mcp: false,
      cancel: "abort-signal",
    };
  },
  async chat(req) {
    const last = [...req.messages].reverse().find((m) => m.role === "user");
    const text =
      last && Array.isArray(last.content)
        ? last.content.map((b) => (b.type === "text" ? b.text : "")).join("")
        : "";
    return {
      message: { role: "assistant", content: [{ type: "text", text: `fixture:${text}` }] },
      finishReason: "stop",
    };
  },
  async *stream(req, ctx) {
    const result = await this.chat(req, ctx);
    yield { type: "text-delta", text: result.message.content[0].text };
  },
};

/** A trivial, offline tool that echoes its `message` argument. */
const echoTool = {
  name: "fixture_echo",
  description: "Echo the provided message back.",
  parameters: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  permission: "read",
  async run(input) {
    const message = input && typeof input === "object" ? String(input.message ?? "") : "";
    return { ok: true, content: [{ type: "text", text: `echo:${message}` }] };
  },
};

export default function register(host) {
  host.log("registering fixture contributions");
  host.contributeProvider(fixtureAdapter);
  host.contributeTool(echoTool);
  host.contributePrompt({
    id: "fixture.greeting",
    version: "1.0.0",
    body: "Hello, {{name}}!",
  });
  host.contributeCommand({
    name: "fixture",
    description: "A fixture CLI subcommand.",
    run: () => {},
  });
}
