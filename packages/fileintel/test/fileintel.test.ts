import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildIndex,
  detectDetailed,
  detectLanguage,
  heuristicParser,
  pageRank,
  rankSymbols,
  repoMap,
  walkProject,
} from "@nexuscode/fileintel";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "repo");

describe("language detection", () => {
  it("detects by extension", () => {
    expect(detectLanguage("src/a.ts")).toBe("typescript");
    expect(detectLanguage("ui/App.tsx")).toBe("tsx");
    expect(detectLanguage("lib/thing.js")).toBe("javascript");
    expect(detectLanguage("svc/service.py")).toBe("python");
    expect(detectLanguage("cmd/main.go")).toBe("go");
    expect(detectLanguage("data.json")).toBe("json");
    expect(detectLanguage("README.md")).toBe("markdown");
  });

  it("detects by shebang when the extension is absent", () => {
    const d = detectDetailed("scripts/run", "#!/usr/bin/env python3\nprint('hi')\n");
    expect(d.lang).toBe("python");
    expect(d.method).toBe("shebang");
    expect(detectLanguage("scripts/deploy", "#!/bin/bash\necho hi\n")).toBe("shell");
    expect(detectLanguage("scripts/tool", "#!/usr/bin/env node\nconsole.log(1)\n")).toBe("javascript");
  });

  it("falls back to content heuristics", () => {
    const py = detectDetailed("mystery", "def add(a, b):\n    return a + b\n");
    expect(py.lang).toBe("python");
    expect(py.method).toBe("content");
    const json = detectDetailed("payload", '{"a":1,"b":[2,3]}');
    expect(json.lang).toBe("json");
  });

  it("returns unknown for unrecognised files with no content", () => {
    expect(detectLanguage("weird.qzx")).toBe("unknown");
  });
});

describe("ignore-aware walker + large-file guard", () => {
  it("honours .gitignore / .nexusignore / .aiignore", async () => {
    const entries = await walkProject(FIXTURE);
    const paths = entries.map((e) => e.path);
    // Present source files.
    expect(paths).toContain("src/util.ts");
    expect(paths).toContain("py/service.py");
    // Ignored by the three ignore files.
    expect(paths).not.toContain("ignored/secret.ts"); // .gitignore -> ignored/
    expect(paths).not.toContain("build/generated.ts"); // .nexusignore -> build/
    expect(paths.some((p) => p.endsWith(".aiskip.ts"))).toBe(false); // .aiignore -> *.aiskip.ts
  });

  it("respects extraIgnore globs", async () => {
    const entries = await walkProject(FIXTURE, { extraIgnore: ["py/**"] });
    expect(entries.some((e) => e.path.startsWith("py/"))).toBe(false);
    expect(entries.some((e) => e.path.startsWith("src/"))).toBe(true);
  });

  it("skips files larger than the byte guard", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fileintel-"));
    try {
      await fs.writeFile(path.join(tmp, "small.ts"), "export const x = 1;\n");
      await fs.writeFile(path.join(tmp, "big.ts"), "// pad\n" + "a".repeat(4000));
      const entries = await walkProject(tmp, { maxFileBytes: 500 });
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("small.ts");
      expect(paths).not.toContain("big.ts");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("stops at an aggregate byte budget (maxTotalBytes) and logs an honest truncation notice", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fileintel-budget-bytes-"));
    try {
      // 5 files of exactly 200 bytes each; a 450-byte budget lets in only 2.
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(tmp, `f${i}.ts`), "a".repeat(200));
      }
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const entries = await walkProject(tmp, { maxTotalBytes: 450 });
        expect(entries.length).toBe(2); // truncated well short of the 5 available files
        expect(spy).toHaveBeenCalled();
        const logged = spy.mock.calls.map((c) => String(c[0])).join("");
        expect(logged).toContain("reached limit");
        expect(logged).toContain("indexed a subset");
        expect(logged).toContain("maxTotalBytes");
      } finally {
        spy.mockRestore();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("stops at an aggregate file-count budget (maxFiles) and logs a truncation notice", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fileintel-budget-files-"));
    try {
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(tmp, `f${i}.ts`), "hello world\n");
      }
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        // Disable the byte budget so only the file-count cap is exercised.
        const entries = await walkProject(tmp, { maxFiles: 2, maxTotalBytes: 0 });
        expect(entries.length).toBe(2);
        expect(spy).toHaveBeenCalled();
        const logged = spy.mock.calls.map((c) => String(c[0])).join("");
        expect(logged).toContain("reached limit (2 of 2 files");
      } finally {
        spy.mockRestore();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does NOT log a truncation notice when nothing was actually truncated", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fileintel-no-budget-"));
    try {
      await fs.writeFile(path.join(tmp, "one.ts"), "export const x = 1;\n");
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const entries = await walkProject(tmp, { maxFiles: 50, maxTotalBytes: 1_000_000 });
        expect(entries.length).toBe(1);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("excludes secret files by default even with NO ignore files present", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fileintel-secret-"));
    try {
      await fs.writeFile(path.join(tmp, "app.ts"), "export const x = 1;\n");
      // No .gitignore/.nexusignore/.aiignore at all — the built-in denylist must
      // still keep these out of the walk.
      await fs.writeFile(path.join(tmp, ".env"), "OPENAI_API_KEY=sk-secret\n");
      await fs.writeFile(path.join(tmp, ".env.production"), "DB_PASSWORD=hunter2\n");
      await fs.writeFile(path.join(tmp, "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
      await fs.writeFile(path.join(tmp, "tls.key"), "keydata\n");
      await fs.writeFile(path.join(tmp, "id_rsa"), "ssh-key\n");
      await fs.writeFile(path.join(tmp, ".npmrc"), "//registry/:_authToken=abc\n");
      await fs.writeFile(path.join(tmp, "credentials.json"), '{"token":"x"}\n');
      await fs.mkdir(path.join(tmp, ".aws"), { recursive: true });
      await fs.writeFile(path.join(tmp, ".aws", "credentials"), "[default]\n");

      const entries = await walkProject(tmp);
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("app.ts");
      for (const secret of [
        ".env",
        ".env.production",
        "server.pem",
        "tls.key",
        "id_rsa",
        ".npmrc",
        "credentials.json",
        ".aws/credentials",
      ]) {
        expect(paths).not.toContain(secret);
      }

      // The opt-out lets trusted tooling see them again.
      const withSecrets = await walkProject(tmp, { includeSecretFiles: true });
      expect(withSecrets.map((e) => e.path)).toContain(".env");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("heuristic parser — TypeScript", () => {
  const code = `import { helper } from "./util";
import fs from "node:fs";
const { join } = require("node:path");

export function alpha(a: number): number {
  return a;
}

export const beta = (b: string): string => b;

export class Service {
  private count = 0;
  run(): number {
    return this.count;
  }
  async stop(): Promise<void> {}
}

export interface Options {
  verbose: boolean;
}

export type Id = string;
`;

  it("extracts top-level symbols", () => {
    const syms = heuristicParser.symbols(code, "typescript");
    const byName = new Map(syms.map((s) => [s.name, s]));
    expect(byName.get("alpha")?.kind).toBe("function");
    expect(byName.get("alpha")?.exported).toBe(true);
    expect(byName.get("beta")?.kind).toBe("function"); // arrow const
    expect(byName.get("Service")?.kind).toBe("class");
    expect(byName.get("Options")?.kind).toBe("interface");
    expect(byName.get("Id")?.kind).toBe("type");
  });

  it("extracts class methods with their container", () => {
    const syms = heuristicParser.symbols(code, "typescript");
    const run = syms.find((s) => s.name === "run" && s.kind === "method");
    expect(run?.container).toBe("Service");
    expect(syms.some((s) => s.name === "stop" && s.kind === "method")).toBe(true);
  });

  it("extracts imports (esm, default, require)", () => {
    const imports = heuristicParser.imports(code, "typescript");
    expect(imports).toContain("./util");
    expect(imports).toContain("node:fs");
    expect(imports).toContain("node:path");
  });
});

describe("heuristic parser — Python", () => {
  const code = `import os
from .models import Account

DEFAULT_LIMIT = 100

def load_account(id):
    return Account(id)

class Service:
    def __init__(self, limit=DEFAULT_LIMIT):
        self.limit = limit

    def run(self):
        return load_account(1)
`;

  it("extracts functions, classes, methods and constants", () => {
    const syms = heuristicParser.symbols(code, "python");
    const byName = new Map(syms.map((s) => [`${s.kind}:${s.name}`, s]));
    expect(byName.has("function:load_account")).toBe(true);
    expect(byName.has("class:Service")).toBe(true);
    expect(byName.has("const:DEFAULT_LIMIT")).toBe(true);
    const run = syms.find((s) => s.name === "run" && s.kind === "method");
    expect(run?.container).toBe("Service");
  });

  it("extracts imports (import + from-import)", () => {
    const imports = heuristicParser.imports(code, "python");
    expect(imports).toContain("os");
    expect(imports).toContain(".models");
  });
});

describe("repo index — symbols, dependency graph, cross-references", () => {
  it("builds a symbol index across files", async () => {
    const index = await buildIndex(FIXTURE);
    expect(index.symbols.has("helper")).toBe(true);
    expect(index.symbols.has("Widget")).toBe(true);
    const helperDefs = index.symbols.get("helper") ?? [];
    expect(helperDefs[0]?.file).toBe("src/util.ts");
  });

  it("records dependency edges from resolved imports", async () => {
    const index = await buildIndex(FIXTURE);
    expect([...(index.dependencies.get("src/a.ts") ?? [])]).toContain("src/util.ts");
    expect([...(index.dependencies.get("src/b.ts") ?? [])]).toContain("src/util.ts");
    expect([...(index.dependencies.get("src/c.ts") ?? [])]).toContain("src/util.ts");
    // Reverse edges.
    expect([...(index.dependents.get("src/util.ts") ?? [])].sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    // Python relative import edge.
    expect([...(index.dependencies.get("py/service.py") ?? [])]).toContain("py/models.py");
  });

  it("records cross-references (symbol -> referencing files)", async () => {
    const index = await buildIndex(FIXTURE);
    const helperRefs = [...(index.xrefs.get("helper") ?? [])].sort();
    expect(helperRefs).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });
});

describe("pageRank", () => {
  it("ranks a widely-pointed-to node highest", () => {
    const nodes = ["a", "b", "c", "hub"];
    const edges = new Map([
      ["a", new Map([["hub", 1]])],
      ["b", new Map([["hub", 1]])],
      ["c", new Map([["hub", 1]])],
    ]);
    const ranks = pageRank(nodes, edges);
    const top = [...ranks.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    expect(top).toBe("hub");
  });
});

describe("repo map (aider-style)", () => {
  it("ranks the most-referenced symbol highest", async () => {
    const index = await buildIndex(FIXTURE);
    const ranked = rankSymbols(index);
    expect(ranked[0]?.name).toBe("helper");
  });

  it("renders signatures and respects the token budget", async () => {
    const big = await repoMap(FIXTURE, { budgetTokens: 2000 });
    expect(big.text.length).toBeGreaterThan(0);
    expect(big.tokens).toBeLessThanOrEqual(2000);
    expect(big.text).toContain("helper");
    // The map is signatures-only: no function bodies leak in.
    expect(big.text).not.toContain("return x + 1");

    const tight = await repoMap(FIXTURE, { budgetTokens: 8 });
    expect(tight.tokens).toBeLessThanOrEqual(8);
    expect(tight.truncated).toBe(true);
    // A tight budget yields strictly less than the generous one.
    expect(tight.ranked.length).toBe(big.ranked.length);
    expect(tight.files.reduce((n, f) => n + f.symbols.length, 0)).toBeLessThan(
      big.files.reduce((n, f) => n + f.symbols.length, 0),
    );
  });
});
