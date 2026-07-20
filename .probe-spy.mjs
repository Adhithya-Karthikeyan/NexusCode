// Definitive probe: register a SPY adapter that records the exact ChatRequest
// the harness hands the model on every turn.
import { createNexus } from "@nexuscode/sdk";

const seen = [];

function spyAdapter() {
  return {
    id: "spy",
    label: "Spy",
    transport: "http-sdk",
    async capabilities() {
      return {
        streaming: true, tools: true, vision: false, embeddings: false,
        fileEdit: false, shellExec: false, git: false, approvalGate: false,
        mcp: false, reasoning: false, contextWindow: 32000,
      };
    },
    async chat(req) {
      return { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, finishReason: "stop" };
    },
    async *stream(req, ctx) {
      seen.push({
        system: req.system ?? null,
        messages: req.messages.map((m) => ({
          role: m.role,
          text: m.content.map((b) => (b.type === "text" ? b.text : `<${b.type}>`)).join(""),
        })),
        toolCount: req.tools?.length ?? 0,
      });
      const runId = ctx.runId ?? "r";
      yield { type: "run-start", runId, adapterId: "spy", model: req.model, ts: Date.now() };
      yield { type: "text-delta", runId, text: "ack" };
      yield {
        type: "run-end", runId, finishReason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
        usage: { inputTokens: 1, outputTokens: 1 }, ts: Date.now(),
      };
    },
    async listModels() { return [{ id: "spy-1", contextWindow: 32000, maxOutput: 4096, modalities: ["text"] }]; },
  };
}

const nexus = await createNexus({ cwd: process.cwd() });
await nexus.registerProvider(spyAdapter());

const s = await nexus.openSession();
for (const p of ["My name is Zebra.", "What is my name?", "And again?"]) {
  const r = s.ask(p, { provider: "spy", model: "spy-1" });
  await r.text();
  await r.result();
}

console.log("=== WHAT THE MODEL ACTUALLY RECEIVED, PER TURN ===");
seen.forEach((s, i) => {
  console.log(`turn ${i + 1}: system=${s.system} messages=${JSON.stringify(s.messages)}`);
});
await nexus.dispose();
