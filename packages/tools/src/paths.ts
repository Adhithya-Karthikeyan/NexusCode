/**
 * Workspace path confinement. Every filesystem tool resolves its argument
 * against the workspace root and refuses any path that escapes it. This is the
 * single choke point that keeps `../../etc/passwd` and absolute paths out of the
 * read/write/patch/search surface.
 */

import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { NexusError } from "@nexuscode/shared";

/** True when `rel` (a relative path produced by `path.relative`) escapes upward. */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

/**
 * Resolve `target`'s real path even when the leaf (or several trailing
 * segments) does not exist yet — as is normal for `fs_write`/`fs_patch`
 * creating a new file. We `realpath` the deepest ancestor that *does* exist
 * (following any symlinks in it) and re-append the missing tail. This means a
 * symlinked *parent* directory pointing outside the workspace is still caught,
 * because its resolved real path is what we test for containment.
 */
async function realpathAllowingMissing(target: string): Promise<string> {
  let current = target;
  const trailing: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return trailing.length ? path.join(real, ...trailing.slice().reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return target; // reached the filesystem root, nothing resolved
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `p` (relative or absolute) against `root` and assert it stays inside
 * `root`. Returns the absolute path. Throws `NexusError("invalid_argument")`
 * when the resolved path would escape the workspace.
 *
 * Confinement is enforced twice: first lexically (`path.resolve`/`relative`),
 * then physically — both the workspace root and the target are passed through
 * `fs.realpath` and re-checked, so a symlink *inside* the workspace pointing
 * outside it (planted by a malicious repo or a prior `shell_exec` `ln -s`) can
 * no longer be followed to read, overwrite, or delete host files such as
 * `~/.ssh/id_rsa`.
 */
export async function resolveInWorkspace(root: string, p: string): Promise<string> {
  const abs = path.resolve(root, p);

  // 1. Lexical check — cheap, and rejects the obvious `../../etc/passwd` cases.
  if (escapes(path.relative(root, abs))) {
    throw new NexusError("invalid_argument", `path escapes workspace root: ${p}`);
  }

  // 2. Physical (symlink-aware) check — realpath both ends and re-assert
  //    containment against the workspace's own real path.
  const realRoot = await fs.realpath(root);
  const real = await realpathAllowingMissing(abs);
  if (escapes(path.relative(realRoot, real))) {
    throw new NexusError("invalid_argument", `path escapes workspace root: ${p}`);
  }

  return abs;
}

/**
 * Synchronous sibling of {@link realpathAllowingMissing}, using `realpathSync`.
 * Needed by call sites that must confine a path before a synchronous side
 * effect (e.g. `child_process.spawn`) and cannot `await` a check first.
 */
function realpathAllowingMissingSync(target: string): string {
  let current = target;
  const trailing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length ? path.join(real, ...trailing.slice().reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return target; // reached the filesystem root, nothing resolved
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Synchronous sibling of {@link resolveInWorkspace} — same lexical + symlink-aware
 * physical containment check, but blocking (`realpathSync`). Used by the terminal
 * subsystem (`ProcessManager`, `Pty`), whose `spawn()` returns a live handle
 * synchronously and so cannot await the async check before launching a child
 * process. Throws `NexusError("invalid_argument")` when `p` would escape `root`.
 */
export function resolveInWorkspaceSync(root: string, p: string): string {
  const abs = path.resolve(root, p);

  if (escapes(path.relative(root, abs))) {
    throw new NexusError("invalid_argument", `path escapes workspace root: ${p}`);
  }

  const realRoot = realpathSync(root);
  const real = realpathAllowingMissingSync(abs);
  if (escapes(path.relative(realRoot, real))) {
    throw new NexusError("invalid_argument", `path escapes workspace root: ${p}`);
  }

  return abs;
}

/** Strip a leading `a/` or `b/` (git diff header prefix) from a diff path. */
export function stripDiffPrefix(p: string): string {
  if (p === "/dev/null") return p;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}
