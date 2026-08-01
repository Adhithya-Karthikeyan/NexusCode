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
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function hasTestFiles(testDir: string): boolean {
  if (!existsSync(testDir) || !statSync(testDir).isDirectory()) return false;
  return readdirSync(testDir).some((f) => /\.test\.tsx?$/.test(f));
}

/** Every `packages/*` or `packages/providers/*` leaf dir that has a package.json + test files. */
function testedLeafPackages(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, "packages");
  const leafs: string[] = [];
  for (const name of readdirSync(packagesDir)) {
    const dir = join(packagesDir, name);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, "package.json")) && hasTestFiles(join(dir, "test"))) {
      leafs.push(`packages/${name}`);
      continue;
    }
    // `packages/providers` itself is an aggregator with no package.json — descend one more level.
    if (name === "providers") {
      for (const providerName of readdirSync(dir)) {
        const providerDir = join(dir, providerName);
        if (!statSync(providerDir).isDirectory()) continue;
        if (existsSync(join(providerDir, "package.json")) && hasTestFiles(join(providerDir, "test"))) {
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
});
