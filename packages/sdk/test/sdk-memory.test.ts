/**
 * SDK conversation-memory tests. The facade's docstring promises that turns on a
 * session thread their history; these prove it on the wire by recording every
 * outgoing `ChatRequest` with a spy adapter, exactly the way the defect was
 * originally caught.
 */

import { describe, it, expect } from "vitest";
import { createMockAdapter } from "@nexuscode/provider-mock";
import type { ProviderAdapter } from "@nexuscode/core";
import type { ChatRequest, Message } from "@nexuscode/shared";
import { createNexus, type Nexus } from "../src/index.js";

function spyAdapter(): { adapter: ProviderAdapter; requests: ChatRequest[] } {
  const base = createMockAdapter({ id: "spy" });
  const requests: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    ...base,
    chat(req, ctx) {
      requests.push(structuredClone(req));
      return base.chat(req, ctx);
    },
    stream(req, ctx) {
      requests.push(structuredClone(req));
      return base.stream(req, ctx);
    },
  };
  return { adapter, requests };
}

async function makeSpyNexus(
  history?: { enabled?: boolean; maxTokens?: number },
): Promise<{ nexus: Nexus; requests: ChatRequest[] }> {
  const { adapter, requests } = spyAdapter();
  const nexus = await createNexus({
    config: { defaultProvider: "spy", defaultModel: "mock-fast" },
    providers: [adapter],
    ...(history ? { history } : {}),
  });
  return { nexus, requests };
}

function textOf(m: Message): string {
  return m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function transcriptText(req: ChatRequest): string {
  return req.messages.map(textOf).join("\n");
}

describe("Nexus — conversation memory across turns", () => {
  it("threads prior turns into every later `ask` on the same session", async () => {
    const { nexus, requests } = await makeSpyNexus();
    try {
      await nexus.ask("My name is Zebra.").text();
      await nexus.ask("What is my name?").text();
      await nexus.ask("And again?").text();

      expect(requests).toHaveLength(3);
      expect(requests[0]!.messages.map((m) => m.role)).toEqual(["user"]);
      expect(requests[2]!.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
      expect(transcriptText(requests[2]!)).toContain("My name is Zebra.");
      // Exactly once — never double-threaded.
      expect(
        requests[2]!.messages.filter((m) => m.role === "user" && textOf(m) === "My name is Zebra."),
      ).toHaveLength(1);
    } finally {
      await nexus.dispose();
    }
  });

  it("keeps separate sessions isolated from each other", async () => {
    const { nexus, requests } = await makeSpyNexus();
    try {
      const a = await nexus.openSession();
      const b = await nexus.openSession();
      await a.ask("My name is Zebra.").text();
      await b.ask("What is my name?").text();

      expect(requests[1]!.messages).toHaveLength(1);
      expect(transcriptText(requests[1]!)).not.toContain("Zebra");
    } finally {
      await nexus.dispose();
    }
  });

  it("honours `history: { enabled: false }` for stateless one-shot use", async () => {
    const { nexus, requests } = await makeSpyNexus({ enabled: false });
    try {
      await nexus.ask("My name is Zebra.").text();
      await nexus.ask("What is my name?").text();
      expect(requests[1]!.messages).toHaveLength(1);
    } finally {
      await nexus.dispose();
    }
  });

  it("bounds the threaded history so a long conversation cannot blow the window", async () => {
    const { nexus, requests } = await makeSpyNexus({ maxTokens: 300 });
    try {
      const filler = "x".repeat(400);
      await nexus.ask(`FIRST ${filler}`).text();
      for (let i = 0; i < 10; i++) await nexus.ask(`turn ${i} ${filler}`).text();

      const last = requests[requests.length - 1]!;
      expect(transcriptText(last)).not.toContain("FIRST");
      expect(transcriptText(last)).toContain("turn 9");
      expect(last.messages.length).toBeLessThan(10);
      expect(nexus.session.raw.transcript.length).toBeLessThan(10);
    } finally {
      await nexus.dispose();
    }
  });
});
