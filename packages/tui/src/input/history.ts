/**
 * Input history ring (design spec §6.7). A bounded, immutable list of submitted
 * prompts with an index walked by `↑/↓` at the buffer edges. The persistent
 * SQLite ring + `Ctrl+R` reverse-search + autosuggest trie land in a later wave;
 * this is the in-memory contract they will back. Pure and testable.
 */

export interface History {
  readonly entries: readonly string[];
  /** -1 = editing a fresh draft (not inside history). */
  readonly index: number;
  /** The draft preserved while walking history (§6.7 "draft preserved"). */
  readonly draft: string;
  readonly max: number;
}

export function createHistory(max = 500, entries: readonly string[] = []): History {
  return { entries: entries.slice(-max), index: -1, draft: "", max };
}

/** Record a submitted entry (dedupes consecutive repeats), resetting navigation. */
export function push(h: History, entry: string): History {
  const trimmed = entry.replace(/\s+$/, "");
  if (trimmed === "") return { ...h, index: -1, draft: "" };
  if (h.entries[h.entries.length - 1] === trimmed) {
    return { ...h, index: -1, draft: "" };
  }
  const entries = [...h.entries, trimmed].slice(-h.max);
  return { ...h, entries, index: -1, draft: "" };
}

/**
 * Walk to the previous (older) entry. `currentDraft` is captured the first time
 * we leave the fresh draft. Returns the history value to show, or `null` at the
 * top (caller keeps the buffer as-is).
 */
export function older(h: History, currentDraft: string): { history: History; value: string } | null {
  if (h.entries.length === 0) return null;
  if (h.index === -1) {
    const idx = h.entries.length - 1;
    return { history: { ...h, index: idx, draft: currentDraft }, value: h.entries[idx] ?? "" };
  }
  if (h.index === 0) return null;
  const idx = h.index - 1;
  return { history: { ...h, index: idx }, value: h.entries[idx] ?? "" };
}

/**
 * Walk to the next (newer) entry. Past the newest entry, restores the preserved
 * draft and exits history (`index = -1`).
 */
export function newer(h: History): { history: History; value: string } | null {
  if (h.index === -1) return null;
  if (h.index >= h.entries.length - 1) {
    return { history: { ...h, index: -1 }, value: h.draft };
  }
  const idx = h.index + 1;
  return { history: { ...h, index: idx }, value: h.entries[idx] ?? "" };
}
