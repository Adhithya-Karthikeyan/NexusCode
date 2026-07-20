/**
 * Dependency-free HTML → text extraction and link harvesting.
 *
 * A production deployment can drop in a real readability library via the
 * optional-lazy seam in `http.ts`; this module is the always-available fallback
 * so the tool never crashes when no such library is installed. It performs a
 * pragmatic "readability-lite" pass: strip non-content elements (script, style,
 * nav chrome), prefer the main article region when present, unwrap tags, decode
 * the common HTML entities, and collapse runs of whitespace into readable prose.
 */

/** Named/numeric HTML entities we decode. (The long tail is left as-is.) */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
};

/** Decode the common named and numeric (`&#123;` / `&#x1F;`) HTML entities. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? m;
  });
}

/** Extract the document title from `<title>`, decoded and trimmed. */
export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = decodeEntities(m[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 0 ? t : undefined;
}

/** Block-level tags whose boundaries should become line breaks in the text. */
const BLOCK_TAGS =
  /<\/?(?:p|div|section|article|header|footer|main|ul|ol|li|table|tr|h[1-6]|br|hr|blockquote|pre|figure|figcaption|nav|aside)\b[^>]*>/gi;

/** Non-content regions removed wholesale before text extraction. */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ");
}

/**
 * "Readability-lite": if the document has a `<main>` or `<article>` region, use
 * the largest such region as the content root; otherwise fall back to `<body>`,
 * otherwise the whole document.
 */
function selectContentRegion(html: string): string {
  const candidates: string[] = [];
  for (const re of [/<main\b[^>]*>([\s\S]*?)<\/main>/gi, /<article\b[^>]*>([\s\S]*?)<\/article>/gi]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) candidates.push(m[1] ?? "");
  }
  if (candidates.length > 0) {
    return candidates.reduce((a, b) => (b.length > a.length ? b : a));
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return body ? (body[1] ?? "") : html;
}

export interface ExtractedDocument {
  title: string | undefined;
  text: string;
}

/**
 * Extract readable plain text (and the title) from an HTML document. The text is
 * block-aware — paragraph and heading boundaries become newlines — and entity
 * decoded, with runs of blank lines collapsed.
 */
export function extractText(html: string): ExtractedDocument {
  const title = extractTitle(html);
  const region = selectContentRegion(html);
  const withBreaks = stripNonContent(region).replace(BLOCK_TAGS, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(stripped);
  const text = decoded
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

/**
 * Harvest hyperlink targets from `href="…"` attributes and resolve them against
 * `baseUrl`. Fragment-only (`#…`), `javascript:`, `mailto:`, `tel:`, and `data:`
 * links are dropped, as is anything that fails to parse. The fragment is
 * stripped from the resolved URL so `#a` / `#b` don't crawl as distinct pages.
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawHref = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (rawHref.length === 0) continue;
    const lower = rawHref.toLowerCase();
    if (
      lower.startsWith("#") ||
      lower.startsWith("javascript:") ||
      lower.startsWith("mailto:") ||
      lower.startsWith("tel:") ||
      lower.startsWith("data:")
    ) {
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(decodeEntities(rawHref), baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    resolved.hash = "";
    const href = resolved.toString();
    if (!seen.has(href)) {
      seen.add(href);
      out.push(href);
    }
  }
  return out;
}
