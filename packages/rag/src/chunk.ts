/**
 * Chunker (system-spec §16 "chunking"). Splits text/code into overlapping
 * windows, each stamped with its character {@link Span} so a retrieved chunk can
 * cite the exact region of its source. Language-agnostic: `lang` is carried
 * through as metadata, never parsed. The overlap keeps context that straddles a
 * boundary retrievable from either side.
 */

import type { Chunk, ChunkOptions, RagDocument, Span } from "./types.js";

const DEFAULTS = { chunkSize: 800, overlap: 100, respectWordBoundaries: true } as const;

/**
 * Split raw text into overlapping spans. Returns the character ranges only;
 * {@link chunkDocument} wraps these into full {@link Chunk}s. When
 * `respectWordBoundaries`, a window's end is nudged back to the nearest
 * whitespace (as long as it doesn't collapse the window) so tokens aren't cut.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Span[] {
  const chunkSize = options.chunkSize ?? DEFAULTS.chunkSize;
  const respect = options.respectWordBoundaries ?? DEFAULTS.respectWordBoundaries;

  if (chunkSize <= 0) throw new Error(`chunkText: chunkSize must be > 0, got ${chunkSize}`);
  // Clamp overlap into `[0, chunkSize)` so a large default overlap paired with a
  // small chunkSize degrades gracefully instead of throwing.
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULTS.overlap, chunkSize - 1));

  const len = text.length;
  if (len === 0) return [];
  if (len <= chunkSize) return [{ start: 0, end: len }];

  const spans: Span[] = [];
  const stride = chunkSize - overlap; // guaranteed ≥ 1
  let start = 0;

  while (start < len) {
    let end = Math.min(start + chunkSize, len);

    // Backtrack to a clean word boundary when we're mid-document and it doesn't
    // eat more than half the window.
    if (respect && end < len) {
      const ws = lastWhitespace(text, start, end);
      if (ws > start + Math.floor(chunkSize / 2)) end = ws;
    }

    spans.push({ start, end });
    if (end >= len) break;

    // Advance by the stride, but never past the boundary we actually cut at, so
    // overlap is preserved even when the end was backtracked.
    start = Math.max(start + stride, end - overlap);
  }

  return spans;
}

/** Chunk a full document into citeable {@link Chunk}s, propagating provenance. */
export function chunkDocument(doc: RagDocument, options: ChunkOptions = {}): Chunk[] {
  const spans = chunkText(doc.text, options);
  return spans.map((span, index) => {
    const chunk: Chunk = {
      id: `${doc.id}#${index}`,
      docId: doc.id,
      index,
      text: doc.text.slice(span.start, span.end),
      span,
    };
    if (doc.source !== undefined) chunk.source = doc.source;
    if (doc.lang !== undefined) chunk.lang = doc.lang;
    if (doc.meta !== undefined) chunk.meta = doc.meta;
    return chunk;
  });
}

/** Index of the last whitespace char strictly within `(from, to)`, else `to`. */
function lastWhitespace(text: string, from: number, to: number): number {
  for (let i = to - 1; i > from; i--) {
    if (/\s/.test(text[i]!)) return i + 1; // cut just after the whitespace run's char
  }
  return to;
}
