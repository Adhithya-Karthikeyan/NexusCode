import { describe, it, expect, vi } from "vitest";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { lazy, lazyAsync, LazySubsystems } from "../src/lazy.js";
import { buildRuntime } from "../src/index.js";

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

/**
 * Lazy loading (system-spec §23): heavy subsystems must NOT be constructed until
 * first use, so startup and one-shot `ask` stay fast. These assert nothing is
 * built until accessed, then memoized thereafter.
 */
describe("runtime lazy loading", () => {
  it("does not construct a lazy value until first get()", () => {
    const factory = vi.fn(() => ({ heavy: true }));
    const cell = lazy(factory);

    expect(factory).not.toHaveBeenCalled();
    expect(cell.loaded).toBe(false);
    expect(cell.peek()).toBeUndefined();

    const value = cell.get();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(cell.loaded).toBe(true);
    expect(value).toEqual({ heavy: true });

    // Second access is memoized (no re-construction) and identity-stable.
    expect(cell.get()).toBe(value);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reset() forces a rebuild on the next access", () => {
    const factory = vi.fn(() => ({}));
    const cell = lazy(factory);
    const first = cell.get();
    cell.reset();
    expect(cell.loaded).toBe(false);
    const second = cell.get();
    expect(second).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("lazyAsync memoizes and shares the in-flight promise", async () => {
    const factory = vi.fn(async () => 42);
    const cell = lazyAsync(factory);
    expect(cell.loaded).toBe(false);
    const [a, b] = await Promise.all([cell.get(), cell.get()]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(cell.loaded).toBe(true);
  });

  it("LazySubsystems builds a registered subsystem only on first get()", () => {
    const ragFactory = vi.fn(() => ({ kind: "rag-index" }));
    const lspFactory = vi.fn(() => ({ kind: "lsp" }));

    const subsystems = new LazySubsystems()
      .register("rag", ragFactory)
      .register("lsp", lspFactory);

    // Registration alone constructs NOTHING — the whole point of lazy bootstrap.
    expect(ragFactory).not.toHaveBeenCalled();
    expect(lspFactory).not.toHaveBeenCalled();
    expect(subsystems.isLoaded("rag")).toBe(false);
    expect(subsystems.names().sort()).toEqual(["lsp", "rag"]);

    const rag = subsystems.get<{ kind: string }>("rag");
    expect(rag.kind).toBe("rag-index");
    expect(ragFactory).toHaveBeenCalledTimes(1);
    // Accessing "rag" never touched the unrelated "lsp" subsystem.
    expect(lspFactory).not.toHaveBeenCalled();
    expect(subsystems.isLoaded("rag")).toBe(true);
    expect(subsystems.isLoaded("lsp")).toBe(false);
    expect(subsystems.loadedNames()).toEqual(["rag"]);

    // Memoized on subsequent access.
    expect(subsystems.get("rag")).toBe(rag);
    expect(ragFactory).toHaveBeenCalledTimes(1);
  });

  it("LazySubsystems.get throws on an unknown name", () => {
    const subsystems = new LazySubsystems();
    expect(() => subsystems.get("nope")).toThrow(/not registered/);
  });

  it("buildRuntime registers subsystems lazily — bootstrap builds none of them", async () => {
    const ragFactory = vi.fn(() => ({ kind: "rag-index" }));
    const serverFactory = vi.fn(() => ({ kind: "server" }));

    const config = NexusConfig.parse({});
    const rt = await buildRuntime(config, {
      secrets: stubSecrets,
      subsystems: { rag: ragFactory, server: serverFactory },
    });

    // Assembling the runtime must NOT spin up the heavy subsystems (§23).
    expect(ragFactory).not.toHaveBeenCalled();
    expect(serverFactory).not.toHaveBeenCalled();
    expect(rt.subsystems.has("rag")).toBe(true);
    expect(rt.subsystems.isLoaded("rag")).toBe(false);

    // First access constructs exactly the one accessed subsystem.
    const rag = rt.subsystems.get<{ kind: string }>("rag");
    expect(rag.kind).toBe("rag-index");
    expect(ragFactory).toHaveBeenCalledTimes(1);
    expect(serverFactory).not.toHaveBeenCalled();
  });
});
