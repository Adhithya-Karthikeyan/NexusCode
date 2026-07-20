import { describe, it, expect } from "vitest";
import { parseMcpServerConfig, McpServerConfig, resolveTransport, type SecretResolver } from "../src/index.js";

describe("McpServerConfig schema", () => {
  it("accepts a stdio server and defaults args/env/enabled", () => {
    const cfg = parseMcpServerConfig({ name: "fs", transport: "stdio", command: "node" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.args).toEqual([]);
    expect(cfg.env).toEqual({});
  });

  it("rejects a stdio server missing a command", () => {
    expect(() => parseMcpServerConfig({ name: "x", transport: "stdio" })).toThrow(/command/);
  });

  it("accepts sse/http servers with a url and rejects a missing url", () => {
    const sse = parseMcpServerConfig({ name: "s", transport: "sse", url: "https://x.example/sse" });
    expect(sse.url).toBe("https://x.example/sse");
    expect(() => parseMcpServerConfig({ name: "s", transport: "http" })).toThrow(/url/);
  });

  it("parses auth refs", () => {
    const cfg = parseMcpServerConfig({
      name: "gh",
      transport: "http",
      url: "https://api.example/mcp",
      auth: { bearerRef: "gh-token", headerRefs: { "X-Api-Key": "gh-key" } },
    });
    expect(cfg.auth?.bearerRef).toBe("gh-token");
    expect(cfg.auth?.headerRefs["X-Api-Key"]).toBe("gh-key");
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => McpServerConfig.parse({ name: "x", transport: "stdio", command: "node", bogus: 1 })).toThrow();
  });
});

describe("resolveTransport auth resolution", () => {
  const secrets: SecretResolver = {
    async get(ref) {
      return ref === "gh-token" ? "SECRET123" : ref === "gh-key" ? "KEYVAL" : null;
    },
  };

  it("builds a stdio transport without secrets", async () => {
    const cfg = parseMcpServerConfig({ name: "fs", transport: "stdio", command: "node", args: ["-v"] });
    const transport = await resolveTransport(cfg);
    expect(transport).toBeTruthy();
    // Best-effort close so we do not leak the spawned process handle.
    await (transport as { close?: () => Promise<void> }).close?.();
  });

  it("throws a secret_not_found when a bearer ref is unresolved", async () => {
    const cfg = parseMcpServerConfig({
      name: "gh",
      transport: "http",
      url: "https://api.example/mcp",
      auth: { bearerRef: "missing" },
    });
    await expect(resolveTransport(cfg, secrets)).rejects.toThrow(/not found/);
  });

  it("resolves a bearer + header ref into a transport", async () => {
    const cfg = parseMcpServerConfig({
      name: "gh",
      transport: "http",
      url: "https://api.example/mcp",
      auth: { bearerRef: "gh-token", headerRefs: { "X-Api-Key": "gh-key" } },
    });
    const transport = await resolveTransport(cfg, secrets);
    expect(transport).toBeTruthy();
    await (transport as { close?: () => Promise<void> }).close?.();
  });
});
