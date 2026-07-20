// Replicate EngineContextAssembler.assemble() EXACTLY (cli/src/commands.ts:840-864)
// and show what it hands the provider.
import { openMemory } from "@nexuscode/memory";
import { ContextEngine, MemorySource } from "@nexuscode/context";

const engine = new ContextEngine();
const sources = [new MemorySource({ store: openMemory() })];

const inputMessages = [{ role: "user", content: [{ type: "text", text: "What is the secret deploy incantation?" }] }];
const inputSystem = "SYSTEM PROMPT HERE";

const res = await engine.assemble({
  budgetTokens: 4000, sources,
  userMessage: "What is the secret deploy incantation?",
  signal: new AbortController().signal,
});

console.log("1. ContextEngine RETRIEVED and produced res.messages:");
console.log("   length =", res.messages.length);
console.log("   ", JSON.stringify(res.messages).slice(0, 260));

// ---- the exact lines from commands.ts:860-861 ----
const preamble = res.messages.slice(0, -1);
const out = { messages: [...preamble, ...inputMessages] };
// --------------------------------------------------

console.log("\n2. preamble = res.messages.slice(0, -1)  -> length =", preamble.length);
console.log("\n3. WHAT THE PROVIDER ACTUALLY RECEIVES:");
console.log("   ", JSON.stringify(out.messages));

const delivered = JSON.stringify(out.messages).includes("xyzzy-plugh-42");
console.log("\n=> memory reached the model?", delivered ? "YES" : "NO — SILENTLY DROPPED");
