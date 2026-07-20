import { openMemory } from "@nexuscode/memory";
import { ContextEngine, MemorySource } from "@nexuscode/context";

const store = openMemory();
console.log("ALL MEMORIES:", store.list().map((m) => `${m.tier}/${m.kind}: ${m.text.slice(0, 60)}`));

for (const q of [
  "What is the secret deploy incantation? Answer from memory only, do not use any tools.",
  "What is the secret deploy incantation?",
  "secret deploy incantation",
  "deploy",
  "how do I deploy this project?",
]) {
  const hits = store.recall(q, 500);
  console.log(`\nrecall(${JSON.stringify(q.slice(0, 45))}) -> ${hits.length} hit(s)`);
  for (const h of hits) console.log("   ", h.text.slice(0, 70));
}

// And through the real source the CLI wires:
const src = new MemorySource({ store });
const eng = new ContextEngine();
const res = await eng.assemble({
  budgetTokens: 4000, sources: [src],
  userMessage: "What is the secret deploy incantation? Answer from memory only, do not use any tools.",
  signal: new AbortController().signal,
});
console.log("\nASSEMBLED MESSAGES:", JSON.stringify(res.messages).slice(0, 400));
