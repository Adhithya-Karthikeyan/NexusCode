/**
 * HTML rendering primitives shared by the exporter and the Code Receipt. Two
 * hard rules live here: (1) every value that originates from session content
 * (prompt, diff, model name, tool output …) is HTML-escaped so a `<script>` in a
 * prompt or a filename can never execute in the rendered page, and (2) the pages
 * are fully self-contained — inline CSS only, no external stylesheet, font, or
 * script reference — so a receipt/export is a single portable local file.
 */

/** Escape the five HTML-significant characters. Applied to every dynamic value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap page `body` in a minimal, self-contained HTML document with inline CSS. */
export function htmlDocument(opts: { title: string; style: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, noarchive">
<title>${escapeHtml(opts.title)}</title>
<style>
${opts.style}
</style>
</head>
<body>
${opts.body}
</body>
</html>
`;
}

/**
 * Render a unified-diff patch into color-coded HTML lines. The patch text is
 * escaped first, so hostile diff content is inert; classification is done on the
 * already-escaped line's leading character.
 */
export function renderDiff(patch: string): string {
  const lines = patch.split("\n");
  const rendered = lines
    .map((line) => {
      const escaped = escapeHtml(line);
      let cls = "ln";
      if (line.startsWith("+") && !line.startsWith("+++")) cls = "ln add";
      else if (line.startsWith("-") && !line.startsWith("---")) cls = "ln del";
      else if (line.startsWith("@@")) cls = "ln hunk";
      else if (line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---")) cls = "ln meta";
      return `<span class="${cls}">${escaped || "&nbsp;"}</span>`;
    })
    .join("\n");
  return `<pre class="diff">${rendered}</pre>`;
}
