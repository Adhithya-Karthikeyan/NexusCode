/**
 * Wave-10 CLI integration fixture plugin. Uses the register-function contract to
 * contribute one offline provider adapter, one read-class tool, and one prompt —
 * each matching a declared id in plugin.json. Pure ESM, zero imports, offline.
 */

const wave10Adapter = {
  id: "wave10-llm",
  label: "Wave10 LLM (offline fixture)",
  transport: "http-openai-compat",
  async capabilities() {
    return {
      models: [{ id: "wave10-model", aliases: ["wave10-fast"] }],
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
      message: { role: "assistant", content: [{ type: "text", text: `wave10:${text}` }] },
      finishReason: "stop",
    };
  },
  async *stream(req, ctx) {
    const result = await this.chat(req, ctx);
    yield { type: "text-delta", text: result.message.content[0].text };
  },
};

const pingTool = {
  name: "wave10_ping",
  description: "A read-class fixture tool contributed by a plugin.",
  parameters: {
    type: "object",
    properties: { message: { type: "string" } },
    required: [],
  },
  permission: "read",
  async run(input) {
    const message = input && typeof input === "object" ? String(input.message ?? "pong") : "pong";
    return { isError: false, content: [{ type: "text", text: `wave10_ping:${message}` }] };
  },
};

export default function register(host) {
  host.log("registering wave10 fixture contributions");
  host.contributeProvider(wave10Adapter);
  host.contributeTool(pingTool);
  host.contributePrompt({ id: "wave10.greeting", version: "1.0.0", body: "Hi {{name}}" });
}
