/**
 * PluginHost end-to-end tests — fully offline against in-repo fixture plugins.
 *
 * Exercises the four §9 guarantees: discovery (directory + npm naming
 * convention), versioning (incompatible plugin rejected before its code runs),
 * sandboxing (a plugin that throws is isolated and the host survives), and the
 * capability limit (an undeclared contribution is rejected). Then it applies the
 * good plugin's contributions into the SAME real registries the builtins use and
 * proves each contribution is usable through those registries.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ProviderRegistry } from "@nexuscode/core";
import { ToolRegistry, PermissionGate, type Tool } from "@nexuscode/tools";
import { PromptEngine } from "@nexuscode/prompt";
import type { McpServerConfig } from "@nexuscode/config";
import {
  PluginHost,
  satisfies,
  parsePluginManifest,
  type PluginCommand,
  type PluginUiPanel,
  type RegisterTargets,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dirPlugins = join(here, "fixtures", "dir-plugins");
const nodeModules = join(here, "fixtures", "npm-root");

function makeHost(): PluginHost {
  return new PluginHost({
    pluginDirs: [dirPlugins],
    nodeModulesDirs: [nodeModules],
    hostVersion: "1.0.0",
  });
}

describe("semver satisfies", () => {
  it("evaluates caret / comparator / wildcard ranges", () => {
    expect(satisfies("1.0.0", "^1.0.0")).toBe(true);
    expect(satisfies("1.9.3", "^1.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0", ">=99.0.0")).toBe(false);
    expect(satisfies("1.2.5", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfies("1.4.0", "1.x")).toBe(true);
    expect(satisfies("1.4.0", "*")).toBe(true);
    expect(satisfies("not-a-version", "^1.0.0")).toBe(false);
  });
});

describe("manifest validation", () => {
  it("rejects a manifest with a non-semver version", () => {
    const res = parsePluginManifest({ name: "x", version: "one-point-oh" });
    expect(res.ok).toBe(false);
  });
  it("accepts a minimal manifest and defaults the contributes/engines blocks", () => {
    const res = parsePluginManifest({ name: "x", version: "1.0.0" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.contributes.tools).toEqual([]);
      expect(res.manifest.engines).toEqual({});
    }
  });
});

describe("PluginHost.discover", () => {
  it("finds directory plugins and the npm-convention package with no errors", () => {
    const { plugins, errors } = makeHost().discover();
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(
      ["good-plugin", "incompatible-plugin", "nexuscode-plugin-npmish", "overreach-plugin", "throwing-plugin"].sort(),
    );
    expect(errors).toEqual([]);
    // The npm-discovered plugin's package.json became its manifest.
    const npmish = plugins.find((p) => p.manifest.name === "nexuscode-plugin-npmish");
    expect(npmish?.source).toBe("npm");
    expect(npmish?.manifest.contributes.prompts).toContain("npmish.summary");
  });
});

describe("PluginHost.loadAll (isolation + versioning + capability limits)", () => {
  it("loads the good plugins and isolates every bad one without crashing", async () => {
    const { loaded, failures } = await makeHost().loadAll();

    const loadedNames = loaded.map((l) => l.manifest.name).sort();
    expect(loadedNames).toEqual(["good-plugin", "nexuscode-plugin-npmish"]);

    const byName = new Map(failures.map((f) => [f.name, f]));

    // Versioning: rejected before its (throwing) module was ever imported.
    expect(byName.get("incompatible-plugin")?.reason).toBe("incompatible");
    expect(byName.get("incompatible-plugin")?.error).toContain(">=99.0.0");

    // Sandboxing: a module that throws on import is isolated with a clear error.
    expect(byName.get("throwing-plugin")?.reason).toBe("load-error");
    expect(byName.get("throwing-plugin")?.error).toContain("boom");

    // Capability limit: an undeclared contribution rejects the whole plugin.
    expect(byName.get("overreach-plugin")?.reason).toBe("capability-violation");
    expect(byName.get("overreach-plugin")?.error).toContain("secret_exfiltrate");
  });
});

describe("PluginHost.register (contributions land in the real registries)", () => {
  it("registers a plugin's provider, tool, prompt, command, mcp, and panel — all usable", async () => {
    const host = makeHost();
    const { loaded } = await host.loadAll();

    const providerRegistry = new ProviderRegistry();
    const toolRegistry = new ToolRegistry();
    const promptEngine = new PromptEngine();
    const mcpServers: McpServerConfig[] = [];
    const commands: PluginCommand[] = [];
    const uiPanels: PluginUiPanel[] = [];

    const targets: RegisterTargets = {
      providerRegistry,
      toolRegistry,
      promptEngine,
      mcpServers,
      commands,
      uiPanels,
    };

    const { applied, skipped } = await host.register(loaded, targets);
    expect(skipped).toEqual([]);
    expect(applied.length).toBeGreaterThanOrEqual(7);

    // Provider is registered, resolvable by alias, and usable via the adapter.
    expect(providerRegistry.has("fixture-llm")).toBe(true);
    const resolved = providerRegistry.resolveModel("fixture-fast");
    expect(resolved?.providerId).toBe("fixture-llm");
    const adapter = providerRegistry.get("fixture-llm");
    const chat = await adapter.chat(
      { model: "fixture-model", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never,
      {
        signal: new AbortController().signal,
        idempotencyKey: "k",
        traceId: "t",
        runId: "r",
      },
    );
    expect((chat.message.content[0] as { text: string }).text).toBe("fixture:hi");

    // Tool is registered and runs; and it flows through the SAME PermissionGate
    // the builtins use (a `read` tool is allowed even in the strict plan mode).
    expect(toolRegistry.has("fixture_echo")).toBe(true);
    const tool: Tool = toolRegistry.get("fixture_echo");
    const gate = new PermissionGate({ mode: "plan" });
    const decision = await gate.check(tool, { message: "yo" });
    expect(decision.allowed).toBe(true);
    const result = await Promise.resolve(
      tool.run({ message: "yo" }, { signal: new AbortController().signal, cwd: process.cwd() }),
    );
    expect((result as { content: { text: string }[] }).content[0].text).toBe("echo:yo");

    // Prompt template is registered and assembles.
    expect(promptEngine.hasTemplate("fixture.greeting", "1.0.0")).toBe(true);
    expect(promptEngine.assemble("fixture.greeting", { name: "World" })).toBe("Hello, World!");

    // Command sink received the CLI subcommand.
    expect(commands.map((c) => c.name)).toContain("fixture");

    // The npm plugin's declarative contributions also applied.
    expect(promptEngine.hasTemplate("npmish.summary", "1.0.0")).toBe(true);
    expect(mcpServers.map((s) => s.name)).toContain("npmish-mcp");
    expect(uiPanels.map((p) => p.id)).toContain("npmish.panel");
  });

  it("skips a contribution whose id is already taken instead of throwing", async () => {
    const host = makeHost();
    const { loaded } = await host.loadAll();
    const good = loaded.find((l) => l.manifest.name === "good-plugin")!;

    const providerRegistry = new ProviderRegistry();
    // Pre-occupy the provider id so the plugin's provider must be skipped.
    await providerRegistry.register(
      {
        id: "fixture-llm",
        label: "pre-existing",
        transport: "http-openai-compat",
        async capabilities() {
          return {
            models: [],
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
        async chat() {
          return { message: { role: "assistant", content: [] }, finishReason: "stop" };
        },
        // eslint-disable-next-line require-yield
        async *stream() {
          return;
        },
      } as never,
      { skipHealth: true },
    );

    const { applied, skipped } = await host.register([good], { providerRegistry });
    expect(applied.find((a) => a.kind === "provider")).toBeUndefined();
    const providerSkip = skipped.find((s) => s.kind === "provider" && s.id === "fixture-llm");
    expect(providerSkip?.reason).toContain("already registered");
  });
});
