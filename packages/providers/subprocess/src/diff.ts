/**
 * Tiny unified-diff builders shared by CLI mappers. These are *normalized*
 * diffs for the `file-edit` chunk — enough for the TUI/reviewer to render and
 * for the audit log — not a git-exact patch. A CLI that reports its own diff
 * should pass it through verbatim instead.
 */

function lines(s: string): string[] {
  // Trailing newline shouldn't produce a spurious empty final line.
  const body = s.endsWith("\n") ? s.slice(0, -1) : s;
  return body.length === 0 ? [] : body.split("\n");
}

/** A whole-file creation diff (all additions). */
export function writeDiff(path: string, content: string): string {
  const added = lines(content).map((l) => `+${l}`);
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${added.length} @@\n${added.join("\n")}\n`;
}

/** A single old→new replacement diff. */
export function replaceDiff(path: string, oldStr: string, newStr: string): string {
  const removed = lines(oldStr).map((l) => `-${l}`);
  const added = lines(newStr).map((l) => `+${l}`);
  return `--- a/${path}\n+++ b/${path}\n@@ -1,${removed.length} +1,${added.length} @@\n${[...removed, ...added].join("\n")}\n`;
}
