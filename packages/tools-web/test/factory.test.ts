import { describe, it, expect } from "vitest";
import { webTools, mockSearchProvider } from "../src/index.js";

describe("webTools factory", () => {
  it("returns the group in a stable order with network permission", () => {
    const tools = webTools({ searchProvider: mockSearchProvider });
    expect(tools.map((t) => t.name)).toEqual(["web_search", "web_fetch", "web_crawl"]);
    for (const t of tools) {
      expect(t.permission).toBe("network");
      expect(typeof t.run).toBe("function");
      expect(t.parameters).toMatchObject({ type: "object" });
    }
  });

  it("returns fresh arrays each call", () => {
    const a = webTools({ searchProvider: mockSearchProvider });
    const b = webTools({ searchProvider: mockSearchProvider });
    expect(a).not.toBe(b);
  });

  it("falls back to the mock provider when no key is in the environment", () => {
    const tools = webTools();
    expect(tools.map((t) => t.name)).toContain("web_search");
  });
});
