/**
 * Meta-test: every leaf package that actually has tests must be registered as a
 * vitest workspace project. This is the guardrail for the class of bug where a
 * new package (e.g. `packages/memory`) ships tests but is silently never run in
 * CI because nobody added it to `vitest.workspace.ts`.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "vitest.workspace.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate repo root (vitest.workspace.ts) walking up from ${startDir}`);
    }
    dir = parent;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(HERE);

/** Extracts the quoted string entries out of the `defineWorkspace([...])` array. */
function readWorkspaceEntries(repoRoot: string): string[] {
  const src = readFileSync(join(repoRoot, "vitest.workspace.ts"), "utf8");
  const match = src.match(/defineWorkspace\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!match) throw new Error("vitest.workspace.ts does not contain a defineWorkspace([...]) array");
  const body = match[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/** Recursively searches `dir` for any `*.test.ts`/`*.test.tsx` file. */
function containsTestFile(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (containsTestFile(full)) return true;
    } else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}

/** A package "has tests" if `test/` (recursively) or `src/` (co-located) contains a test file. */
function hasTestFiles(packageDir: string): boolean {
  return containsTestFile(join(packageDir, "test")) || containsTestFile(join(packageDir, "src"));
}

/** Every `packages/*` or `packages/providers/*` leaf dir that has a package.json + test files. */
function testedLeafPackages(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, "packages");
  const leafs: string[] = [];
  for (const name of readdirSync(packagesDir)) {
    const dir = join(packagesDir, name);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, "package.json")) && hasTestFiles(dir)) {
      leafs.push(`packages/${name}`);
      continue;
    }
    // `packages/providers` itself is an aggregator with no package.json — descend one more level.
    if (name === "providers") {
      for (const providerName of readdirSync(dir)) {
        const providerDir = join(dir, providerName);
        if (!statSync(providerDir).isDirectory()) continue;
        if (existsSync(join(providerDir, "package.json")) && hasTestFiles(providerDir)) {
          leafs.push(`packages/providers/${providerName}`);
        }
      }
    }
  }
  return leafs.sort();
}

function isCovered(pkg: string, entries: string[]): boolean {
  if (entries.includes(pkg)) return true;
  if (pkg.startsWith("packages/providers/") && entries.includes("packages/providers/*")) return true;
  return false;
}

describe("vitest workspace registration", () => {
  it("registers every packages/* and packages/providers/* leaf that has tests", () => {
    const entries = readWorkspaceEntries(REPO_ROOT);
    const leafs = testedLeafPackages(REPO_ROOT);

    expect(leafs.length).toBeGreaterThan(0);

    const uncovered = leafs.filter((pkg) => !isCovered(pkg, entries));
    expect(uncovered, `packages with tests but missing from vitest.workspace.ts: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("every non-glob entry resolves to an existing package directory", () => {
    const entries = readWorkspaceEntries(REPO_ROOT);
    const broken = entries
      .filter((entry) => !entry.includes("*"))
      .filter((entry) => {
        const dir = join(REPO_ROOT, entry);
        return !(existsSync(dir) && statSync(dir).isDirectory() && existsSync(join(dir, "package.json")));
      });
    expect(broken, `workspace entries that don't resolve to a real package: ${broken.join(", ")}`).toEqual([]);
  });
});
